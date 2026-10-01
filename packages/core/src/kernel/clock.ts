/**
 * Time is injected, never read from the ambient system inside domain code
 * (`docs/conventions.md`: "inject `Clock`; never call `Date.now()` in domain
 * code"). The ESLint preset bans `Date.now` in `packages/core`, so a test can
 * always pin the clock and an expiry test never has to sleep.
 */

export interface Clock {
  now(): Date;
  /** Milliseconds since the epoch. Same instant as `now()`. */
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(Date.now()),
  nowMs: () => Date.now(),
};

export interface FixedClock extends Clock {
  /** Move time forward (or back, with a negative value). */
  advance(ms: number): void;
  set(at: Date | number | string): void;
}

/** A clock a test owns. Nothing advances it but the test. */
export function fixedClock(at: Date | number | string = '2026-01-01T00:00:00.000Z'): FixedClock {
  let ms = new Date(at).getTime();
  if (Number.isNaN(ms)) throw new TypeError(`fixedClock: invalid time ${String(at)}`);
  return {
    now: () => new Date(ms),
    nowMs: () => ms,
    advance: (delta) => {
      ms += delta;
    },
    set: (next) => {
      const parsed = new Date(next).getTime();
      if (Number.isNaN(parsed)) throw new TypeError(`fixedClock.set: invalid time ${String(next)}`);
      ms = parsed;
    },
  };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
