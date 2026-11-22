import crypto from "node:crypto";
import type { RoutingAttempt, SimMode, Task } from "../types/domain";
import { systemClock, type Clock } from "./clock";
import type { DbClient } from "./db";
import { createSeededRng, systemRng, type Rng } from "./rng";
import { createTimerScheduler, type ScheduledHandle, type Scheduler } from "./scheduler";
import {
  getEligibleContributorsForRouting,
  getTaskById,
  listContributors,
  recordRoutingMatch,
  recordRoutingNoMatch,
} from "./state-machine";

export interface RouterWorkerOptions {
  db: DbClient;
  clock?: Clock;
  rng?: Rng;
  scheduler?: Scheduler;
  seed?: number;
}

export interface RouterWorker {
  scheduleAttempt(task: Task, attempt: RoutingAttempt): void;
  cancelForTask(taskId: string): void;
  stopAll(): void;
  activeCount(): number;
}

function logWorkerError(
  db: DbClient,
  taskId: string,
  epoch: number,
  attemptId: string,
  err: unknown,
  nowMs: number
): void {
  const message = err instanceof Error ? err.message : String(err);
  const evtId = `evt-${crypto.randomUUID().slice(0, 8)}`;
  try {
    db.prepare(
      `INSERT INTO event_logs
        (id, task_id, epoch, event_type, actor, summary, payload_json, created_at)
       VALUES (?, ?, ?, 'ROUTING_NO_MATCH', 'system', ?, ?, ?)`
    ).run(
      evtId,
      taskId,
      epoch,
      `Worker error during routing attempt ${attemptId} (epoch #${epoch}): ${message}`,
      JSON.stringify({ attemptId, error: message, recoveredFromError: true }),
      nowMs
    );
  } catch {
    // Prevent secondary logging failure from crashing the server
  }
}

function computeDelayMs(mode: SimMode, rng: Rng): number {
  switch (mode) {
    case "fast":
      return 10 + Math.floor(rng.next() * 40); // 10-49ms
    case "slow":
      return 25_000 + Math.floor(rng.next() * 10_000); // 25-35s (past 20s window)
    case "hang":
      return 0;
    case "no_match":
      return 20 + Math.floor(rng.next() * 40); // 20-59ms
    case "realistic":
    default:
      return 5_000 + Math.floor(rng.next() * 15_000); // 5,000-19,999ms
  }
}

function shouldNeverReturn(mode: SimMode, rng: Rng): boolean {
  if (mode === "hang") return true;
  if (mode === "fast" || mode === "slow" || mode === "no_match") return false;
  // realistic: ~20% of requests hang / never return
  return rng.next() < 0.2;
}

export function createRouterWorker(options: RouterWorkerOptions): RouterWorker {
  const db = options.db;
  const clock: Clock = options.clock ?? systemClock;
  const rng: Rng = options.rng ?? (options.seed !== undefined ? createSeededRng(options.seed) : systemRng);
  const scheduler: Scheduler = options.scheduler ?? createTimerScheduler();

  const handlesByTask = new Map<string, ScheduledHandle>();

  function clearHandle(taskId: string): void {
    const existing = handlesByTask.get(taskId);
    if (existing) {
      existing.cancel();
      handlesByTask.delete(taskId);
    }
  }

  function scheduleAttempt(task: Task, attempt: RoutingAttempt): void {
    clearHandle(task.id);

    const mode: SimMode = attempt.sim_mode;
    if (shouldNeverReturn(mode, rng)) {
      // Intentionally do not schedule completion: attempt stays pending (may never return)
      return;
    }

    const delayMs = computeDelayMs(mode, rng);
    const handle = scheduler.schedule(delayMs, () => {
      handlesByTask.delete(task.id);
      const nowMs = clock.nowMs();
      try {
        const currentTask = getTaskById(db, task.id);
        const currentAttempt = db
          .prepare("SELECT * FROM routing_attempts WHERE id = ?")
          .get(attempt.id) as RoutingAttempt | undefined;

        if (!currentTask || !currentAttempt) {
          return;
        }

        const isCurrentRound =
          currentTask.state === "ROUTING" &&
          currentTask.routing_epoch === attempt.epoch &&
          currentAttempt.epoch === attempt.epoch &&
          currentAttempt.status === "pending";

        if (!isCurrentRound) {
          const areaContributors = listContributors(db).filter((c) =>
            currentTask.area ? c.areas.includes(currentTask.area) : false
          );
          if (areaContributors.length > 0) {
            const idx = Math.floor(rng.next() * areaContributors.length);
            const lateCandidate = areaContributors[idx] ?? areaContributors[0];
            recordRoutingMatch(
              db,
              {
                taskId: currentTask.id,
                attemptId: currentAttempt.id,
                epoch: attempt.epoch,
                contributorId: lateCandidate.id,
              },
              clock
            );
          } else {
            recordRoutingNoMatch(
              db,
              {
                taskId: currentTask.id,
                attemptId: currentAttempt.id,
                epoch: attempt.epoch,
                reason: `Late result in epoch #${attempt.epoch} with no contributors in area "${currentTask.area}"`,
              },
              clock
            );
          }
          return;
        }

        if (mode === "no_match") {
          recordRoutingNoMatch(
            db,
            {
              taskId: currentTask.id,
              attemptId: currentAttempt.id,
              epoch: attempt.epoch,
              reason: `Simulated no-match in epoch #${attempt.epoch}`,
            },
            clock
          );
          return;
        }

        const { eligible } = getEligibleContributorsForRouting(db, currentTask);
        if (eligible.length === 0) {
          recordRoutingNoMatch(
            db,
            {
              taskId: currentTask.id,
              attemptId: currentAttempt.id,
              epoch: attempt.epoch,
              reason: `No eligible contributors available in area "${currentTask.area}" for epoch #${attempt.epoch}`,
            },
            clock
          );
          return;
        }

        // ~15% no-match chance in realistic mode when contributors are eligible
        if (mode === "realistic" && rng.next() < 0.15) {
          recordRoutingNoMatch(
            db,
            {
              taskId: currentTask.id,
              attemptId: currentAttempt.id,
              epoch: attempt.epoch,
              reason: `Routing engine found no match in epoch #${attempt.epoch}`,
            },
            clock
          );
          return;
        }

        const idx = Math.floor(rng.next() * eligible.length);
        const chosen = eligible[idx] ?? eligible[0];

        recordRoutingMatch(
          db,
          {
            taskId: currentTask.id,
            attemptId: currentAttempt.id,
            epoch: attempt.epoch,
            contributorId: chosen.id,
          },
          clock
        );
      } catch (err) {
        logWorkerError(db, task.id, attempt.epoch, attempt.id, err, nowMs);
        try {
          recordRoutingNoMatch(
            db,
            {
              taskId: task.id,
              attemptId: attempt.id,
              epoch: attempt.epoch,
              reason: `Routing attempt failed safely after error: ${err instanceof Error ? err.message : String(err)}`,
            },
            clock
          );
        } catch {
          // Already logged; do not crash server
        }
      }
    });

    handlesByTask.set(task.id, handle);
  }

  function cancelForTask(taskId: string): void {
    clearHandle(taskId);
  }

  function stopAll(): void {
    for (const handle of handlesByTask.values()) {
      handle.cancel();
    }
    handlesByTask.clear();
    scheduler.clearAll();
  }

  function activeCount(): number {
    return handlesByTask.size;
  }

  return {
    scheduleAttempt,
    cancelForTask,
    stopAll,
    activeCount,
  };
}