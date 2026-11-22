import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import type {
  ExpertiseArea,
  SimMode,
  TaskPriority,
  TaskState,
} from "./types/domain";
import { systemClock, type Clock } from "./lib/clock";
import type { DbClient } from "./lib/db";
import type { RouterWorker } from "./lib/router-worker";
import {
  acceptAssignment,
  completeTask,
  ConflictError,
  createTask,
  declineOrFailAssignment,
  getAttemptsForTask,
  getContributorById,
  getEligibleContributorsForRouting,
  getEventsForTask,
  getTaskById,
  interveneOnTask,
  InvalidTransitionError,
  listContributors,
  listTasks,
  recoverTask,
  submitForRouting,
  type InterventionAction,
  type OperatorGuard,
} from "./lib/state-machine";

export interface AppDependencies {
  db: DbClient;
  worker: RouterWorker;
  clock?: Clock;
}

function parseGuard(body: unknown): OperatorGuard | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const expectedState = obj.expectedState;
  const expectedEpoch = obj.expectedEpoch;

  if (
    typeof expectedState !== "string" ||
    typeof expectedEpoch !== "number" ||
    !Number.isInteger(expectedEpoch)
  ) {
    return null;
  }

  return {
    expectedState: expectedState as TaskState,
    expectedEpoch,
  };
}

function enrichTask(db: DbClient, taskId: string, nowMs: number) {
  const task = getTaskById(db, taskId);
  if (!task) return null;

  const assignee = task.assignee_id ? getContributorById(db, task.assignee_id) : null;
  const attempts = getAttemptsForTask(db, task.id);
  const activeAttempt = attempts.find((a) => a.status === "pending") ?? null;
  const routingElapsedMs =
    task.state === "ROUTING" && activeAttempt
      ? Math.max(0, nowMs - activeAttempt.started_at)
      : null;
  const pastUsualWindow =
    routingElapsedMs !== null ? routingElapsedMs >= 20_000 : false;
  const windowWarning = pastUsualWindow
    ? "past the usual response window, may never return"
    : null;

  const { eligible, excluded } = getEligibleContributorsForRouting(db, task);

  return {
    ...task,
    ageMs: Math.max(0, nowMs - task.created_at),
    assignee,
    activeAttempt,
    routingElapsedMs,
    pastUsualWindow,
    windowWarning,
    eligibleContributors: eligible,
    excludedContributors: excluded,
  };
}

export function createApp(deps: AppDependencies) {
  const { db, worker } = deps;
  const clock: Clock = deps.clock ?? systemClock;

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, nowMs: clock.nowMs() });
  });

  app.get("/api/contributors", (_req: Request, res: Response) => {
    const contributors = listContributors(db);
    const tasks = listTasks(db);
    const enriched = contributors.map((c) => {
      const assignedTasks = tasks.filter(
        (t) =>
          t.assignee_id === c.id &&
          (t.state === "ASSIGNED" || t.state === "IN_PROGRESS")
      );
      return {
        ...c,
        activeTaskCount: assignedTasks.length,
        activeTasks: assignedTasks.map((t) => ({
          id: t.id,
          title: t.title,
          state: t.state,
          priority: t.priority,
          area: t.area,
        })),
      };
    });
    res.json({ contributors: enriched });
  });

  app.get("/api/tasks", (_req: Request, res: Response) => {
    const nowMs = clock.nowMs();
    const tasks = listTasks(db)
      .map((t) => enrichTask(db, t.id, nowMs))
      .filter((t): t is NonNullable<ReturnType<typeof enrichTask>> => t !== null);
    const contributors = listContributors(db);
    res.json({ tasks, contributors, nowMs });
  });

  app.get("/api/tasks/:id", (req: Request, res: Response) => {
    const nowMs = clock.nowMs();
    const enriched = enrichTask(db, req.params.id, nowMs);
    if (!enriched) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const attempts = getAttemptsForTask(db, req.params.id);
    const events = getEventsForTask(db, req.params.id);
    res.json({
      task: enriched,
      attempts,
      events,
      nowMs,
    });
  });

  app.post("/api/tasks", (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === "string" ? body.title : "";
      const description = typeof body.description === "string" ? body.description : "";
      const area = body.area as ExpertiseArea;
      const priority = (body.priority as TaskPriority) || "normal";
      const submitNow = Boolean(body.submit);
      const simMode = (body.simMode as SimMode) || "realistic";

      const validAreas: ExpertiseArea[] = [
        "finance",
        "healthcare",
        "data analysis",
        "operations",
      ];
      const validPriorities: TaskPriority[] = ["low", "normal", "high"];

      if (!validAreas.includes(area)) {
        res.status(400).json({ error: "Invalid expertise area" });
        return;
      }
      if (!validPriorities.includes(priority)) {
        res.status(400).json({ error: "Invalid task priority" });
        return;
      }

      let task = createTask(db, { title, description, area, priority }, clock);

      if (submitNow) {
        const routed = submitForRouting(
          db,
          task.id,
          { expectedState: task.state, expectedEpoch: task.routing_epoch },
          { simMode, actor: "operator" },
          clock
        );
        task = routed.task;
        worker.scheduleAttempt(routed.task, routed.attempt);
      }

      const nowMs = clock.nowMs();
      res.status(201).json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/submit", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const simMode = (body.simMode as SimMode) || "realistic";

      const { task, attempt } = submitForRouting(
        db,
        req.params.id,
        guard,
        { simMode, actor: "operator" },
        clock
      );
      worker.scheduleAttempt(task, attempt);

      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempt,
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/intervene", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const actionType = body.actionType as string;
      const note = typeof body.note === "string" ? body.note : undefined;

      let action: InterventionAction;
      if (actionType === "manual_assign") {
        if (typeof body.contributorId !== "string" || !body.contributorId) {
          res.status(400).json({ error: "contributorId is required for manual_assign" });
          return;
        }
        action = { type: "manual_assign", contributorId: body.contributorId, note };
      } else if (actionType === "reroute") {
        action = {
          type: "reroute",
          simMode: (body.simMode as SimMode) || "realistic",
          note,
        };
      } else if (actionType === "return_to_draft") {
        action = { type: "return_to_draft", note };
      } else if (actionType === "mark_unresolved") {
        action = { type: "mark_unresolved", note };
      } else {
        res.status(400).json({ error: "Unsupported actionType" });
        return;
      }

      // Intentionally do NOT cancel outstanding simulated timers so late results
      // still fire and exercise the epoch fence (`STALE_ROUTING_IGNORED`).
      const task = interveneOnTask(db, req.params.id, action, guard, clock);

      if (task.state === "ROUTING") {
        const latestAttempt = getAttemptsForTask(db, task.id).find(
          (a) => a.epoch === task.routing_epoch && a.status === "pending"
        );
        if (latestAttempt) {
          worker.scheduleAttempt(task, latestAttempt);
        }
      }

      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/recover", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const mode = body.mode as string;

      let recovery:
        | { mode: "reroute"; simMode?: SimMode }
        | { mode: "manual_assign"; contributorId: string };

      if (mode === "manual_assign") {
        if (typeof body.contributorId !== "string" || !body.contributorId) {
          res.status(400).json({ error: "contributorId is required for manual_assign" });
          return;
        }
        recovery = { mode: "manual_assign", contributorId: body.contributorId };
      } else if (mode === "reroute") {
        recovery = { mode: "reroute", simMode: (body.simMode as SimMode) || "realistic" };
      } else {
        res.status(400).json({ error: "mode must be 'reroute' or 'manual_assign'" });
        return;
      }

      // Intentionally do NOT cancel outstanding simulated timers so late results
      // still fire and exercise the epoch fence (`STALE_ROUTING_IGNORED`).
      const task = recoverTask(db, req.params.id, recovery, guard, clock);

      if (task.state === "ROUTING") {
        const latestAttempt = getAttemptsForTask(db, task.id).find(
          (a) => a.epoch === task.routing_epoch && a.status === "pending"
        );
        if (latestAttempt) {
          worker.scheduleAttempt(task, latestAttempt);
        }
      }

      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/accept", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const task = acceptAssignment(db, req.params.id, guard, clock);
      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/decline", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      const task = declineOrFailAssignment(db, req.params.id, "declined", guard, detail, clock);
      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/fail", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      const task = declineOrFailAssignment(db, req.params.id, "failed", guard, detail, clock);
      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/complete", (req: Request, res: Response, next: NextFunction) => {
    try {
      const guard = parseGuard(req.body);
      if (!guard) {
        res.status(400).json({ error: "expectedState and expectedEpoch are required" });
        return;
      }
      const task = completeTask(db, req.params.id, guard, clock);
      const nowMs = clock.nowMs();
      res.json({
        task: enrichTask(db, task.id, nowMs),
        attempts: getAttemptsForTask(db, task.id),
        events: getEventsForTask(db, task.id),
      });
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ConflictError) {
      res.status(409).json({
        error: "This task just changed, please review",
        code: err.code,
        currentState: err.currentState,
        currentEpoch: err.currentEpoch,
      });
      return;
    }
    if (err instanceof InvalidTransitionError) {
      res.status(400).json({
        error: err.message,
        code: err.code,
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  });

  return app;
}