export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export class FakeClock implements Clock {
  private currentMs: number;

  constructor(initialMs = 1_700_000_000_000) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  advanceMs(deltaMs: number): number {
    if (deltaMs < 0) {
      throw new Error("Cannot advance FakeClock by negative ms");
    }
    this.currentMs += deltaMs;
    return this.currentMs;
  }

  setMs(ms: number): void {
    this.currentMs = ms;
  }
}