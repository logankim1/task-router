import crypto from "node:crypto";
import type {
  ActorType,
  Contributor,
  EventLog,
  EventType,
  ExpertiseArea,
  RoutingAttempt,
  SimMode,
  Task,
  TaskPriority,
  TaskState,
} from "../types/domain";
import { FakeClock, systemClock, type Clock } from "./clock";
import type { DbClient } from "./db";

export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
  readonly currentState: TaskState;
  readonly currentEpoch: number;

  constructor(message: string, currentState: TaskState, currentEpoch: number) {
    super(message);
    this.name = "ConflictError";
    this.currentState = currentState;
    this.currentEpoch = currentEpoch;
  }
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export interface OperatorGuard {
  expectedState: TaskState;
  expectedEpoch: number;
}

export interface ExcludedContributorRecord {
  contributorId: string;
  contributorName: string;
  reason: "declined" | "failed";
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function mapContributorRow(row: {
  id: string;
  name: string;
  areas_json: string;
}): Contributor {
  return {
    id: row.id,
    name: row.name,
    areas: JSON.parse(row.areas_json) as ExpertiseArea[],
  };
}

export function getTaskById(db: DbClient, taskId: string): Task | null {
  const row = db
    .prepare(
      `SELECT id, title, description, area, priority, state, assignee_id, routing_epoch, created_at, updated_at
       FROM tasks WHERE id = ?`
    )
    .get(taskId) as Task | undefined;
  return row ?? null;
}

export function listTasks(db: DbClient): Task[] {
  return db
    .prepare(
      `SELECT id, title, description, area, priority, state, assignee_id, routing_epoch, created_at, updated_at
       FROM tasks ORDER BY created_at DESC, id ASC`
    )
    .all() as Task[];
}

export function listContributors(db: DbClient): Contributor[] {
  const rows = db
    .prepare("SELECT id, name, areas_json FROM contributors ORDER BY name ASC")
    .all() as Array<{ id: string; name: string; areas_json: string }>;
  return rows.map(mapContributorRow);
}

export function getContributorById(
  db: DbClient,
  contributorId: string
): Contributor | null {
  const row = db
    .prepare("SELECT id, name, areas_json FROM contributors WHERE id = ?")
    .get(contributorId) as { id: string; name: string; areas_json: string } | undefined;
  return row ? mapContributorRow(row) : null;
}

export function getAttemptsForTask(
  db: DbClient,
  taskId: string
): RoutingAttempt[] {
  return db
    .prepare(
      `SELECT id, task_id, epoch, status, candidate_contributor_id, late_candidate_contributor_id, late_arrived_at, sim_mode, started_at, completed_at
       FROM routing_attempts WHERE task_id = ? ORDER BY epoch ASC, started_at ASC`
    )
    .all(taskId) as RoutingAttempt[];
}

export function getEventsForTask(db: DbClient, taskId: string): EventLog[] {
  return db
    .prepare(
      `SELECT seq, id, task_id, epoch, event_type, actor, summary, payload_json, created_at
       FROM event_logs WHERE task_id = ? ORDER BY seq ASC`
    )
    .all(taskId) as EventLog[];
}

export function getExcludedContributorsForTask(
  db: DbClient,
  taskId: string
): ExcludedContributorRecord[] {
  const rows = db
    .prepare(
      `SELECT event_type, payload_json
       FROM event_logs
       WHERE task_id = ? AND event_type IN ('ASSIGNMENT_DECLINED', 'ASSIGNMENT_FAILED')
       ORDER BY seq ASC`
    )
    .all(taskId) as Array<{
    event_type: "ASSIGNMENT_DECLINED" | "ASSIGNMENT_FAILED";
    payload_json: string | null;
  }>;

  const byId = new Map<string, ExcludedContributorRecord>();
  for (const row of rows) {
    if (!row.payload_json) continue;
    try {
      const parsed = JSON.parse(row.payload_json) as {
        contributorId?: string;
        reasonKind?: "declined" | "failed";
      };
      if (!parsed.contributorId) continue;
      const contrib = getContributorById(db, parsed.contributorId);
      const reason: "declined" | "failed" =
        parsed.reasonKind ??
        (row.event_type === "ASSIGNMENT_DECLINED" ? "declined" : "failed");
      byId.set(parsed.contributorId, {
        contributorId: parsed.contributorId,
        contributorName: contrib?.name ?? parsed.contributorId,
        reason,
      });
    } catch {
      // Ignore malformed payload rows
    }
  }

  return Array.from(byId.values());
}

export function getEligibleContributorsForRouting(
  db: DbClient,
  task: Task
): {
  eligible: Contributor[];
  excluded: ExcludedContributorRecord[];
} {
  const all = listContributors(db);
  const areaMatches = all.filter((c) => c.areas.includes(task.area));
  const excludedRecords = getExcludedContributorsForTask(db, task.id);
  const excludedIds = new Set(excludedRecords.map((e) => e.contributorId));

  const eligible = areaMatches.filter((c) => !excludedIds.has(c.id));
  const excludedInArea = excludedRecords.filter((e) =>
    areaMatches.some((c) => c.id === e.contributorId)
  );

  return { eligible, excluded: excludedInArea };
}

function appendEvent(
  db: DbClient,
  params: {
    taskId: string;
    epoch: number | null;
    eventType: EventType;
    actor: ActorType;
    summary: string;
    payload?: Record<string, unknown> | null;
    createdAt: number;
    id?: string;
  }
): void {
  db.prepare(
    `INSERT INTO event_logs
      (id, task_id, epoch, event_type, actor, summary, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id ?? newId("evt"),
    params.taskId,
    params.epoch,
    params.eventType,
    params.actor,
    params.summary,
    params.payload ? JSON.stringify(params.payload) : null,
    params.createdAt
  );
}

function assertGuard(task: Task, guard: OperatorGuard): void {
  if (task.state !== guard.expectedState || task.routing_epoch !== guard.expectedEpoch) {
    throw new ConflictError(
      "This task just changed, please review",
      task.state,
      task.routing_epoch
    );
  }
}

function assertAllowedState(
  task: Task,
  allowed: TaskState[],
  actionName: string
): void {
  if (!allowed.includes(task.state)) {
    throw new InvalidTransitionError(
      `Cannot ${actionName} when task is in state ${task.state}`
    );
  }
}

function formatContributorLabel(db: DbClient, contributorId: string | null): string {
  if (!contributorId) return "unassigned";
  const c = getContributorById(db, contributorId);
  return c ? `${c.name} (${c.id})` : contributorId;
}

function beginRoutingRound(
  db: DbClient,
  params: {
    task: Task;
    simMode: SimMode;
    actor: ActorType;
    eventType: EventType;
    eventPrefix?: string;
    now: number;
    attemptId?: string;
  }
): { task: Task; attempt: RoutingAttempt } {
  const { task, simMode, actor, eventType, now } = params;
  const nextEpoch = task.routing_epoch + 1;
  const attemptId = params.attemptId ?? newId("att");

  db.prepare(
    `UPDATE routing_attempts
     SET status = 'cancelled', completed_at = ?
     WHERE task_id = ? AND status = 'pending'`
  ).run(now, task.id);

  db.prepare(
    `UPDATE tasks
     SET state = 'ROUTING', assignee_id = NULL, routing_epoch = ?, updated_at = ?
     WHERE id = ?`
  ).run(nextEpoch, now, task.id);

  db.prepare(
    `INSERT INTO routing_attempts
      (id, task_id, epoch, status, candidate_contributor_id, late_candidate_contributor_id, late_arrived_at, sim_mode, started_at, completed_at)
     VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, NULL)`
  ).run(attemptId, task.id, nextEpoch, simMode, now);

  const { excluded: excludedAreaRecords } = getEligibleContributorsForRouting(db, task);
  const exclusionNote =
    excludedAreaRecords.length > 0
      ? ` (excluded: ${excludedAreaRecords
          .map((e) => `${e.contributorName} (${e.contributorId}), ${e.reason}`)
          .join("; ")})`
      : "";

  const baseSummary =
    params.eventPrefix ??
    `Started routing round #${nextEpoch} (mode: ${simMode})`;

  appendEvent(db, {
    taskId: task.id,
    epoch: nextEpoch,
    eventType,
    actor,
    summary: `${baseSummary}${exclusionNote}`,
    payload: {
      attemptId,
      simMode,
      excludedContributors: excludedAreaRecords,
    },
    createdAt: now,
  });

  return {
    task: getTaskById(db, task.id)!,
    attempt: db
      .prepare("SELECT * FROM routing_attempts WHERE id = ?")
      .get(attemptId) as RoutingAttempt,
  };
}

function applyManualAssignment(
  db: DbClient,
  params: {
    task: Task;
    contributorId: string;
    actor: ActorType;
    eventType: EventType;
    now: number;
    note?: string;
    isRecovery?: boolean;
  }
): Task {
  const { task, contributorId, actor, eventType, now } = params;
  const contributor = getContributorById(db, contributorId);
  if (!contributor) {
    throw new InvalidTransitionError(`Contributor ${contributorId} not found`);
  }

  const hasExpertise = contributor.areas.includes(task.area);
  const outOfExpertiseTag = hasExpertise ? "" : " — assigned outside expertise";
  const prevAssigneeId = task.assignee_id;
  const hadAssignee = prevAssigneeId !== null;
  const prevLabel = formatContributorLabel(db, prevAssigneeId);
  const nextLabel = `${contributor.name} (${contributor.id})`;

  const nextEpoch = task.routing_epoch + 1;

  db.prepare(
    `UPDATE routing_attempts
     SET status = 'cancelled', completed_at = ?
     WHERE task_id = ? AND status = 'pending'`
  ).run(now, task.id);

  db.prepare(
    `UPDATE tasks
     SET state = 'ASSIGNED', assignee_id = ?, routing_epoch = ?, updated_at = ?
     WHERE id = ?`
  ).run(contributor.id, nextEpoch, now, task.id);

  let actionSummary: string;
  if (params.isRecovery) {
    actionSummary = `Recovered task by assigning ${nextLabel} in epoch #${nextEpoch}${outOfExpertiseTag}`;
  } else if (hadAssignee) {
    actionSummary = `Reassigned task from ${prevLabel} to ${nextLabel} (epoch #${nextEpoch})${outOfExpertiseTag}`;
  } else {
    actionSummary = `Manually assigned to ${nextLabel} (epoch #${nextEpoch})${outOfExpertiseTag}`;
  }

  const summary = params.note ? `${actionSummary} — ${params.note}` : actionSummary;

  appendEvent(db, {
    taskId: task.id,
    epoch: nextEpoch,
    eventType,
    actor,
    summary,
    payload: {
      previousAssigneeId: prevAssigneeId,
      newAssigneeId: contributor.id,
      assignedOutsideExpertise: !hasExpertise,
      taskArea: task.area,
      contributorAreas: contributor.areas,
    },
    createdAt: now,
  });

  return getTaskById(db, task.id)!;
}

export function createTask(
  db: DbClient,
  input: {
    id?: string;
    title: string;
    description: string;
    area: ExpertiseArea;
    priority: TaskPriority;
  },
  clock: Clock = systemClock
): Task {
  const now = clock.nowMs();
  const taskId = input.id ?? newId("task");
  const title = input.title.trim();
  if (!title) {
    throw new InvalidTransitionError("Task title is required");
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks
        (id, title, description, area, priority, state, assignee_id, routing_epoch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', NULL, 0, ?, ?)`
    ).run(
      taskId,
      title,
      input.description.trim(),
      input.area,
      input.priority,
      now,
      now
    );

    appendEvent(db, {
      taskId,
      epoch: 0,
      eventType: "TASK_CREATED",
      actor: "operator",
      summary: `Created ${input.priority} priority ${input.area} task "${title}" in DRAFT`,
      payload: { area: input.area, priority: input.priority },
      createdAt: now,
    });
  });

  tx();
  return getTaskById(db, taskId)!;
}

export function submitForRouting(
  db: DbClient,
  taskId: string,
  guard: OperatorGuard,
  options: {
    simMode?: SimMode;
    attemptId?: string;
    actor?: ActorType;
  } = {},
  clock: Clock = systemClock
): { task: Task; attempt: RoutingAttempt } {
  const now = clock.nowMs();
  const simMode = options.simMode ?? "realistic";
  const actor = options.actor ?? "operator";

  return db.transaction(() => {
    const task = getTaskById(db, taskId);
    if (!task) throw new InvalidTransitionError(`Task ${taskId} not found`);

    assertGuard(task, guard);
    assertAllowedState(
      task,
      ["DRAFT", "UNRESOLVED", "RECOVERY_NEEDED", "ROUTING"],
      "submit for routing"
    );

    return beginRoutingRound(db, {
      task,
      simMode,
      actor,
      eventType: "ROUTING_STARTED",
      now,
      attemptId: options.attemptId,
    });
  })();
}

export function recordRoutingMatch(
  db: DbClient,
  params: {
    taskId: string;
    attemptId: string;
    epoch: number;
    contributorId: string;
  },
  clock: Clock = systemClock
): { outcome: "matched" | "stale_ignored"; task: Task; attempt: RoutingAttempt } {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, params.taskId);
    const attempt = db
      .prepare("SELECT * FROM routing_attempts WHERE id = ?")
      .get(params.attemptId) as RoutingAttempt | undefined;

    if (!task || !attempt) {
      throw new InvalidTransitionError("Task or routing attempt not found");
    }

    const contributor = getContributorById(db, params.contributorId);
    if (!contributor) {
      throw new InvalidTransitionError(`Contributor ${params.contributorId} not found`);
    }

    const isCurrent =
      task.state === "ROUTING" &&
      task.routing_epoch === params.epoch &&
      attempt.epoch === params.epoch &&
      attempt.status === "pending";

    if (!isCurrent) {
      if (attempt.status === "pending") {
        db.prepare(
          `UPDATE routing_attempts
           SET status = 'stale_ignored', candidate_contributor_id = ?, completed_at = ?
           WHERE id = ?`
        ).run(contributor.id, now, attempt.id);
      } else if (attempt.status === "cancelled") {
        // Keep status = 'cancelled' so operator cancellation remains honest, and record the late answer
        db.prepare(
          `UPDATE routing_attempts
           SET late_candidate_contributor_id = ?, late_arrived_at = ?
           WHERE id = ?`
        ).run(contributor.id, now, attempt.id);
      }

      const summary =
        attempt.status === "cancelled"
          ? `Attempt ${attempt.id} (epoch #${attempt.epoch}) remained cancelled; late match for ${contributor.name} (${contributor.id}) arrived at ${now} and was ignored (task is ${task.state} at epoch #${task.routing_epoch})`
          : `Ignored late match for ${contributor.name} (${contributor.id}) from epoch #${attempt.epoch} (task is ${task.state} at epoch #${task.routing_epoch})`;

      appendEvent(db, {
        taskId: task.id,
        epoch: attempt.epoch,
        eventType: "STALE_ROUTING_IGNORED",
        actor: "system",
        summary,
        payload: {
          attemptId: attempt.id,
          attemptStatusBefore: attempt.status,
          lateCandidateContributorId: contributor.id,
          lateArrivedAt: now,
          taskState: task.state,
          currentEpoch: task.routing_epoch,
        },
        createdAt: now,
      });

      return {
        outcome: "stale_ignored" as const,
        task: getTaskById(db, task.id)!,
        attempt: db
          .prepare("SELECT * FROM routing_attempts WHERE id = ?")
          .get(attempt.id) as RoutingAttempt,
      };
    }

    const excludedIds = new Set(
      getExcludedContributorsForTask(db, task.id).map((e) => e.contributorId)
    );
    if (excludedIds.has(contributor.id)) {
      throw new InvalidTransitionError(
        `Contributor ${contributor.name} (${contributor.id}) was previously excluded from task ${task.id}`
      );
    }

    if (!contributor.areas.includes(task.area)) {
      throw new InvalidTransitionError(
        `Contributor ${contributor.name} (${contributor.id}) lacks required expertise "${task.area}"`
      );
    }

    db.prepare(
      `UPDATE routing_attempts
       SET status = 'matched', candidate_contributor_id = ?, completed_at = ?
       WHERE id = ?`
    ).run(contributor.id, now, attempt.id);

    db.prepare(
      `UPDATE tasks
       SET state = 'ASSIGNED', assignee_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(contributor.id, now, task.id);

    appendEvent(db, {
      taskId: task.id,
      epoch: attempt.epoch,
      eventType: "ROUTING_MATCHED",
      actor: "system",
      summary: `Matched ${contributor.name} (${contributor.id}) in epoch #${attempt.epoch}; awaiting acceptance`,
      payload: { attemptId: attempt.id, contributorId: contributor.id },
      createdAt: now,
    });

    return {
      outcome: "matched" as const,
      task: getTaskById(db, task.id)!,
      attempt: db
        .prepare("SELECT * FROM routing_attempts WHERE id = ?")
        .get(attempt.id) as RoutingAttempt,
    };
  })();
}

export function recordRoutingNoMatch(
  db: DbClient,
  params: {
    taskId: string;
    attemptId: string;
    epoch: number;
    reason?: string;
  },
  clock: Clock = systemClock
): { outcome: "no_match" | "stale_ignored"; task: Task; attempt: RoutingAttempt } {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, params.taskId);
    const attempt = db
      .prepare("SELECT * FROM routing_attempts WHERE id = ?")
      .get(params.attemptId) as RoutingAttempt | undefined;

    if (!task || !attempt) {
      throw new InvalidTransitionError("Task or routing attempt not found");
    }

    const isCurrent =
      task.state === "ROUTING" &&
      task.routing_epoch === params.epoch &&
      attempt.epoch === params.epoch &&
      attempt.status === "pending";

    if (!isCurrent) {
      if (attempt.status === "pending") {
        db.prepare(
          `UPDATE routing_attempts
           SET status = 'stale_ignored', completed_at = ?
           WHERE id = ?`
        ).run(now, attempt.id);
      } else if (attempt.status === "cancelled") {
        // Keep status = 'cancelled' so operator cancellation remains honest, and record late arrival timestamp
        db.prepare(
          `UPDATE routing_attempts
           SET late_arrived_at = ?
           WHERE id = ?`
        ).run(now, attempt.id);
      }

      const summary =
        attempt.status === "cancelled"
          ? `Attempt ${attempt.id} (epoch #${attempt.epoch}) remained cancelled; late no-match arrived at ${now} and was ignored (task is ${task.state} at epoch #${task.routing_epoch})`
          : `Ignored late no-match from epoch #${attempt.epoch} (task is ${task.state} at epoch #${task.routing_epoch})`;

      appendEvent(db, {
        taskId: task.id,
        epoch: attempt.epoch,
        eventType: "STALE_ROUTING_IGNORED",
        actor: "system",
        summary,
        payload: {
          attemptId: attempt.id,
          attemptStatusBefore: attempt.status,
          lateArrivedAt: now,
          taskState: task.state,
          currentEpoch: task.routing_epoch,
        },
        createdAt: now,
      });

      return {
        outcome: "stale_ignored" as const,
        task: getTaskById(db, task.id)!,
        attempt: db
          .prepare("SELECT * FROM routing_attempts WHERE id = ?")
          .get(attempt.id) as RoutingAttempt,
      };
    }

    db.prepare(
      `UPDATE routing_attempts
       SET status = 'no_match', completed_at = ?
       WHERE id = ?`
    ).run(now, attempt.id);

    db.prepare(
      `UPDATE tasks
       SET state = 'UNRESOLVED', assignee_id = NULL, updated_at = ?
       WHERE id = ?`
    ).run(now, task.id);

    appendEvent(db, {
      taskId: task.id,
      epoch: attempt.epoch,
      eventType: "ROUTING_NO_MATCH",
      actor: "system",
      summary:
        params.reason ??
        `No eligible contributor found in epoch #${attempt.epoch}; marked UNRESOLVED`,
      payload: { attemptId: attempt.id },
      createdAt: now,
    });

    return {
      outcome: "no_match" as const,
      task: getTaskById(db, task.id)!,
      attempt: db
        .prepare("SELECT * FROM routing_attempts WHERE id = ?")
        .get(attempt.id) as RoutingAttempt,
    };
  })();
}

export function acceptAssignment(
  db: DbClient,
  taskId: string,
  guard: OperatorGuard,
  clock: Clock = systemClock
): Task {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, taskId);
    if (!task) throw new InvalidTransitionError(`Task ${taskId} not found`);

    assertGuard(task, guard);
    assertAllowedState(task, ["ASSIGNED"], "accept assignment");
    if (!task.assignee_id) {
      throw new InvalidTransitionError("Cannot accept assignment without an assignee");
    }

    const contributor = getContributorById(db, task.assignee_id);
    db.prepare(
      `UPDATE tasks SET state = 'IN_PROGRESS', updated_at = ? WHERE id = ?`
    ).run(now, taskId);

    appendEvent(db, {
      taskId,
      epoch: task.routing_epoch,
      eventType: "ASSIGNMENT_ACCEPTED",
      actor: "contributor",
      summary: `${contributor?.name ?? task.assignee_id} accepted assignment; routing complete and work in progress`,
      payload: { contributorId: task.assignee_id },
      createdAt: now,
    });

    return getTaskById(db, taskId)!;
  })();
}

export function declineOrFailAssignment(
  db: DbClient,
  taskId: string,
  reasonKind: "declined" | "failed",
  guard: OperatorGuard,
  detail?: string,
  clock: Clock = systemClock
): Task {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, taskId);
    if (!task) throw new InvalidTransitionError(`Task ${taskId} not found`);

    assertGuard(task, guard);
    assertAllowedState(task, ["ASSIGNED"], `${reasonKind} assignment`);

    const prevAssigneeId = task.assignee_id;
    const contributor = prevAssigneeId ? getContributorById(db, prevAssigneeId) : null;

    db.prepare(
      `UPDATE tasks
       SET state = 'RECOVERY_NEEDED', assignee_id = NULL, updated_at = ?
       WHERE id = ?`
    ).run(now, taskId);

    const eventType: EventType =
      reasonKind === "declined" ? "ASSIGNMENT_DECLINED" : "ASSIGNMENT_FAILED";

    appendEvent(db, {
      taskId,
      epoch: task.routing_epoch,
      eventType,
      actor: "contributor",
      summary:
        detail ??
        (reasonKind === "declined"
          ? `${contributor?.name ?? prevAssigneeId ?? "Assignee"} declined assignment before work began`
          : `Assignment to ${contributor?.name ?? prevAssigneeId ?? "Assignee"} failed before work began`),
      payload: { contributorId: prevAssigneeId, reasonKind },
      createdAt: now,
    });

    return getTaskById(db, taskId)!;
  })();
}

export type InterventionAction =
  | { type: "manual_assign"; contributorId: string; note?: string }
  | { type: "reroute"; simMode?: SimMode; note?: string }
  | { type: "return_to_draft"; note?: string }
  | { type: "mark_unresolved"; note?: string };

export function interveneOnTask(
  db: DbClient,
  taskId: string,
  action: InterventionAction,
  guard: OperatorGuard,
  clock: Clock = systemClock
): Task {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, taskId);
    if (!task) throw new InvalidTransitionError(`Task ${taskId} not found`);

    assertGuard(task, guard);
    assertAllowedState(
      task,
      ["DRAFT", "ROUTING", "ASSIGNED", "IN_PROGRESS", "UNRESOLVED", "RECOVERY_NEEDED"],
      `intervene (${action.type})`
    );

    if (action.type === "return_to_draft") {
      if (task.state === "DRAFT") {
        throw new InvalidTransitionError("Task is already in DRAFT");
      }
      const nextEpoch = task.routing_epoch + 1;
      const prevAssignee = task.assignee_id;

      db.prepare(
        `UPDATE routing_attempts
         SET status = 'cancelled', completed_at = ?
         WHERE task_id = ? AND status = 'pending'`
      ).run(now, taskId);

      db.prepare(
        `UPDATE tasks
         SET state = 'DRAFT', assignee_id = NULL, routing_epoch = ?, updated_at = ?
         WHERE id = ?`
      ).run(nextEpoch, now, taskId);

      const fromClause = prevAssignee
        ? ` (unassigned from ${formatContributorLabel(db, prevAssignee)})`
        : "";
      appendEvent(db, {
        taskId,
        epoch: nextEpoch,
        eventType: "OPERATOR_INTERVENED",
        actor: "operator",
        summary:
          action.note ??
          `Operator returned task to DRAFT${fromClause} (epoch #${nextEpoch})`,
        payload: { action: action.type, previousAssigneeId: prevAssignee },
        createdAt: now,
      });

      return getTaskById(db, taskId)!;
    }

    if (action.type === "mark_unresolved") {
      if (task.state === "UNRESOLVED") {
        throw new InvalidTransitionError("Task is already UNRESOLVED");
      }
      const nextEpoch = task.routing_epoch + 1;
      const prevAssignee = task.assignee_id;

      db.prepare(
        `UPDATE routing_attempts
         SET status = 'cancelled', completed_at = ?
         WHERE task_id = ? AND status = 'pending'`
      ).run(now, taskId);

      db.prepare(
        `UPDATE tasks
         SET state = 'UNRESOLVED', assignee_id = NULL, routing_epoch = ?, updated_at = ?
         WHERE id = ?`
      ).run(nextEpoch, now, taskId);

      const fromClause = prevAssignee
        ? ` (unassigned from ${formatContributorLabel(db, prevAssignee)})`
        : "";
      appendEvent(db, {
        taskId,
        epoch: nextEpoch,
        eventType: "OPERATOR_INTERVENED",
        actor: "operator",
        summary:
          action.note ??
          `Operator marked task UNRESOLVED${fromClause} (epoch #${nextEpoch})`,
        payload: { action: action.type, previousAssigneeId: prevAssignee },
        createdAt: now,
      });

      return getTaskById(db, taskId)!;
    }

    if (action.type === "manual_assign") {
      return applyManualAssignment(db, {
        task,
        contributorId: action.contributorId,
        actor: "operator",
        eventType: "OPERATOR_INTERVENED",
        now,
        note: action.note,
      });
    }

    const simMode = action.simMode ?? "realistic";
    return beginRoutingRound(db, {
      task,
      simMode,
      actor: "operator",
      eventType: "OPERATOR_INTERVENED",
      eventPrefix: action.note
        ? `Operator intervened and started routing round #${task.routing_epoch + 1} (mode: ${simMode}) — ${action.note}`
        : `Operator intervened and started routing round #${task.routing_epoch + 1} (mode: ${simMode})`,
      now,
    }).task;
  })();
}

export function recoverTask(
  db: DbClient,
  taskId: string,
  recovery:
    | { mode: "reroute"; simMode?: SimMode }
    | { mode: "manual_assign"; contributorId: string },
  guard: OperatorGuard,
  clock: Clock = systemClock
): Task {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, taskId);
    if (!task) throw new InvalidTransitionError(`Task ${taskId} not found`);

    assertGuard(task, guard);
    assertAllowedState(task, ["RECOVERY_NEEDED", "UNRESOLVED"], "recover task");

    if (recovery.mode === "manual_assign") {
      return applyManualAssignment(db, {
        task,
        contributorId: recovery.contributorId,
        actor: "operator",
        eventType: "TASK_RECOVERED",
        now,
        isRecovery: true,
      });
    }

    const simMode = recovery.simMode ?? "realistic";
    return beginRoutingRound(db, {
      task,
      simMode,
      actor: "operator",
      eventType: "TASK_RECOVERED",
      eventPrefix: `Recovered task by re-routing in epoch #${task.routing_epoch + 1} (mode: ${simMode})`,
      now,
    }).task;
  })();
}

export function completeTask(
  db: DbClient,
  taskId: string,
  guard: OperatorGuard,
  clock: Clock = systemClock
): Task {
  const now = clock.nowMs();

  return db.transaction(() => {
    const task = getTaskById(db, taskId);
    if (!task) throw new InvalidTransitionError(`Task ${taskId} not found`);

    assertGuard(task, guard);
    if (task.state === "COMPLETED") {
      throw new InvalidTransitionError("Task is already COMPLETED");
    }
    assertAllowedState(task, ["IN_PROGRESS"], "complete task");

    db.prepare(
      `UPDATE tasks SET state = 'COMPLETED', updated_at = ? WHERE id = ?`
    ).run(now, taskId);

    appendEvent(db, {
      taskId,
      epoch: task.routing_epoch,
      eventType: "TASK_COMPLETED",
      actor: "operator",
      summary: "Marked task as COMPLETED",
      createdAt: now,
    });

    return getTaskById(db, taskId)!;
  })();
}

export function sweepInterruptedAttemptsOnStartup(
  db: DbClient,
  clock: Clock = systemClock
): number {
  const now = clock.nowMs();

  return db.transaction(() => {
    const pendingAttempts = db
      .prepare("SELECT * FROM routing_attempts WHERE status = 'pending'")
      .all() as RoutingAttempt[];

    for (const attempt of pendingAttempts) {
      db.prepare(
        `UPDATE routing_attempts
         SET status = 'interrupted_by_restart', completed_at = ?
         WHERE id = ?`
      ).run(now, attempt.id);

      const task = getTaskById(db, attempt.task_id);
      let movedToUnresolved = false;

      if (task && task.state === "ROUTING" && task.routing_epoch === attempt.epoch) {
        db.prepare(
          `UPDATE tasks
           SET state = 'UNRESOLVED', assignee_id = NULL, updated_at = ?
           WHERE id = ?`
        ).run(now, task.id);
        movedToUnresolved = true;
      }

      const summary = movedToUnresolved
        ? `Pending routing attempt ${attempt.id} (epoch #${attempt.epoch}) interrupted by restart; moved task from ROUTING to UNRESOLVED`
        : `Pending routing attempt ${attempt.id} (epoch #${attempt.epoch}) interrupted by restart; task remained ${task?.state ?? "unknown"} at epoch #${task?.routing_epoch ?? attempt.epoch}`;

      appendEvent(db, {
        taskId: attempt.task_id,
        epoch: attempt.epoch,
        eventType: "INTERRUPTED_BY_RESTART",
        actor: "system",
        summary,
        payload: {
          attemptId: attempt.id,
          movedToUnresolved,
          taskStateAfter: movedToUnresolved ? "UNRESOLVED" : task?.state ?? null,
        },
        createdAt: now,
      });
    }

    return pendingAttempts.length;
  })();
}

export function seedInitialTasks(
  db: DbClient,
  referenceNowMs: number = Date.now()
): void {
  const existingCount = (
    db.prepare("SELECT COUNT(*) AS cnt FROM tasks").get() as { cnt: number }
  ).cnt;
  if (existingCount > 0) return;

  db.transaction(() => {
    // 1. DRAFT task (~2 minutes old)
    const clock1 = new FakeClock(referenceNowMs - 120_000);
    createTask(
      db,
      {
        id: "t-1",
        title: "Q4 Vendor Spend Audit",
        description: "Reconcile top 25 vendor invoices against PO commitments.",
        area: "finance",
        priority: "high",
      },
      clock1
    );

    // 2. ASSIGNED task (~5 minutes old, matched 90s ago)
    const clock2 = new FakeClock(referenceNowMs - 300_000);
    createTask(
      db,
      {
        id: "t-2",
        title: "Patient Intake Funnel Latency",
        description: "Analyze drop-offs across clinic intake steps over the last 30 days.",
        area: "data analysis",
        priority: "normal",
      },
      clock2
    );
    clock2.advanceMs(120_000);
    const t2Draft = getTaskById(db, "t-2")!;
    const r2 = submitForRouting(
      db,
      "t-2",
      { expectedState: t2Draft.state, expectedEpoch: t2Draft.routing_epoch },
      { simMode: "fast", attemptId: "att-seed-2", actor: "operator" },
      clock2
    );
    clock2.advanceMs(90_000);
    recordRoutingMatch(
      db,
      {
        taskId: "t-2",
        attemptId: r2.attempt.id,
        epoch: r2.attempt.epoch,
        contributorId: "c-2",
      },
      clock2
    );

    // 3. RECOVERY_NEEDED task (~10 minutes old, matched then declined 45s ago)
    const clock3 = new FakeClock(referenceNowMs - 600_000);
    createTask(
      db,
      {
        id: "t-3",
        title: "Telehealth Triage Escalation Runbook",
        description: "Verify after-hours escalation thresholds for triage nurses.",
        area: "healthcare",
        priority: "high",
      },
      clock3
    );
    clock3.advanceMs(240_000);
    const t3Draft = getTaskById(db, "t-3")!;
    const r3 = submitForRouting(
      db,
      "t-3",
      { expectedState: t3Draft.state, expectedEpoch: t3Draft.routing_epoch },
      { simMode: "fast", attemptId: "att-seed-3", actor: "operator" },
      clock3
    );
    clock3.advanceMs(315_000);
    recordRoutingMatch(
      db,
      {
        taskId: "t-3",
        attemptId: r3.attempt.id,
        epoch: r3.attempt.epoch,
        contributorId: "c-3",
      },
      clock3
    );
    clock3.advanceMs(45_000);
    const t3Assigned = getTaskById(db, "t-3")!;
    declineOrFailAssignment(
      db,
      "t-3",
      "declined",
      { expectedState: t3Assigned.state, expectedEpoch: t3Assigned.routing_epoch },
      undefined,
      clock3
    );

    // 4. IN_PROGRESS task (~15 minutes old, matched then accepted 3 minutes ago)
    const clock4 = new FakeClock(referenceNowMs - 900_000);
    createTask(
      db,
      {
        id: "t-4",
        title: "Warehouse Cycle Count Variance",
        description: "Investigate bin discrepancies in regional fulfillment center.",
        area: "operations",
        priority: "low",
      },
      clock4
    );
    clock4.advanceMs(300_000);
    const t4Draft = getTaskById(db, "t-4")!;
    const r4 = submitForRouting(
      db,
      "t-4",
      { expectedState: t4Draft.state, expectedEpoch: t4Draft.routing_epoch },
      { simMode: "fast", attemptId: "att-seed-4", actor: "operator" },
      clock4
    );
    clock4.advanceMs(420_000);
    recordRoutingMatch(
      db,
      {
        taskId: "t-4",
        attemptId: r4.attempt.id,
        epoch: r4.attempt.epoch,
        contributorId: "c-1",
      },
      clock4
    );
    clock4.advanceMs(180_000);
    const t4Assigned = getTaskById(db, "t-4")!;
    acceptAssignment(
      db,
      "t-4",
      { expectedState: t4Assigned.state, expectedEpoch: t4Assigned.routing_epoch },
      clock4
    );
  })();
}