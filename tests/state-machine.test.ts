import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeClock } from "../src/lib/clock";
import { openDb, seedContributorsIfEmpty } from "../src/lib/db";
import { createSeededRng } from "../src/lib/rng";
import {
  acceptAssignment,
  completeTask,
  ConflictError,
  createTask,
  declineOrFailAssignment,
  getAttemptsForTask,
  getEligibleContributorsForRouting,
  getEventsForTask,
  getTaskById,
  interveneOnTask,
  InvalidTransitionError,
  recordRoutingMatch,
  recordRoutingNoMatch,
  recoverTask,
  seedInitialTasks,
  submitForRouting,
  sweepInterruptedAttemptsOnStartup,
} from "../src/lib/state-machine";

function makeTestDb(startMs = 1_700_000_000_000) {
  const clock = new FakeClock(startMs);
  const db = openDb(":memory:", clock, {
    onSeed: (d, c) => seedInitialTasks(d, c.nowMs()),
  });
  return { db, clock };
}

describe("state machine & invariants", () => {
  it("seeds complete histories, distinct ages, and no ROUTING tasks", () => {
    const baseMs = 1_700_000_000_000;
    const { db } = makeTestDb(baseMs);

    const t1 = getTaskById(db, "t-1")!;
    const t2 = getTaskById(db, "t-2")!;
    const t3 = getTaskById(db, "t-3")!;
    const t4 = getTaskById(db, "t-4")!;

    assert.equal(t1.state, "DRAFT");
    assert.equal(t2.state, "ASSIGNED");
    assert.equal(t3.state, "RECOVERY_NEEDED");
    assert.equal(t4.state, "IN_PROGRESS");

    assert.equal(baseMs - t1.created_at, 120_000);
    assert.equal(baseMs - t2.created_at, 300_000);
    assert.equal(baseMs - t3.created_at, 600_000);
    assert.equal(baseMs - t4.created_at, 900_000);

    const t2Events = getEventsForTask(db, "t-2");
    assert.deepEqual(
      t2Events.map((e) => e.event_type),
      ["TASK_CREATED", "ROUTING_STARTED", "ROUTING_MATCHED"]
    );
    assert.equal(getAttemptsForTask(db, "t-2").length, 1);

    const t3Events = getEventsForTask(db, "t-3");
    assert.deepEqual(
      t3Events.map((e) => e.event_type),
      ["TASK_CREATED", "ROUTING_STARTED", "ROUTING_MATCHED", "ASSIGNMENT_DECLINED"]
    );
    assert.equal(getAttemptsForTask(db, "t-3").length, 1);

    for (let i = 1; i < t3Events.length; i++) {
      assert.ok(t3Events[i].seq > t3Events[i - 1].seq);
    }
  });

  it("keeps cancelled attempt cancelled and records late match in history", () => {
    const { db, clock } = makeTestDb();
    const task = createTask(
      db,
      {
        title: "Late Match Test",
        description: "Test stale match after operator cancels round",
        area: "finance",
        priority: "high",
      },
      clock
    );

    const { task: routingTask, attempt } = submitForRouting(
      db,
      task.id,
      { expectedState: task.state, expectedEpoch: task.routing_epoch },
      { simMode: "slow", attemptId: "att-late-match", actor: "operator" },
      clock
    );

    clock.advanceMs(3_000);
    const intervened = interveneOnTask(
      db,
      routingTask.id,
      { type: "manual_assign", contributorId: "c-4" },
      { expectedState: routingTask.state, expectedEpoch: routingTask.routing_epoch },
      clock
    );
    assert.equal(intervened.state, "ASSIGNED");
    assert.equal(intervened.assignee_id, "c-4");
    assert.equal(intervened.routing_epoch, 2);

    clock.advanceMs(5_000);
    const lateTime = clock.nowMs();
    const res = recordRoutingMatch(
      db,
      {
        taskId: task.id,
        attemptId: attempt.id,
        epoch: 1,
        contributorId: "c-1",
      },
      clock
    );

    assert.equal(res.outcome, "stale_ignored");
    assert.equal(res.attempt.status, "cancelled");
    assert.equal(res.attempt.late_candidate_contributor_id, "c-1");
    assert.equal(res.attempt.late_arrived_at, lateTime);
    assert.equal(getTaskById(db, task.id)!.assignee_id, "c-4");

    const events = getEventsForTask(db, task.id);
    assert.ok(
      events.some(
        (e) =>
          e.event_type === "STALE_ROUTING_IGNORED" &&
          e.summary.includes("remained cancelled")
      )
    );
  });

  it("keeps cancelled attempt cancelled and records late no-match in history", () => {
    const { db, clock } = makeTestDb();
    const task = createTask(
      db,
      {
        title: "Late No-Match Test",
        description: "Test stale no-match after operator cancels round",
        area: "healthcare",
        priority: "normal",
      },
      clock
    );

    const { task: routingTask, attempt } = submitForRouting(
      db,
      task.id,
      { expectedState: task.state, expectedEpoch: task.routing_epoch },
      { simMode: "slow", attemptId: "att-late-nomatch", actor: "operator" },
      clock
    );

    clock.advanceMs(2_000);
    const intervened = interveneOnTask(
      db,
      routingTask.id,
      { type: "reroute", simMode: "fast" },
      { expectedState: routingTask.state, expectedEpoch: routingTask.routing_epoch },
      clock
    );
    assert.equal(intervened.routing_epoch, 2);

    clock.advanceMs(4_000);
    const lateTime = clock.nowMs();
    const res = recordRoutingNoMatch(
      db,
      {
        taskId: task.id,
        attemptId: attempt.id,
        epoch: 1,
      },
      clock
    );

    assert.equal(res.outcome, "stale_ignored");
    assert.equal(res.attempt.status, "cancelled");
    assert.equal(res.attempt.late_arrived_at, lateTime);
    assert.equal(getTaskById(db, task.id)!.state, "ROUTING");
    assert.equal(getTaskById(db, task.id)!.routing_epoch, 2);

    const events = getEventsForTask(db, task.id);
    assert.ok(
      events.some(
        (e) =>
          e.event_type === "STALE_ROUTING_IGNORED" &&
          e.summary.includes("remained cancelled")
      )
    );
  });

  it("rejects operator action with stale state or epoch with ConflictError", () => {
    const { db, clock } = makeTestDb();
    const task = createTask(
      db,
      {
        title: "Guard Conflict Test",
        description: "Stale state/epoch rejected",
        area: "finance",
        priority: "normal",
      },
      clock
    );

    const { task: routingTask, attempt } = submitForRouting(
      db,
      task.id,
      { expectedState: task.state, expectedEpoch: task.routing_epoch },
      { simMode: "fast", attemptId: "att-conflict", actor: "operator" },
      clock
    );

    recordRoutingMatch(
      db,
      {
        taskId: task.id,
        attemptId: attempt.id,
        epoch: 1,
        contributorId: "c-1",
      },
      clock
    );

    assert.throws(
      () =>
        interveneOnTask(
          db,
          task.id,
          { type: "return_to_draft" },
          { expectedState: routingTask.state, expectedEpoch: routingTask.routing_epoch },
          clock
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.message, "This task just changed, please review");
        assert.equal(err.currentState, "ASSIGNED");
        return true;
      }
    );
  });

  it("enforces expertise, excludes declined contributors on re-route, and labels out-of-area manual assigns", () => {
    const { db, clock } = makeTestDb();
    const task = createTask(
      db,
      {
        title: "Expertise & Re-route Exclusion Test",
        description: "Finance task",
        area: "finance",
        priority: "high",
      },
      clock
    );

    const { task: r1, attempt: a1 } = submitForRouting(
      db,
      task.id,
      { expectedState: task.state, expectedEpoch: task.routing_epoch },
      { simMode: "fast", attemptId: "att-exp-1", actor: "operator" },
      clock
    );

    // Rejects contributor without finance expertise (c-3 is healthcare/operations)
    assert.throws(
      () =>
        recordRoutingMatch(
          db,
          {
            taskId: task.id,
            attemptId: a1.id,
            epoch: a1.epoch,
            contributorId: "c-3",
          },
          clock
        ),
      InvalidTransitionError
    );

    const matched = recordRoutingMatch(
      db,
      {
        taskId: task.id,
        attemptId: a1.id,
        epoch: a1.epoch,
        contributorId: "c-1",
      },
      clock
    ).task;

    const declined = declineOrFailAssignment(
      db,
      task.id,
      "declined",
      { expectedState: matched.state, expectedEpoch: matched.routing_epoch },
      undefined,
      clock
    );
    assert.equal(declined.state, "RECOVERY_NEEDED");

    const { eligible, excluded } = getEligibleContributorsForRouting(db, declined);
    assert.ok(!eligible.some((c) => c.id === "c-1"));
    assert.ok(eligible.some((c) => c.id === "c-4"));
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].contributorId, "c-1");

    // Excluded contributor cannot be matched even if passed directly
    const r2 = recoverTask(
      db,
      task.id,
      { mode: "reroute", simMode: "fast" },
      { expectedState: declined.state, expectedEpoch: declined.routing_epoch },
      clock
    );
    const a2 = getAttemptsForTask(db, task.id).find((a) => a.epoch === r2.routing_epoch)!;
    assert.throws(
      () =>
        recordRoutingMatch(
          db,
          {
            taskId: task.id,
            attemptId: a2.id,
            epoch: a2.epoch,
            contributorId: "c-1",
          },
          clock
        ),
      InvalidTransitionError
    );

    // Manual assign outside expertise records tag & previous assignee on reassign
    const outsideAssigned = interveneOnTask(
      db,
      task.id,
      { type: "manual_assign", contributorId: "c-3" },
      { expectedState: r2.state, expectedEpoch: r2.routing_epoch },
      clock
    );
    assert.match(
      getEventsForTask(db, task.id).at(-1)!.summary,
      /assigned outside expertise/
    );

    const reassigned = interveneOnTask(
      db,
      task.id,
      { type: "manual_assign", contributorId: "c-4" },
      { expectedState: outsideAssigned.state, expectedEpoch: outsideAssigned.routing_epoch },
      clock
    );
    assert.match(
      getEventsForTask(db, task.id).at(-1)!.summary,
      /from Priya Nair \(c-3\) to Mateo Silva \(c-4\)/
    );
    assert.equal(reassigned.assignee_id, "c-4");
  });

  it("marks pending attempts as interrupted on restart and supports seeded RNG & accept/complete", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const db = openDb(":memory:", clock);
    seedContributorsIfEmpty(db);

    const task = createTask(
      db,
      {
        title: "Restart Test",
        description: "Pending attempt before restart",
        area: "operations",
        priority: "normal",
      },
      clock
    );

    submitForRouting(
      db,
      task.id,
      { expectedState: task.state, expectedEpoch: task.routing_epoch },
      { simMode: "hang", attemptId: "att-hang-1", actor: "operator" },
      clock
    );

    clock.advanceMs(5_000);
    const interruptedCount = sweepInterruptedAttemptsOnStartup(db, clock);
    assert.equal(interruptedCount, 1);

    const afterRestart = getTaskById(db, task.id)!;
    assert.equal(afterRestart.state, "UNRESOLVED");
    assert.equal(getAttemptsForTask(db, task.id)[0].status, "interrupted_by_restart");

    const rngA = createSeededRng(101);
    const rngB = createSeededRng(101);
    assert.deepEqual([rngA.next(), rngA.next()], [rngB.next(), rngB.next()]);

    const assigned = recoverTask(
      db,
      task.id,
      { mode: "manual_assign", contributorId: "c-1" },
      { expectedState: afterRestart.state, expectedEpoch: afterRestart.routing_epoch },
      clock
    );
    const accepted = acceptAssignment(
      db,
      task.id,
      { expectedState: assigned.state, expectedEpoch: assigned.routing_epoch },
      clock
    );
    assert.equal(accepted.state, "IN_PROGRESS");
    const completed = completeTask(
      db,
      task.id,
      { expectedState: accepted.state, expectedEpoch: accepted.routing_epoch },
      clock
    );
    assert.equal(completed.state, "COMPLETED");
  });
});