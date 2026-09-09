import { describe, expect, it, vi } from 'vitest';
import {
  CALL_PHASE,
  CALL_ROUTE,
  FAILURE_VOCABULARY,
  GATE_OUTCOME,
  OBSERVED_PAYLOADS,
  type ObservedCall,
  type ObservedPayloads,
} from '../../../src/runtime/call-record.ts';
import {
  type ConsumerFailureSink,
  createObservationBus,
} from '../../../src/runtime/observation.ts';

// The delivery mechanism, asserted as a mechanism rather than as a shape.
//
// Four properties live here and each of them fails SILENTLY if it is wrong: a record built when nobody
// asked for one, a terminal delivered without its start, one consumer's throw stopping another's
// delivery, and a second terminal making every count a consumer keeps wrong.

function bus(
  payloads: ObservedPayloads = OBSERVED_PAYLOADS.metadata,
  onConsumerFailure: ConsumerFailureSink = () => {},
) {
  return createObservationBus({ payloads: () => payloads, onConsumerFailure });
}

const facts =
  (name = 'customers.set_filters') =>
  () => ({
    name,
    route: CALL_ROUTE.bridge,
    startedAt: 1,
  });

describe('what happens when nobody is listening', () => {
  it('opens no observation at all', () => {
    const built = vi.fn(facts());
    expect(bus().beginIfObserved(built)).toBeUndefined();
    // The thunk is the point. An application supplying no callbacks and mounting no inspector must
    // pay nothing — not a record, not an id, not a timestamp — and a facts object built eagerly would
    // be that cost paid on every call forever.
    expect(built).not.toHaveBeenCalled();
  });

  it('opens one as soon as somebody is', () => {
    const observed = bus();
    observed.subscribe(() => {});
    expect(observed.beginIfObserved(facts())).toBeDefined();
  });
});

describe('the order events arrive in', () => {
  it('delivers a start before its terminal', async () => {
    const observed = bus();
    const seen: ObservedCall[] = [];
    observed.subscribe((event) => seen.push(event));

    const call = observed.beginIfObserved(facts());
    call?.finishResult({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.map((event) => event.phase)).toEqual([CALL_PHASE.start, CALL_PHASE.result]);
    expect(seen[0]?.callId).toBe(seen[1]?.callId);
  });

  it('does not interleave two concurrent calls into an unreconcilable order', async () => {
    const observed = bus();
    const seen: ObservedCall[] = [];
    observed.subscribe((event) => seen.push(event));

    const first = observed.beginIfObserved(facts('a.one'));
    const second = observed.beginIfObserved(facts('b.two'));
    second?.finishResult('second');
    first?.finishResult('first');
    await Promise.resolve();
    await Promise.resolve();

    // Each call's own start precedes its own terminal. The two calls may interleave with each other —
    // they genuinely are concurrent — but a start after its terminal would be unreconcilable.
    for (const id of [first?.callId, second?.callId]) {
      const phases = seen.filter((event) => event.callId === id).map((event) => event.phase);
      expect(phases).toEqual([CALL_PHASE.start, CALL_PHASE.result]);
    }
  });

  it('delivers nothing that began before a subscriber attached', async () => {
    const observed = bus();
    const early: ObservedCall[] = [];
    observed.subscribe((event) => early.push(event));

    const running = observed.beginIfObserved(facts('in.flight'));

    const late: ObservedCall[] = [];
    observed.subscribe((event) => late.push(event));
    running?.finishResult('done');
    await Promise.resolve();
    await Promise.resolve();

    // The late subscriber must not receive a terminal whose start it never saw. A consumer cannot tell
    // an unpairable record from a lost one, so handing it one would make every gap ambiguous.
    expect(early.map((event) => event.phase)).toEqual([CALL_PHASE.start, CALL_PHASE.result]);
    expect(late).toEqual([]);
  });
});

describe('a consumer that misbehaves', () => {
  it('does not stop delivery to the others, and is reported rather than swallowed', async () => {
    const failures: unknown[] = [];
    const observed = bus(OBSERVED_PAYLOADS.metadata, (failure) => failures.push(failure));
    const survivor: ObservedCall[] = [];

    observed.subscribe(() => {
      throw new Error('the application threw while being told about a call');
    });
    observed.subscribe((event) => survivor.push(event));

    observed.beginIfObserved(facts())?.finishResult('fine');
    await Promise.resolve();
    await Promise.resolve();

    expect(survivor.map((event) => event.phase)).toEqual([CALL_PHASE.start, CALL_PHASE.result]);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('stops receiving anything once it unsubscribes', async () => {
    const observed = bus();
    const seen: ObservedCall[] = [];
    const stop = observed.subscribe((event) => seen.push(event));
    stop();

    expect(observed.beginIfObserved(facts())).toBeUndefined();
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});

describe('the single terminal', () => {
  it('refuses a second one, and reports it as an instrumentation defect', async () => {
    const failures: unknown[] = [];
    const observed = bus(OBSERVED_PAYLOADS.metadata, (failure) => failures.push(failure));
    const seen: ObservedCall[] = [];
    observed.subscribe((event) => seen.push(event));

    const call = observed.beginIfObserved(facts());
    call?.finishResult('first ending');
    // The sequence this guards: a site that settles when the HANDLER resolves, and then settles again
    // when output validation fails or the result turns out to be unserializable. Both are real paths
    // in the runtime, and a consumer given two endings has every count it keeps made wrong.
    call?.finishError({ vocabulary: FAILURE_VOCABULARY.uncoded });
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.filter((event) => event.phase !== CALL_PHASE.start)).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

describe('what a record carries', () => {
  it('reports every gate step, defaulting to notRun', async () => {
    const observed = bus();
    const seen: ObservedCall[] = [];
    observed.subscribe((event) => seen.push(event));

    const call = observed.beginIfObserved(facts());
    call?.gate('capability', GATE_OUTCOME.refused);
    call?.finishError({ vocabulary: FAILURE_VOCABULARY.uncoded });
    await Promise.resolve();
    await Promise.resolve();

    const terminal = seen.find((event) => event.phase === CALL_PHASE.error);
    // Every step present, never omitted — an absent step reads to a consumer as one that passed.
    expect(terminal?.gates).toHaveLength(7);
    expect(terminal?.gates.find((gate) => gate.step === 'capability')?.outcome).toBe(
      GATE_OUTCOME.refused,
    );
    expect(terminal?.gates.find((gate) => gate.step === 'invoke')?.outcome).toBe(
      GATE_OUTCOME.notRun,
    );
  });
});
