import { describe, expect, it } from 'vitest';
import { GATE_CHAIN } from '../../../src/runtime/gate-chain.ts';

// That the gate chain can actually be DERIVED FROM, rather than merely read.
//
// **Written because the constant could not be derived from at all, and looked like it could.** It was
// annotated `readonly GateStep[]`, whose `name` is `string` — so `(typeof GATE_CHAIN)[number]['name']`
// widened to `string`, and a record claiming to be "keyed off the gate chain" would have compiled with
// a step missing, a step invented, or a name misspelled. A closed set is declared once and membership
// is DERIVED from it; an annotation that erases the members satisfies the letter and none of the point.
//
// The fix is `as const satisfies readonly GateStep[]`: the same constraint is still checked, and the
// seven literals survive. These cases are what stop that being reverted to an annotation by someone
// tidying up — the type-level ones fail at COMPILE time, which is where the defect would have lived.
//
// **The break-it was run, and it bites in `pnpm typecheck` and NOWHERE ELSE.** Reverting the constant
// to its annotation leaves this file GREEN under `pnpm test`: Vitest strips types through esbuild
// without checking them, so `@ts-expect-error` is inert at runtime and all four cases still pass. It
// is `tsc` that reports `TS2578: Unused '@ts-expect-error' directive` on the two lines below.
//
// Recorded rather than left implied, because the obvious reading of a green suite here is wrong: these
// cases are held by the typecheck step of the health gate, not by the test step, and anyone who runs
// only `pnpm test` after touching `gate-chain.ts` has verified nothing about this file.

type StepName = (typeof GATE_CHAIN)[number]['name'];

describe('the gate chain as a derivable source', () => {
  it('preserves each step name as a literal type', () => {
    // Compile-time assertions. If `name` widens back to `string`, the @ts-expect-error lines below
    // stop erroring and THIS FILE fails to compile — which is the failure mode we want, because a
    // runtime check cannot see the difference between `string` and a union of seven literals.
    const admitted: StepName = 'capability';
    expect(GATE_CHAIN.some((step) => step.name === admitted)).toBe(true);
  });

  it('refuses a misspelled step at compile time', () => {
    // @ts-expect-error 'capabilty' is a typo and must not be assignable to the step-name union
    const misspelled: StepName = 'capabilty';
    // Referenced so the binding is not merely unused, and asserted against the real chain so the
    // runtime agrees with what the type says.
    expect(GATE_CHAIN.some((step) => step.name === misspelled)).toBe(false);
  });

  it('refuses a step this library does not have', () => {
    // @ts-expect-error there is no 'redact' step; inventing one must not type-check
    const invented: StepName = 'redact';
    expect(GATE_CHAIN.some((step) => step.name === invented)).toBe(false);
  });

  it('still carries exactly the seven steps, in order', () => {
    // The `satisfies` change must not have altered the value. Ordering is a requirement rather than an
    // implementation detail — each step assumes the ones before it succeeded.
    expect(GATE_CHAIN.map((step) => step.name)).toEqual([
      'authenticate',
      'resolve',
      'capability',
      'policy',
      'validate',
      'confirm',
      'invoke',
    ]);
    expect(GATE_CHAIN.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
