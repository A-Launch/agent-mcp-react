import { describe, expect, it } from 'vitest';
import {
  createReconnectSchedule,
  MAX_RECONNECT_DELAY_MS,
} from '../../../src/transport/reconnect.ts';

// The reconnection schedule, against an injected source of randomness.
//
// No socket, no renderer, no clock — the module is pure, which is what lets these assert the exact
// intervals rather than "roughly increasing". Two of the four properties below look correct in any hand
// test and are the ones that take a gateway down.

/** Jitter pinned to zero, so an interval is exactly what the schedule says. */
function unjittered(): ReturnType<typeof createReconnectSchedule> {
  return createReconnectSchedule(() => 0);
}

function take(schedule: ReturnType<typeof createReconnectSchedule>, count: number): number[] {
  return Array.from({ length: count }, () => schedule.next());
}

describe('the intervals it produces', () => {
  it('follows the documented sequence', () => {
    expect(take(unjittered(), 7)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000]);
  });

  it('holds the maximum indefinitely rather than running off the end', () => {
    const schedule = unjittered();
    take(schedule, 7);
    // Twenty more. A gateway that stays down for an hour must not produce an interval that grew past
    // the cap, and must not throw or return nothing when the table is exhausted.
    expect(take(schedule, 20)).toEqual(Array.from({ length: 20 }, () => MAX_RECONNECT_DELAY_MS));
  });

  it('never exceeds the maximum, with jitter at either extreme', () => {
    for (const random of [() => 0, () => 0.5, () => 0.999_999]) {
      const schedule = createReconnectSchedule(random);
      for (const interval of take(schedule, 30)) {
        expect(interval).toBeLessThanOrEqual(MAX_RECONNECT_DELAY_MS);
        expect(interval).toBeGreaterThan(0);
      }
    }
  });

  it("exports a maximum that IS the schedule's last interval, not a number restating it", () => {
    // Derived, never repeated. A module that declared the cap separately could drift from its own
    // table — and the drift would be invisible, because both values would look right in isolation.
    const exhausted = unjittered();
    take(exhausted, 7);

    expect(exhausted.next()).toBe(MAX_RECONNECT_DELAY_MS);
  });
});

describe('jitter', () => {
  it('makes two schedules that failed together diverge', () => {
    // The fleet case. Every page that lost the same gateway starts its schedule at the same instant;
    // without jitter they all retry at the same instant too, and the gateway that just came back is
    // taken down again by its own clients.
    const first = createReconnectSchedule(() => 0.1);
    const second = createReconnectSchedule(() => 0.9);

    expect(second.next()).not.toBe(first.next());
  });

  it('is applied to every interval, not only the first', () => {
    const jittered = createReconnectSchedule(() => 0.5);
    const plain = unjittered();

    const a = take(jittered, 7);
    const b = take(plain, 7);
    // Every position differs. Jitter applied only at the start leaves a fleet re-synchronizing at the
    // cap, which is precisely where they spend the most time.
    for (const [index, value] of a.entries()) expect(value).not.toBe(b[index]);
  });
});

describe('when it goes back to the beginning', () => {
  it('does so on reset, and produces the first interval again', () => {
    const schedule = unjittered();
    take(schedule, 4);
    schedule.reset();

    expect(schedule.next()).toBe(500);
  });

  it('does NOT go back on its own between attempts', () => {
    // The retry storm, stated as a property rather than as a warning. A schedule that reset itself per
    // attempt returns 500 forever — which still looks like a backoff, and still passes a case that
    // checks only the first two intervals. This one checks that the fourth is not the first.
    const schedule = unjittered();
    const intervals = take(schedule, 4);

    expect(new Set(intervals).size).toBe(4);
    expect(intervals[3]).toBeGreaterThan(intervals[0] as number);
  });
});

describe('which attempt it is on', () => {
  it('counts from one and advances with the schedule', () => {
    const schedule = unjittered();
    expect(schedule.attempt()).toBe(1);
    schedule.next();
    expect(schedule.attempt()).toBe(2);
    schedule.next();
    expect(schedule.attempt()).toBe(3);
  });

  it('returns to one on reset, so a later drop reads as a first attempt again', () => {
    const schedule = unjittered();
    take(schedule, 5);
    schedule.reset();

    expect(schedule.attempt()).toBe(1);
  });
});
