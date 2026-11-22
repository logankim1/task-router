export interface ScheduledHandle {
  cancel(): void;
}

export interface Scheduler {
  schedule(delayMs: number, fn: () => void): ScheduledHandle;
  pendingCount(): number;
  clearAll(): void;
}

export function createTimerScheduler(): Scheduler {
  const handles = new Set<ReturnType<typeof setTimeout>>();

  return {
    schedule(delayMs: number, fn: () => void): ScheduledHandle {
      const safeDelay = Math.max(0, Math.floor(delayMs));
      let cancelled = false;
      const timer = setTimeout(() => {
        handles.delete(timer);
        if (!cancelled) {
          fn();
        }
      }, safeDelay);
      handles.add(timer);

      return {
        cancel() {
          if (cancelled) return;
          cancelled = true;
          clearTimeout(timer);
          handles.delete(timer);
        },
      };
    },
    pendingCount(): number {
      return handles.size;
    },
    clearAll(): void {
      for (const timer of handles) {
        clearTimeout(timer);
      }
      handles.clear();
    },
  };
}

interface QueuedTask {
  id: number;
  runAtMs: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * Deterministic in-memory scheduler for tests. Advances time explicitly via
 * `advanceBy(ms)` or `runDue()` without real wall-clock timers.
 */
export class FakeScheduler implements Scheduler {
  private currentMs: number;
  private nextId = 1;
  private queue: QueuedTask[] = [];

  constructor(initialMs: number) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  schedule(delayMs: number, fn: () => void): ScheduledHandle {
    const safeDelay = Math.max(0, Math.floor(delayMs));
    const id = this.nextId++;
    const item: QueuedTask = {
      id,
      runAtMs: this.currentMs + safeDelay,
      fn,
      cancelled: false,
    };
    this.queue.push(item);
    this.queue.sort((a, b) => a.runAtMs - b.runAtMs || a.id - b.id);

    return {
      cancel: () => {
        item.cancelled = true;
        this.queue = this.queue.filter((q) => q.id !== id);
      },
    };
  }

  /**
   * Advances time by `deltaMs` and executes all due non-cancelled callbacks in order.
   */
  advanceBy(deltaMs: number): number {
    if (deltaMs < 0) {
      throw new Error("Cannot advance FakeScheduler by negative ms");
    }
    const targetMs = this.currentMs + deltaMs;
    while (true) {
      const nextDue = this.queue.find((q) => !q.cancelled && q.runAtMs <= targetMs);
      if (!nextDue) break;
      this.currentMs = nextDue.runAtMs;
      this.queue = this.queue.filter((q) => q.id !== nextDue.id);
      nextDue.fn();
    }
    this.currentMs = targetMs;
    return this.currentMs;
  }

  pendingCount(): number {
    return this.queue.filter((q) => !q.cancelled).length;
  }

  clearAll(): void {
    this.queue = [];
  }
}