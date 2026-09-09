import { describe, expect, it } from 'vitest';
import {
  admitsAvailability,
  admitsLevel,
  type DeclaredPermissions,
  needsConfirmation,
} from '../../../src/security/resolve.ts';
import {
  type AgentCapabilities,
  CONTROL_LEVEL,
  type ControlLevel,
  DOM_AUTHORITY,
  type DomAuthority,
  REFUSED_BECAUSE,
} from '../../../src/security/vocabulary.ts';

// The capability decision, as a table.
//
// **Why a table and not a handful of examples.** The claim this module makes is a NEGATIVE one about
// every pair — no capability confers any other — and a claim about every pair is only established by
// enumerating them. A suite of three or four illustrative cases would stay green under an
// implementation that admitted DOM whenever `application` was on, which is the single most plausible
// way to get this wrong.
//
// The matrix below is the `capability-model` skill's scenario matrix, written so that a change to
// either has to be made in both.

/** The three profiles the capability reference names, which are the ones an operator actually picks. */
const READ_ONLY: AgentCapabilities = {
  application: true,
  dom: { inspect: true, interact: false },
  evaluate: false,
};
const STANDARD_AGENT: AgentCapabilities = {
  application: true,
  dom: { inspect: true, interact: true },
  evaluate: false,
};
const DEVELOPER_AGENT: AgentCapabilities = {
  application: true,
  dom: { inspect: true, interact: true },
  evaluate: true,
};
/** Nothing granted. Not a profile anyone ships — the floor every other row is measured against. */
const NOTHING: AgentCapabilities = {
  application: false,
  dom: { inspect: false, interact: false },
  evaluate: false,
};

interface Row {
  readonly profile: string;
  readonly capabilities: AgentCapabilities;
  readonly level: ControlLevel;
  readonly domAuthority?: DomAuthority;
  readonly admitted: boolean;
}

const MATRIX: readonly Row[] = [
  // Level 1.
  { profile: 'nothing', capabilities: NOTHING, level: CONTROL_LEVEL.application, admitted: false },
  {
    profile: 'read-only',
    capabilities: READ_ONLY,
    level: CONTROL_LEVEL.application,
    admitted: true,
  },
  {
    profile: 'standard',
    capabilities: STANDARD_AGENT,
    level: CONTROL_LEVEL.application,
    admitted: true,
  },
  {
    profile: 'developer',
    capabilities: DEVELOPER_AGENT,
    level: CONTROL_LEVEL.application,
    admitted: true,
  },

  // Level 2, read half.
  {
    profile: 'nothing',
    capabilities: NOTHING,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.inspect,
    admitted: false,
  },
  {
    profile: 'read-only',
    capabilities: READ_ONLY,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.inspect,
    admitted: true,
  },
  {
    profile: 'standard',
    capabilities: STANDARD_AGENT,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.inspect,
    admitted: true,
  },
  {
    profile: 'developer',
    capabilities: DEVELOPER_AGENT,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.inspect,
    admitted: true,
  },

  // Level 2, write half. The read-only row is the whole reason `dom` is a pair.
  {
    profile: 'nothing',
    capabilities: NOTHING,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.interact,
    admitted: false,
  },
  {
    profile: 'read-only',
    capabilities: READ_ONLY,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.interact,
    admitted: false,
  },
  {
    profile: 'standard',
    capabilities: STANDARD_AGENT,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.interact,
    admitted: true,
  },
  {
    profile: 'developer',
    capabilities: DEVELOPER_AGENT,
    level: CONTROL_LEVEL.dom,
    domAuthority: DOM_AUTHORITY.interact,
    admitted: true,
  },

  // Level 3. Only the developer profile, and only because it says so.
  { profile: 'nothing', capabilities: NOTHING, level: CONTROL_LEVEL.evaluate, admitted: false },
  { profile: 'read-only', capabilities: READ_ONLY, level: CONTROL_LEVEL.evaluate, admitted: false },
  {
    profile: 'standard',
    capabilities: STANDARD_AGENT,
    level: CONTROL_LEVEL.evaluate,
    admitted: false,
  },
  {
    profile: 'developer',
    capabilities: DEVELOPER_AGENT,
    level: CONTROL_LEVEL.evaluate,
    admitted: true,
  },
];

function describeRow(row: Row): string {
  const what =
    row.domAuthority === undefined ? `level ${String(row.level)}` : `dom.${row.domAuthority}`;
  return `${row.profile} ${row.admitted ? 'admits' : 'refuses'} ${what}`;
}

describe('the capability matrix', () => {
  for (const row of MATRIX) {
    it(describeRow(row), () => {
      const decision = admitsLevel(row.capabilities, row.level, row.domAuthority);
      expect(decision.admitted).toBe(row.admitted);
      if (!decision.admitted) {
        expect(decision.because).toBe(REFUSED_BECAUSE.capabilityDenied);
      }
    });
  }

  it('covers every profile against every level', () => {
    // The count is the assertion. A row deleted while refactoring is a pair that stops being checked,
    // and nothing else here would notice: the remaining rows would all still pass.
    expect(MATRIX).toHaveLength(16);
  });
});

describe('one capability confers nothing on another', () => {
  // These are the same facts the matrix carries, stated as the CLAIM rather than as coordinates — so
  // a reader who wants to know whether `application` implies DOM finds the answer by its name.

  it('application does not admit DOM', () => {
    const onlyApplication: AgentCapabilities = {
      application: true,
      dom: { inspect: false, interact: false },
      evaluate: false,
    };
    expect(admitsLevel(onlyApplication, CONTROL_LEVEL.application).admitted).toBe(true);
    expect(admitsLevel(onlyApplication, CONTROL_LEVEL.dom, DOM_AUTHORITY.inspect).admitted).toBe(
      false,
    );
  });

  it('reading the page does not admit acting on it', () => {
    expect(admitsLevel(READ_ONLY, CONTROL_LEVEL.dom, DOM_AUTHORITY.inspect).admitted).toBe(true);
    expect(admitsLevel(READ_ONLY, CONTROL_LEVEL.dom, DOM_AUTHORITY.interact).admitted).toBe(false);
  });

  it('nothing short of evaluate admits Level 3', () => {
    expect(admitsLevel(STANDARD_AGENT, CONTROL_LEVEL.evaluate).admitted).toBe(false);
  });

  it('evaluate does not admit DOM interaction on its own', () => {
    // The pairing for the row above, in the other direction. A model that treated `evaluate` as the
    // top of a ladder would admit everything below it — which is the natural reading of "privileged"
    // and is not how the levels work: one level confers nothing on another
    // (`docs/reference-capabilities.md#the-three-levels`).
    const onlyEvaluate: AgentCapabilities = {
      application: false,
      dom: { inspect: false, interact: false },
      evaluate: true,
    };
    expect(admitsLevel(onlyEvaluate, CONTROL_LEVEL.evaluate).admitted).toBe(true);
    expect(admitsLevel(onlyEvaluate, CONTROL_LEVEL.dom, DOM_AUTHORITY.interact).admitted).toBe(
      false,
    );
    expect(admitsLevel(onlyEvaluate, CONTROL_LEVEL.application).admitted).toBe(false);
  });
});

describe('a decision that cannot be computed', () => {
  it('refuses a control level outside the closed set', () => {
    // Reachable only by a value that was cast rather than checked, which is exactly when a fall-through
    // to "admitted" would be worst. Authority only narrows and an unexpected state fails loud, so an
    // undeterminable decision DENIES.
    const notALevel = 99 as unknown as ControlLevel;
    expect(admitsLevel(DEVELOPER_AGENT, notALevel).admitted).toBe(false);
  });

  it('refuses a DOM tool that did not say which half it needs', () => {
    // The pairing with the two DOM rows: a tool that names its half is admitted by that half. One that
    // names none cannot be admitted by the weaker one, or a future tool lands in the wrong half
    // silently.
    expect(admitsLevel(DEVELOPER_AGENT, CONTROL_LEVEL.dom).admitted).toBe(false);
    expect(admitsLevel(DEVELOPER_AGENT, CONTROL_LEVEL.dom, DOM_AUTHORITY.interact).admitted).toBe(
      true,
    );
  });
});

describe('availability', () => {
  const cases: ReadonlyArray<[string, DeclaredPermissions | undefined, boolean]> = [
    ['no permissions declared at all', undefined, true],
    ['permissions with nothing about availability', {}, true],
    ['explicitly available', { available: true }, true],
    ['explicitly unavailable', { available: false }, false],
  ];

  for (const [what, permissions, admitted] of cases) {
    it(`${what} → ${admitted ? 'admitted' : 'refused'}`, () => {
      const decision = admitsAvailability(permissions);
      expect(decision.admitted).toBe(admitted);
      if (!decision.admitted) expect(decision.because).toBe(REFUSED_BECAUSE.unavailable);
    });
  }

  it('treats absence as available, which is not the capability rule inverted', () => {
    // Worth stating as its own case because the two absences mean opposite things. An absent CAPABILITY
    // is an operator who did not grant something, so it denies. An absent `available` is an application
    // that said nothing about a tool it went to the trouble of declaring, so it offers it.
    expect(admitsAvailability(undefined).admitted).toBe(true);
  });
});

describe('confirmation', () => {
  it('is needed only when declared required', () => {
    expect(needsConfirmation({ confirmation: 'required' })).toBe(true);
    expect(needsConfirmation({})).toBe(false);
    expect(needsConfirmation(undefined)).toBe(false);
  });

  it('is independent of availability', () => {
    // Two separate declarations, and the runtime decides availability first — so no prompt is raised
    // for a tool that would be refused anyway.
    expect(needsConfirmation({ confirmation: 'required', available: false })).toBe(true);
    expect(admitsAvailability({ confirmation: 'required', available: false }).admitted).toBe(false);
  });
});
