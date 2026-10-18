/** Injectable clock so every time-dependent rule is testable and deterministic. */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** Test clock: starts at a fixed instant and only moves when told to. */
export function fixedClock(start: Date | string | number): Clock & { advance(ms: number): void; set(at: Date): void } {
  let current = typeof start === 'number' ? new Date(start) : new Date(start);
  return {
    now: () => new Date(current.getTime()),
    nowMs: () => current.getTime(),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    set(at: Date) {
      current = at;
    },
  };
}
