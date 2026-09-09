import { describe, expect, it } from 'vitest';
import { allStepsNotRun, GATE_OUTCOME, nextCallId } from '../../../src/runtime/call-record.ts';
import { GATE_CHAIN } from '../../../src/runtime/gate-chain.ts';

// The counter behind `callId`, and the two things it must not be mistaken for.
//
// It correlates a start with its terminal, and that is all. It needs no source of randomness, which is
// the whole reason it is a counter: `src/page-identity.ts` is the only file permitted to name the
// platform's unique-value source, enforced by a seam case, because a second mint site is a second
// chance to add a fallback and a fallback cannot be told from success.

describe('the call counter', () => {
  it('is monotonic and never repeats', () => {
    const issued = Array.from({ length: 200 }, () => nextCallId());
    expect(new Set(issued).size).toBe(issued.length);
    for (let index = 1; index < issued.length; index += 1) {
      expect(issued[index]).toBeGreaterThan(issued[index - 1] as number);
    }
  });

  it('does not restart when a provider would remount', () => {
    // Module-scoped for exactly this reason. A provider-scoped counter would restart at 1 on a
    // remount, and two records in one retained ring would then share an identity — a correlation that
    // is wrong looks exactly like one that is right, which is this project's characteristic defect.
    const before = nextCallId();
    // Nothing here resets module state, which IS the property: a remount does not reach the counter.
    const after = nextCallId();
    expect(after).toBeGreaterThan(before);
  });

  it('is a number, so it cannot stand in for the page instance identity', () => {
    // A tab id is a string that names a page; a call id is an ordinal that names a call. Confusing the
    // two is a named forbidden pattern here, and the shape is what makes the confusion impossible to
    // make accidentally — a number cannot be passed where the string identity is expected.
    //
    // Deliberately NOT compared against a real `pageInstanceId()`: minting one needs a document, and
    // this unit is not the document boundary. Declaring `// @vitest-environment jsdom` to reach for a
    // value this case does not need would make the counter look like it depends on a DOM. The
    // cross-check that they never collide belongs where an identity legitimately exists.
    expect(typeof nextCallId()).toBe('number');
  });
});

describe('the starting point a site refines', () => {
  it('reports every step of the chain as not run', () => {
    const gates = allStepsNotRun();
    expect(gates).toHaveLength(GATE_CHAIN.length);
    expect(gates.every((gate) => gate.outcome === GATE_OUTCOME.notRun)).toBe(true);
  });

  it('is built FROM the chain, so a new step cannot be silently omitted', () => {
    // The property that matters: a step added to `GATE_CHAIN` appears here without anyone remembering
    // to add it. A hand-listed baseline would leave the new step absent from every record, and an
    // absent step reads to a consumer as one that passed.
    expect(allStepsNotRun().map((gate) => gate.step)).toEqual(GATE_CHAIN.map((step) => step.name));
  });
});
