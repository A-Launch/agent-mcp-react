// The reconnection schedule: how long to wait before the next attempt.
//
// **Pure, and that is the whole design.** No clock of its own, no timers, no I/O, no socket. Given a
// source of randomness it computes intervals, and nothing else. That is what makes the one part of
// reconnection whose correctness is arithmetic testable without a renderer, a gateway or a wall clock —
// and the properties that matter here are exactly the ones that look fine in a hand test.
//
// **It drives nothing.** What must re-run per attempt is the runtime's connect, which lives above the
// transport, so the provider owns the driving and this module owns the numbers. One owner each: a
// schedule that also scheduled would be a second place deciding when to dial.
//
// Two failure modes this exists to prevent, both of which produce something that still looks like a
// backoff:
//
//   - **Resetting per attempt rather than on success.** The intervals are then always the first one,
//     which is a retry storm wearing a backoff's clothing — hundreds of attempts a second at 500 ms
//     each across enough tabs. It passes any test that checks only the first two intervals.
//   - **No jitter.** Every page that lost the same gateway retries at the same instant, so a gateway
//     coming back up is taken down again by its own clients. Jitter is not decoration; it is the only
//     thing that desynchronizes a fleet that all failed together.

/**
 * The intervals, in order, before the last one is held indefinitely
 * (docs/connection-lifecycle.md#the-backoff-schedule).
 *
 * A literal table rather than a formula. The design states these seven values, and a doubling
 * expression that happens to produce them would be a second statement of the same thing that could
 * drift from it — and the seventh value is not a doubling anyway.
 */
const SCHEDULE_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * The longest this will ever wait (docs/connection-lifecycle.md#the-backoff-schedule).
 *
 * Derived from the table rather than repeated, so the two cannot disagree. Exported because a case
 * asserting "never exceeds the maximum" must not spell the number itself — a case that hardcoded
 * 30_000 would keep passing against a table that changed.
 */
export const MAX_RECONNECT_DELAY_MS: number = SCHEDULE_MS[SCHEDULE_MS.length - 1] as number;

/**
 * How much of an interval jitter may move, as a fraction.
 *
 * Applied downward only, so an interval is never longer than the schedule says and the maximum stays a
 * real bound. A quarter is enough to scatter a fleet across a window far wider than the burst that
 * takes a gateway down, and small enough that the schedule still reads as the schedule.
 */
const JITTER_FRACTION = 0.25;

export interface ReconnectSchedule {
  /**
   * The wait before the next attempt, and advances.
   *
   * Advancing on being READ rather than on a reported failure is deliberate: every read is a wait
   * before an attempt, so there is no state where a caller has taken an interval and not used it. A
   * separate `advance()` would be a second call a caller could forget, and forgetting it is the retry
   * storm.
   */
  next(): number;
  /**
   * Returns to the beginning.
   *
   * **Called on a successful connection, and on nothing else.** Calling it per attempt is the defect
   * this module's header names: the schedule then never leaves its first interval.
   */
  reset(): void;
  /** Which attempt the next one will be, counting from 1. For a status surface, never for policy. */
  attempt(): number;
}

/**
 * Creates a schedule.
 *
 * `random` is injected so a case can make jitter deterministic and assert the exact intervals. It
 * defaults to the platform's, which is what a page uses — this is not a seam an application configures,
 * and the schedule is deliberately not configurable at all: a knob here is a caller's chance to set an
 * interval that never fires, or one that hammers a gateway.
 */
export function createReconnectSchedule(random: () => number = Math.random): ReconnectSchedule {
  let index = 0;

  return {
    next(): number {
      // Held at the last entry rather than running off the end. `noUncheckedIndexedAccess` makes the
      // fallback explicit; it is unreachable, and spelling it is cheaper than asserting it is.
      const base = SCHEDULE_MS[Math.min(index, SCHEDULE_MS.length - 1)] ?? MAX_RECONNECT_DELAY_MS;
      index += 1;
      // Downward only: `base` is the ceiling, so the maximum above stays a bound rather than an
      // average. Two schedules that failed at the same instant now diverge on their first interval.
      return Math.round(base * (1 - JITTER_FRACTION * random()));
    },

    reset(): void {
      index = 0;
    },

    attempt(): number {
      return index + 1;
    },
  };
}
