import { describe, expect, it } from 'vitest';
import {
  CALL_ROUTE,
  FAILURE_VOCABULARY,
  OBSERVED_PAYLOADS,
  type ObservedCall,
} from '../../../src/runtime/call-record.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/errors.ts';
import { createObservationBus } from '../../../src/runtime/observation.ts';

// The leak paths a FILTERING design would have missed, closed by the projector's SHAPE instead.
//
// A review of this feature's foundation enumerated six ways a value reaches an observer without anyone
// putting it there deliberately. Five of them are the same mistake wearing different clothes: a
// human-readable message built somewhere else and copied into a record.
//
//   - a schema validator's `reason` string — a custom validator may quote the offending value;
//   - the registry route's validation message, which interpolates that same reason;
//   - an output-validation reason, which may quote the RESULT;
//   - `ToolCallResult.content[].text`, which on success IS the serialized result;
//   - a handler's own error message, stack or `cause` — text the refusal channel already refuses to
//     publish.
//
// The sixth is a secret encoded in an argument KEY, covered in the projector's own suite.
//
// **None of these is defended against by filtering, because a filter has to be given the string
// first.** They are defended against by the projector never accepting one: `CallFacts` carries a name,
// a route, a timestamp and the raw arguments, and a failure is `{ vocabulary, code }` with no free-text
// field anywhere. A site that wanted to attach a diagnostic message would have to change these types,
// which is a review-visible act rather than an accident.

describe('the record has nowhere to put free text', () => {
  it('accepts a failure as a code from a closed vocabulary, and nothing more', async () => {
    const seen: ObservedCall[] = [];
    const bus = createObservationBus({
      payloads: () => OBSERVED_PAYLOADS.metadata,
      onConsumerFailure: () => {},
    });
    bus.subscribe((event) => seen.push(event));

    bus
      .beginIfObserved(() => ({
        name: 'invoice.mark_paid',
        route: CALL_ROUTE.bridge,
        startedAt: 1,
      }))
      ?.finishError({
        vocabulary: FAILURE_VOCABULARY.runtime,
        code: RUNTIME_FAILURE.argumentsInvalid,
      });
    await Promise.resolve();
    await Promise.resolve();

    const failure = seen.at(-1)?.failure;
    expect(failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.argumentsInvalid,
    });
    // The assertion that matters: exactly two keys. A `message`, `reason`, `detail` or `text` added
    // here is where every one of the five leak paths above would arrive.
    expect(Object.keys(failure as object).sort()).toEqual(['code', 'vocabulary']);
  });

  it('reports an application throw as UNCODED rather than borrowing a code', async () => {
    const seen: ObservedCall[] = [];
    const bus = createObservationBus({
      payloads: () => OBSERVED_PAYLOADS.metadata,
      onConsumerFailure: () => {},
    });
    bus.subscribe((event) => seen.push(event));

    bus
      .beginIfObserved(() => ({ name: 'report.build', route: CALL_ROUTE.bridge, startedAt: 1 }))
      ?.finishError({ vocabulary: FAILURE_VOCABULARY.uncoded });
    await Promise.resolve();
    await Promise.resolve();

    // An application handler that throws may carry no code of ours. Giving it a borrowed one would
    // tell an operator that a CHECK refused the call when the application simply failed — and would
    // send them to read a gate that never ran.
    expect(seen.at(-1)?.failure).toEqual({ vocabulary: FAILURE_VOCABULARY.uncoded });
  });

  it('has no field on the whole record that a diagnostic string could occupy', async () => {
    const seen: ObservedCall[] = [];
    const bus = createObservationBus({
      payloads: () => OBSERVED_PAYLOADS.metadata,
      onConsumerFailure: () => {},
    });
    bus.subscribe((event) => seen.push(event));

    bus
      .beginIfObserved(() => ({
        name: 'customers.set_filters',
        route: CALL_ROUTE.registry,
        startedAt: 1,
        arguments: { status: 'active' },
      }))
      ?.finishResult({ matched: 16 });
    await Promise.resolve();
    await Promise.resolve();

    // Every key a record can carry, enumerated. `name` is an identifier the caller already holds — it
    // came from the listing this library published — so naming it discloses nothing, which is the
    // distinction the refusal channel already draws, and this one inherits.
    const permitted = new Set([
      'phase',
      'callId',
      'name',
      'route',
      'startedAt',
      'settledAt',
      'gates',
      'resolution',
      'failure',
      'arguments',
      'result',
    ]);
    for (const event of seen) {
      for (const key of Object.keys(event)) {
        expect(permitted.has(key)).toBe(true);
      }
    }
  });
});
