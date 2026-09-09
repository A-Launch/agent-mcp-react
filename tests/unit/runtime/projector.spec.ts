import { describe, expect, it } from 'vitest';
import {
  CALL_PHASE,
  CALL_ROUTE,
  OBSERVED_PAYLOADS,
  type ObservedCall,
} from '../../../src/runtime/call-record.ts';
import { createObservationBus } from '../../../src/runtime/observation.ts';

// **The negative suite for this feature, and the most valuable cases in it.**
//
// A live leak was fixed once already: a validation refusal returned `{password: 'secret'}` to the agent.
// This feature opens a SECOND channel out of the gate chain, and the tempting argument for letting
// values through it — "the application's handler already receives the arguments, so an event carrying
// them discloses nothing" — is false for the case that matters. A call refused at resolve, capability,
// policy, validate or confirm NEVER REACHES THE HANDLER. A refused call is therefore exactly where a
// value-carrying event hands the application data it would otherwise never have seen, and an argument
// that failed validation is the likeliest of all to be malformed or secret.
//
// So the default is metadata in EVERY build, development included, and the projector is an ALLOWLIST
// rather than a filter: it is handed library-owned facts and copies them. It never traverses an
// argument, and it never receives a formatted message.

const SECRET = 'hunter2-correct-horse-battery-staple';

function collect(payloads: (typeof OBSERVED_PAYLOADS)[keyof typeof OBSERVED_PAYLOADS]) {
  const seen: ObservedCall[] = [];
  const bus = createObservationBus({ payloads: () => payloads, onConsumerFailure: () => {} });
  bus.subscribe((event) => seen.push(event));
  return { bus, seen };
}

/** Everything a consumer could read off the delivered events, as one searchable string. */
function everythingDelivered(seen: readonly ObservedCall[]): string {
  return JSON.stringify(seen);
}

describe('the default, in every build', () => {
  it('carries no argument value', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.metadata);
    bus
      .beginIfObserved(() => ({
        name: 'account.sign_in',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: { username: 'ada', password: SECRET },
      }))
      ?.finishResult({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(everythingDelivered(seen)).not.toContain(SECRET);
    expect(seen.every((event) => event.arguments === undefined)).toBe(true);
  });

  it('carries no result value', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.metadata);
    bus
      .beginIfObserved(() => ({ name: 'vault.read', route: CALL_ROUTE.bridge, startedAt: 1 }))
      ?.finishResult({ recoveryCode: SECRET });
    await Promise.resolve();
    await Promise.resolve();

    // A result is as sensitive as an argument and is routinely forgotten, because the mental model is
    // "redact what the caller sent". A tool that READS a secret returns one.
    expect(everythingDelivered(seen)).not.toContain(SECRET);
  });

  it('carries no secret encoded in an argument KEY', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.metadata);
    bus
      .beginIfObserved(() => ({
        name: 'account.sign_in',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: { [SECRET]: true },
      }))
      ?.finishResult(null);
    await Promise.resolve();
    await Promise.resolve();

    // A filtering design that stripped VALUES and kept the shape would leak here, and would look
    // thorough while doing it. An allowlist cannot, because it never traverses the object at all.
    expect(everythingDelivered(seen)).not.toContain(SECRET);
  });

  it('carries nothing DERIVED from a value either', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.metadata);
    bus
      .beginIfObserved(() => ({
        name: 'account.sign_in',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: { password: SECRET },
      }))
      ?.finishResult(null);
    await Promise.resolve();
    await Promise.resolve();

    // A password's LENGTH is a side channel, and so are a sample, a hash, an element count and an
    // inferred type. An early draft of this feature listed "sizes" as metadata; it is not.
    //
    // **Asserted on FIELDS, not by substring-matching the serialized record**, and that is a
    // correction rather than a style preference. `not.toContain(String(secret.length))` looks precise
    // and is not: the length here is 36, `settledAt` is a real millisecond timestamp, and "36" appears
    // in one often enough to fail intermittently. A leak assertion that fires on coincidence is one a
    // reader learns to re-run instead of believe — the same mistake cost a green suite twice in this
    // feature before it was understood.
    for (const event of seen) {
      expect(Object.keys(event)).not.toContain('arguments');
      expect(Object.keys(event)).not.toContain('result');
      // No field anywhere holds the length, a prefix, or anything else computed from the value.
      for (const [key, value] of Object.entries(event)) {
        if (key === 'startedAt' || key === 'settledAt' || key === 'callId') continue;
        expect(JSON.stringify(value)).not.toContain(String(SECRET.length));
        expect(JSON.stringify(value)).not.toContain(SECRET.slice(0, 8));
      }
    }
  });
});

describe('the explicit opt-in', () => {
  it('carries values only when an application asked', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.values);
    bus
      .beginIfObserved(() => ({
        name: 'account.sign_in',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: { password: SECRET },
      }))
      ?.finishResult({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(everythingDelivered(seen)).toContain(SECRET);
  });

  it('detaches the snapshot, so a consumer cannot reach back into the application', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.values);
    const live = { filters: { status: 'active' } };
    bus
      .beginIfObserved(() => ({
        name: 'customers.set_filters',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: live,
      }))
      ?.finishResult(null);
    await Promise.resolve();
    await Promise.resolve();

    const carried = seen[0]?.arguments as typeof live;
    expect(carried).toEqual(live);
    // Not the same object. A consumer holding the live one could mutate what a handler is about to
    // receive, which would turn an observer into a participant.
    expect(carried).not.toBe(live);
    expect(carried.filters).not.toBe(live.filters);
  });

  it('bounds an enormous value rather than copying it', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.values);
    bus
      .beginIfObserved(() => ({
        name: 'report.build',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: { rows: 'x'.repeat(50_000) },
      }))
      ?.finishResult(null);
    await Promise.resolve();
    await Promise.resolve();

    // Asking for values is not asking for an unbounded copy of every argument forever.
    expect(seen[0]?.arguments).toEqual({ observed: 'tooLarge', limit: 4_096 });
  });

  it('reports a value that cannot be serialized rather than throwing', async () => {
    const { bus, seen } = collect(OBSERVED_PAYLOADS.values);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    bus
      .beginIfObserved(() => ({
        name: 'graph.walk',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
        arguments: cyclic,
      }))
      ?.finishResult(() => 'a function is not data');
    await Promise.resolve();
    await Promise.resolve();

    expect(seen[0]?.arguments).toEqual({ observed: 'unserializable' });
    const terminal = seen.find((event) => event.phase === CALL_PHASE.result);
    expect(terminal?.result).toEqual({ observed: 'unserializable' });
  });
});
