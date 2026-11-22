import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app";
import { FakeClock } from "../src/lib/clock";
import { openDb } from "../src/lib/db";
import { createSeededRng } from "../src/lib/rng";
import { createRouterWorker, type RouterWorker } from "../src/lib/router-worker";
import { FakeScheduler } from "../src/lib/scheduler";
import {
  getAttemptsForTask,
  getEligibleContributorsForRouting,
  getEventsForTask,
  getTaskById,
  seedInitialTasks,
  sweepInterruptedAttemptsOnStartup,
} from "../src/lib/state-machine";

interface TestHarness {
  baseUrl: string;
  close: () => Promise<void>;
  clock: FakeClock;
  scheduler: FakeScheduler;
  worker: RouterWorker;
  db: ReturnType<typeof openDb>;
}

async function startHarness(startMs = 1_700_000_000_000, seed = 777): Promise<TestHarness> {
  const clock = new FakeClock(startMs);
  const scheduler = new FakeScheduler(startMs);
  const rng = createSeededRng(seed);
  const db = openDb(":memory:", clock, {
    onSeed: (d, c) => seedInitialTasks(d, c.nowMs()),
  });
  sweepInterruptedAttemptsOnStartup(db, clock);

  const worker = createRouterWorker({ db, clock, rng, scheduler });
  const app = createApp({ db, worker, clock });
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind test HTTP server");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    clock,
    scheduler,
    worker,
    db,
    close: async () => {
      worker.stopAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

async function apiJson(
  baseUrl: string,
  method: string,
  routePath: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

let activeHarness: TestHarness | null = null;

afterEach(async () => {
  if (activeHarness) {
    await activeHarness.close();
    activeHarness = null;
  }
});

describe("worker & API integration", () => {
  it("worker schedules fast mode and matches an eligible contributor", async () => {
    activeHarness = await startHarness();
    const { baseUrl, clock, scheduler, db } = activeHarness;

    const created = await apiJson(baseUrl, "POST", "/api/tasks", {
      title: "Fast Match Task",
      description: "Should match in finance",
      area: "finance",
      priority: "high",
      submit: true,
      simMode: "fast",
    });

    assert.equal(created.status, 201);
    const task = created.json.task as { id: string; state: string; routing_epoch: number };
    assert.equal(task.state, "ROUTING");

    clock.advanceMs(100);
    scheduler.advanceBy(100);

    const detail = await apiJson(baseUrl, "GET", `/api/tasks/${task.id}`);
    assert.equal(detail.status, 200);
    const updatedTask = detail.json.task as { state: string; assignee_id: string | null };
    assert.equal(updatedTask.state, "ASSIGNED");

    const rawTask = getTaskById(db, task.id)!;
    const eligibleIds = getEligibleContributorsForRouting(db, rawTask).eligible.map((c) => c.id);
    assert.ok(updatedTask.assignee_id !== null && eligibleIds.includes(updatedTask.assignee_id));
  });

  it("worker handles no_match mode and transitions task to UNRESOLVED", async () => {
    activeHarness = await startHarness();
    const { baseUrl, clock, scheduler } = activeHarness;

    const created = await apiJson(baseUrl, "POST", "/api/tasks", {
      title: "No Match Task",
      description: "Should yield no match",
      area: "healthcare",
      priority: "normal",
      submit: true,
      simMode: "no_match",
    });

    assert.equal(created.status, 201);
    const task = created.json.task as { id: string; state: string };
    assert.equal(task.state, "ROUTING");

    clock.advanceMs(200);
    scheduler.advanceBy(200);

    const detail = await apiJson(baseUrl, "GET", `/api/tasks/${task.id}`);
    const updatedTask = detail.json.task as { state: string };
    assert.equal(updatedTask.state, "UNRESOLVED");
  });

  it("worker hang mode stays pending and flags past 20s window", async () => {
    activeHarness = await startHarness();
    const { baseUrl, clock, scheduler, db } = activeHarness;

    const created = await apiJson(baseUrl, "POST", "/api/tasks", {
      title: "Hanging High Priority Task",
      description: "Never returns",
      area: "operations",
      priority: "high",
      submit: true,
      simMode: "hang",
    });

    const task = created.json.task as { id: string };
    clock.advanceMs(25_000);
    scheduler.advanceBy(25_000);

    const attempts = getAttemptsForTask(db, task.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "pending");

    const detail = await apiJson(baseUrl, "GET", `/api/tasks/${task.id}`);
    const t = detail.json.task as {
      state: string;
      pastUsualWindow: boolean;
      windowWarning: string | null;
    };
    assert.equal(t.state, "ROUTING");
    assert.equal(t.pastUsualWindow, true);
    assert.equal(t.windowWarning, "past the usual response window, may never return");
  });

  it("ignores late worker result after operator intervenes and rejects stale guard with 409", async () => {
    activeHarness = await startHarness();
    const { baseUrl, clock, scheduler, db } = activeHarness;

    const created = await apiJson(baseUrl, "POST", "/api/tasks", {
      title: "Intervene Over Late Result",
      description: "Slow routing still fires after operator intervenes",
      area: "finance",
      priority: "normal",
      submit: true,
      simMode: "slow",
    });

    const task = created.json.task as { id: string; state: string; routing_epoch: number };

    clock.advanceMs(1_000);
    scheduler.advanceBy(1_000);

    const interveneRes = await apiJson(baseUrl, "POST", `/api/tasks/${task.id}/intervene`, {
      actionType: "manual_assign",
      contributorId: "c-4",
      expectedState: task.state,
      expectedEpoch: task.routing_epoch,
    });
    assert.equal(interveneRes.status, 200);

    // Stale guard check returns 409
    const staleRes = await apiJson(baseUrl, "POST", `/api/tasks/${task.id}/accept`, {
      expectedState: task.state,
      expectedEpoch: task.routing_epoch,
    });
    assert.equal(staleRes.status, 409);
    assert.equal(staleRes.json.error, "This task just changed, please review");

    // Advance past 35s so the uncancelled slow timer fires and hits the epoch fence
    clock.advanceMs(40_000);
    scheduler.advanceBy(40_000);

    const currentTask = getTaskById(db, task.id)!;
    assert.equal(currentTask.state, "ASSIGNED");
    assert.equal(currentTask.assignee_id, "c-4");

    const attempts = getAttemptsForTask(db, task.id);
    assert.equal(attempts[0].status, "cancelled");
    assert.ok(attempts[0].late_arrived_at !== null);

    const events = getEventsForTask(db, task.id);
    assert.ok(events.some((e) => e.event_type === "STALE_ROUTING_IGNORED"));
  });

  it("supports two tasks routing concurrently with independent epochs, attempts, and eligible assignees", async () => {
    activeHarness = await startHarness();
    const { baseUrl, clock, scheduler, db } = activeHarness;

    const tA = await apiJson(baseUrl, "POST", "/api/tasks", {
      title: "Concurrent Task A",
      description: "Finance",
      area: "finance",
      priority: "normal",
      submit: true,
      simMode: "fast",
    });
    const tB = await apiJson(baseUrl, "POST", "/api/tasks", {
      title: "Concurrent Task B",
      description: "Data analysis",
      area: "data analysis",
      priority: "high",
      submit: true,
      simMode: "fast",
    });

    assert.equal(tA.status, 201);
    assert.equal(tB.status, 201);

    const idA = (tA.json.task as { id: string }).id;
    const idB = (tB.json.task as { id: string }).id;
    assert.notEqual(idA, idB);

    clock.advanceMs(150);
    scheduler.advanceBy(150);

    const detailA = await apiJson(baseUrl, "GET", `/api/tasks/${idA}`);
    const detailB = await apiJson(baseUrl, "GET", `/api/tasks/${idB}`);

    const taskA = detailA.json.task as { id: string; state: string; assignee_id: string | null; routing_epoch: number };
    const taskB = detailB.json.task as { id: string; state: string; assignee_id: string | null; routing_epoch: number };

    assert.equal(taskA.state, "ASSIGNED");
    assert.equal(taskB.state, "ASSIGNED");
    assert.equal(taskA.routing_epoch, 1);
    assert.equal(taskB.routing_epoch, 1);

    const attemptsA = getAttemptsForTask(db, idA);
    const attemptsB = getAttemptsForTask(db, idB);
    assert.equal(attemptsA.length, 1);
    assert.equal(attemptsB.length, 1);
    assert.notEqual(attemptsA[0].id, attemptsB[0].id);
    assert.equal(attemptsA[0].task_id, idA);
    assert.equal(attemptsB[0].task_id, idB);

    const eligibleA = getEligibleContributorsForRouting(db, getTaskById(db, idA)!).eligible.map((c) => c.id);
    const eligibleB = getEligibleContributorsForRouting(db, getTaskById(db, idB)!).eligible.map((c) => c.id);
    assert.ok(taskA.assignee_id !== null && eligibleA.includes(taskA.assignee_id));
    assert.ok(taskB.assignee_id !== null && eligibleB.includes(taskB.assignee_id));
  });
});