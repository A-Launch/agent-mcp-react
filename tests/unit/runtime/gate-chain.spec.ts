import { describe, expect, it } from 'vitest';
import {
  builtSteps,
  GATE_CHAIN,
  GATE_STEP_STATE,
  unbuiltSteps,
} from '../../../src/runtime/gate-chain.ts';

// The chain, asserted as a description rather than as behaviour.
//
// These cases exist for a reader who arrives later and asks "are arguments validated before a handler
// runs?" — a question whose wrong answer is expensive and whose honest answer today is no. They also
// exist to fail: the day someone lands the capability model or schema validation without marking its
// step built, the counts below stop matching and the omission surfaces immediately rather than at the
// next security review.

describe('the chain describes all seven steps, in order', () => {
  it('names every step exactly once, numbered consecutively from one', () => {
    expect(GATE_CHAIN.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(GATE_CHAIN.map((step) => step.name)).size).toBe(GATE_CHAIN.length);
  });

  it('says what each step decides, so an unbuilt one states what is missing', () => {
    for (const step of GATE_CHAIN) {
      expect(
        step.decides.length,
        `step "${step.name}" does not say what it decides`,
      ).toBeGreaterThan(20);
    }
  });
});

describe('which steps are built is a fact the repository states about itself', () => {
  it('has every step built except the one enforced elsewhere', () => {
    // This is the assertion that turns red when a later feature lands a step without wiring it in.
    // It is deliberately exact rather than "at least two".
    expect(builtSteps().map((step) => step.name)).toEqual([
      'resolve',
      'capability',
      'policy',
      'validate',
      'confirm',
      'invoke',
    ]);
  });

  it('has no unbuilt steps left', () => {
    // Each step left this list in the commit that BUILT it, not in a later tidying pass — under-
    // claiming is the safe direction and it is still a constant a reader learns to distrust.
    //
    // The chain is now complete except for `authenticate`, which is `elsewhere` rather than unbuilt:
    // it happens at the socket upgrade, before this runtime exists, where the gateway redeems the
    // ticket (`docs/design.md#authentication`).
    expect(unbuiltSteps()).toEqual([]);
  });

  it('says what `policy` actually decides in this build, rather than only naming it', () => {
    // `policy` is the vaguest name in the chain and the one most likely to be read as covering more
    // than it does. In this build it is AVAILABILITY, and confirmation is its own step — a reader who
    // assumed otherwise would believe a confirmation-required tool was already gated.
    const policy = GATE_CHAIN.find((step) => step.name === 'policy');
    expect(policy?.decides).toContain('AVAILABILITY');
  });

  it('places authentication outside this chain rather than pretending to run it', () => {
    // It happens at the socket upgrade, before this runtime exists. Listing it as `built` would claim
    // a check this module performs; omitting it would leave the chain an incomplete description.
    const authenticate = GATE_CHAIN.find((step) => step.name === 'authenticate');
    expect(authenticate?.state).toBe(GATE_STEP_STATE.elsewhere);
  });
});

describe('an unbuilt step admits nothing, because it decides nothing', () => {
  it('carries no callable member a chain could invoke', () => {
    // The failure this guards against is a permissive placeholder — a step present in the chain that
    // returns "allowed" until its real check arrives. That is worse than an absent step, because it
    // looks like a gate and reads as one in review.
    for (const step of unbuiltSteps()) {
      for (const [key, value] of Object.entries(step)) {
        expect(
          typeof value,
          `unbuilt step "${step.name}" has a callable member "${key}" — an unbuilt step must not participate in admitting a call`,
        ).not.toBe('function');
      }
    }
  });

  it('is data a reader and a test can see, and nothing the runtime branches on', () => {
    for (const step of unbuiltSteps()) {
      expect(Object.keys(step).sort()).toEqual(['decides', 'name', 'order', 'state']);
    }
  });
});
