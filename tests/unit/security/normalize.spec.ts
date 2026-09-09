import { describe, expect, it } from 'vitest';
import {
  admitsLevel,
  CAPABILITY_PROBLEM,
  CONTROL_LEVEL,
  capabilitySignature,
  DENIES_EVERYTHING,
  DOM_AUTHORITY,
  describeProblems,
  normalizeCapabilities,
} from '../../../src/security/index.ts';

// What an application handed the provider, checked at the boundary it crosses.
//
// **The two rules here point in opposite directions, and a suite that tested only one would look
// complete.** An omitted member is denied silently; an unknown member is refused loudly. Get the first
// wrong and every capability set an author writes is rejected for saying nothing about a member they
// have never heard of. Get the second wrong and a typo grants nothing while its author believes it
// granted something — which is the failure this feature exists to prevent, arriving through the prop
// rather than through a gate.
//
// Written against `normalizeCapabilities` directly rather than through a provider, because this is a
// pure function over a value and the whole input space is reachable from a table. The provider's own
// behaviour — what it does with a refusal — is asserted where the provider is.

/** A complete, ordinary set: the shape the documentation recommends. */
const COMPLETE = {
  application: true,
  dom: { inspect: false, interact: false },
  evaluate: false,
};

function problemsOf(input: unknown): { problem: string; at: string }[] {
  const outcome = normalizeCapabilities(input);
  if (outcome.ok) throw new Error('expected the set to be refused, and it was accepted');
  return outcome.problems.map(({ problem, at }) => ({ problem, at }));
}

function acceptedAs(input: unknown): unknown {
  const outcome = normalizeCapabilities(input);
  if (!outcome.ok) {
    throw new Error(`expected the set to be accepted: ${describeProblems(outcome.problems)}`);
  }
  return outcome.capabilities;
}

describe('a set that says everything', () => {
  it('passes through with every member as written', () => {
    expect(acceptedAs(COMPLETE)).toEqual(COMPLETE);
  });

  it('is not confused by key order', () => {
    expect(
      acceptedAs({ evaluate: false, dom: { interact: false, inspect: false }, application: true }),
    ).toEqual(COMPLETE);
  });
});

describe('a member the author omitted', () => {
  // There is no default profile and authority only narrows: an absent member is DENIED, never
  // defaulted on (`docs/reference-capabilities.md#the-shape`). It is also not an ERROR — an author who
  // wrote nothing about `evaluate` has said the only thing that matters about it.

  it('is denied, and draws no complaint', () => {
    expect(acceptedAs({ application: true })).toEqual({
      application: true,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });
  });

  it('denies half a pair without denying the other', () => {
    expect(acceptedAs({ application: false, dom: { inspect: true } })).toEqual({
      application: false,
      dom: { inspect: true, interact: false },
      evaluate: false,
    });
  });

  it('denies everything when the author wrote an empty set', () => {
    // The pairing for the case above. A normalizer that filled absences with `true` would pass every
    // "grant" case in this file and fail only here.
    expect(acceptedAs({})).toEqual({
      application: false,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });
  });
});

describe('a member nobody has ever heard of', () => {
  // The loud half. Ignoring an unknown key would leave an author believing they granted something —
  // and would make every capability added in a future version silently inert on pages written today.

  it('is refused, and named by its key', () => {
    expect(problemsOf({ ...COMPLETE, storage: true })).toEqual([
      { problem: CAPABILITY_PROBLEM.unknownMember, at: 'storage' },
    ]);
  });

  it('is refused inside the DOM pair too', () => {
    expect(problemsOf({ ...COMPLETE, dom: { inspect: true, scroll: true } })).toEqual([
      { problem: CAPABILITY_PROBLEM.unknownMember, at: 'dom.scroll' },
    ]);
  });

  it('takes the whole set down with it, rather than yielding the members that were understood', () => {
    // An unresolvable set denies as a whole. A partially-understood set is a hidden unknown — the page
    // would run under capabilities nobody wrote down.
    expect(normalizeCapabilities({ application: true, storage: true }).ok).toBe(false);
  });
});

describe('a member that is present and is not a boolean', () => {
  it('is refused rather than coerced', () => {
    expect(problemsOf({ ...COMPLETE, application: 'yes' })).toEqual([
      { problem: CAPABILITY_PROBLEM.notABoolean, at: 'application' },
    ]);
  });

  it('is refused inside the pair, with its path', () => {
    expect(problemsOf({ ...COMPLETE, dom: { inspect: 1, interact: false } })).toEqual([
      { problem: CAPABILITY_PROBLEM.notABoolean, at: 'dom.inspect' },
    ]);
  });
});

describe('`dom: true` — a boolean cannot say which half it grants', () => {
  it('is refused, never read as granting both halves', () => {
    // The dangerous reading. An author writing `dom: true` means "let it look at the page"; admitting
    // it under the pair would also grant `interact`, which is the one confusion the pair exists to
    // make impossible.
    expect(problemsOf({ ...COMPLETE, dom: true })).toEqual([
      { problem: CAPABILITY_PROBLEM.notAnObject, at: 'dom' },
    ]);
  });
});

describe('something that is not a capability set at all', () => {
  it.each([
    ['null', null],
    ['an array', [{ application: true }]],
    ['a string', 'application'],
    ['a boolean', true],
    ['nothing', undefined],
  ])('refuses %s', (_label, input) => {
    expect(problemsOf(input)).toEqual([{ problem: CAPABILITY_PROBLEM.notAnObject, at: '' }]);
  });
});

describe('an author with more than one mistake', () => {
  it('is told about all of them at once', () => {
    // Not the first one thrown. Fixing a typo only to discover the next one is how an author ends up
    // reaching for a cast to make the prop compile, which is the outcome this check exists to prevent.
    expect(problemsOf({ application: 'yes', storage: true, dom: { scroll: true } })).toEqual([
      { problem: CAPABILITY_PROBLEM.unknownMember, at: 'storage' },
      { problem: CAPABILITY_PROBLEM.notABoolean, at: 'application' },
      { problem: CAPABILITY_PROBLEM.unknownMember, at: 'dom.scroll' },
    ]);
  });
});

describe('what the refusal is allowed to say', () => {
  // The redaction rule reaches here too. A capability set is written by an author rather
  // than sent by an agent, but it is the sort of object a credential gets pasted into by mistake, and
  // this text reaches a console, an operator's alarm destination and whatever collects them.

  it('names the key and never the value', () => {
    const outcome = normalizeCapabilities({ ...COMPLETE, application: 'sk-ant-SECRETKEY' });
    if (outcome.ok) throw new Error('expected a refusal');
    const text = describeProblems(outcome.problems);

    expect(text).toContain('application');
    expect(text).not.toContain('sk-ant-SECRETKEY');
  });

  it('says which key was not a capability, so the author can find it', () => {
    // The pairing. A message that redacted everything would satisfy the case above and tell an author
    // nothing they could act on.
    const outcome = normalizeCapabilities({ ...COMPLETE, evalaute: true });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(describeProblems(outcome.problems)).toContain('evalaute');
  });
});

describe("a member that is not the object's own", () => {
  // **Found by an adversarial review, which probed it directly rather than reading the code.** The
  // unknown-member scan walks `Object.keys` — own and enumerable — while a plain index read follows
  // the prototype chain. Those two disagreeing is a capability arriving from a place nothing checks.
  //
  // Reachable by a capability set built with `Object.create`, produced by a class with getters, or
  // merged through a prototype by a configuration library. Not common, and the direction it failed in
  // is the one that matters: a grant that no scan ever saw.

  it('is not granted, because the scan that checks members never saw it either', () => {
    const inherited = Object.create({ application: true, evaluate: true }) as object;
    expect(acceptedAs(inherited)).toEqual({
      application: false,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });
  });

  it('is not granted inside the DOM pair either', () => {
    expect(acceptedAs({ dom: Object.create({ inspect: true }) })).toEqual({
      application: false,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });
  });

  it('still grants what the object owns, so the rule is about inheritance and not about refusing', () => {
    // The pairing. A normalizer that had started denying everything would satisfy both cases above.
    const own = Object.assign(Object.create({ evaluate: true }), { application: true }) as object;
    expect(acceptedAs(own)).toEqual({
      application: true,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });
  });
});

describe('a set that will not answer', () => {
  // **Found by an adversarial review, which built the object rather than reading the code.** Reading a
  // property runs application code: a getter can throw, and a proxy can refuse to enumerate. Before
  // this, the throw escaped the normalizer — whose own header says it never throws — travelled up
  // through the provider's render, and carried the application's message with it.
  //
  // Two things had to be true and neither was: the module keeps its contract, and nothing an
  // application produced is repeated by this library.

  it('refuses a member whose getter throws, instead of letting the throw escape', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'application', {
      enumerable: true,
      get() {
        throw new Error('hunter2-secret');
      },
    });

    expect(problemsOf(hostile)).toEqual([
      { problem: CAPABILITY_PROBLEM.unreadable, at: 'application' },
    ]);
  });

  it('names the member that would not be read, and nothing the throw carried', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'application', {
      enumerable: true,
      get() {
        throw new Error('hunter2-secret');
      },
    });

    const outcome = normalizeCapabilities(hostile);
    if (outcome.ok) throw new Error('expected a refusal');
    const text = describeProblems(outcome.problems);

    expect(text).toContain('application');
    expect(text).not.toContain('hunter2-secret');
  });

  it('refuses an object that will not even be enumerated', () => {
    // The other half: the failure that happens before any member is reached, which the per-member
    // guard cannot see. Without the outer guard this throws out of the normalizer.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('sk-ant-SECRETKEY');
        },
      },
    );

    expect(problemsOf(hostile)).toEqual([{ problem: CAPABILITY_PROBLEM.unreadable, at: '' }]);
  });

  it('still reads an ordinary getter that answers, so the rule is about throwing and not about getters', () => {
    // The pairing. A normalizer that refused every accessor would satisfy all three cases above and
    // would reject a perfectly reasonable configuration object.
    const computed = {};
    Object.defineProperty(computed, 'application', {
      enumerable: true,
      get: () => true,
    });

    expect(acceptedAs(computed)).toEqual({
      application: true,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });
  });
});

describe('the set that admits nothing', () => {
  it('admits nothing, at every level', () => {
    // Asserted against the decision rather than by reading its fields, because what matters about this
    // value is what a gate does with it. A member added to the shape and forgotten here would be
    // caught by the level below rather than by a field comparison that was never updated.
    expect(admitsLevel(DENIES_EVERYTHING, CONTROL_LEVEL.application).admitted).toBe(false);
    expect(admitsLevel(DENIES_EVERYTHING, CONTROL_LEVEL.dom, DOM_AUTHORITY.inspect).admitted).toBe(
      false,
    );
    expect(admitsLevel(DENIES_EVERYTHING, CONTROL_LEVEL.dom, DOM_AUTHORITY.interact).admitted).toBe(
      false,
    );
    expect(admitsLevel(DENIES_EVERYTHING, CONTROL_LEVEL.evaluate).admitted).toBe(false);
  });

  it('cannot be widened by whoever is holding it', () => {
    // It is the value a boundary holds while it has no usable set, and it is shared. A caller that
    // could write to it would be granting a capability to every other holder at once.
    expect(Object.isFrozen(DENIES_EVERYTHING)).toBe(true);
    expect(Object.isFrozen(DENIES_EVERYTHING.dom)).toBe(true);
  });
});

describe('the signature a renderer depends on', () => {
  // What it is for: `capabilities={{ ... }}` is a new object on every render, so an effect keyed on
  // the object fires constantly, and one keyed on nothing never fires. The signature is the granted
  // set's VALUE.

  it('is the same for two sets that grant the same things, whatever order they were written in', () => {
    expect(capabilitySignature(acceptedAs(COMPLETE) as never)).toBe(
      capabilitySignature(
        acceptedAs({
          evaluate: false,
          application: true,
          dom: { interact: false, inspect: false },
        }) as never,
      ),
    );
  });

  it.each([
    ['application', { ...COMPLETE, application: false }],
    ['dom.inspect', { ...COMPLETE, dom: { inspect: true, interact: false } }],
    ['dom.interact', { ...COMPLETE, dom: { inspect: false, interact: true } }],
    ['evaluate', { ...COMPLETE, evaluate: true }],
  ])('changes when %s changes', (_member, changed) => {
    // **Every member, one case each, and that is the point of the table.** A signature that omitted a
    // member would be a capability whose change never reaches the agent: it would be granted, the
    // listing would go on describing the old state, and nothing anywhere would say so. Only the case
    // for the omitted member goes red.
    expect(capabilitySignature(acceptedAs(changed) as never)).not.toBe(
      capabilitySignature(acceptedAs(COMPLETE) as never),
    );
  });
});
