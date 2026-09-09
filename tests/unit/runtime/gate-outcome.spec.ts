import { describe, expect, it } from 'vitest';
import {
  CALL_PHASE,
  CALL_ROUTE,
  GATE_OUTCOME,
  isCallPhase,
  isCallRoute,
  isGateOutcome,
  isResolutionRefusal,
} from '../../../src/runtime/call-record.ts';
import { GATE_STEP_STATE } from '../../../src/runtime/gate-chain.ts';
import { RESOLUTION } from '../../../src/runtime/resolution.ts';

// That a per-CALL gate outcome and a per-BUILD gate step state stay two different things.
//
// **This case exists because merging them looks like a tidy reuse and is a category error.**
// `GATE_STEP_STATE` answers "has this repository implemented that step" — it is a fact about the
// build, identical for every call that ever runs. `GATE_OUTCOME` answers "what did that step do for
// THIS call". A call arriving through the page's registry route skips a step that is fully `built`;
// recording that as `unbuilt` would assert this repository had not implemented it, and an operator
// reading the record would go looking for an unfinished feature instead of a route that has no gate.
//
// The temptation will recur — the two sets are both small, both about gate steps, and one is already
// exported from the same directory. So the disjointness is asserted rather than left to a reviewer.

describe('the two gate vocabularies', () => {
  it('share no member', () => {
    const outcomes = new Set<string>(Object.values(GATE_OUTCOME));
    const states = new Set<string>(Object.values(GATE_STEP_STATE));
    const shared = [...outcomes].filter((member) => states.has(member));
    expect(shared).toEqual([]);
  });

  it('does not admit a build state as a call outcome', () => {
    for (const state of Object.values(GATE_STEP_STATE)) {
      expect(isGateOutcome(state)).toBe(false);
    }
  });

  it('names exactly the three outcomes a call can produce', () => {
    expect(Object.values(GATE_OUTCOME).sort()).toEqual(['notRun', 'passed', 'refused']);
  });
});

describe('membership derived from each dictionary', () => {
  it('admits every declared member and nothing else', () => {
    for (const value of Object.values(GATE_OUTCOME)) expect(isGateOutcome(value)).toBe(true);
    for (const value of Object.values(CALL_ROUTE)) expect(isCallRoute(value)).toBe(true);
    for (const value of Object.values(CALL_PHASE)) expect(isCallPhase(value)).toBe(true);

    expect(isGateOutcome('admitted')).toBe(false);
    expect(isCallRoute('socket')).toBe(false);
    expect(isCallPhase('settled')).toBe(false);
  });
});

describe('the resolution refusal subset', () => {
  it('excludes the two resolutions that SUCCEED', () => {
    // The correction that prompted this case: `RESOLUTION` has five members, and an early draft of
    // this feature called it a three-member set. `builtIn` and `owned` are successful resolutions and
    // can never be why a call was refused — a record carrying one would name a success as a cause.
    expect(isResolutionRefusal(RESOLUTION.builtIn)).toBe(false);
    expect(isResolutionRefusal(RESOLUTION.owned)).toBe(false);
  });

  it('admits exactly the three that end a call', () => {
    expect(isResolutionRefusal(RESOLUTION.unknown)).toBe(true);
    expect(isResolutionRefusal(RESOLUTION.foreign)).toBe(true);
    expect(isResolutionRefusal(RESOLUTION.diverged)).toBe(true);
  });

  it('is DERIVED from RESOLUTION, so a sixth member cannot be silently missing', () => {
    // Not a restatement of the assertions above. Those name three members; this one says the subset
    // and the source agree in SIZE — so a member added to `RESOLUTION` shows up here as a failure
    // rather than as a quietly unclassifiable cause.
    const admitted = Object.values(RESOLUTION).filter((member) => isResolutionRefusal(member));
    expect(admitted).toHaveLength(Object.values(RESOLUTION).length - 2);
  });
});
