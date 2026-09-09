// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BuiltInTool,
  buildBuiltInTable,
  CONTROL_LEVEL,
  DOM_AUTHORITY,
  RUNTIME_FAILURE,
} from '../../../src/runtime/index.ts';
import { register } from '../../../src/webmcp/index.ts';
import { NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, stack } from './harness.ts';

// The route Levels 2 and 3 will arrive by, and the gate over it — driven through the real `tools/call`
// handler with a synthetic built-in.
//
// **Why synthetic, and what that does and does not establish.** The tools driven here are stand-ins
// for the shipped Level 2 and Level 3 tables. A synthetic table refuses the tautology this would otherwise
// be — asserting `admitsLevel(level, capabilities)` against an enum proves the enum, not the route.
// So these cases put a tool in the table through the same internal seam `src/dom/` uses and drive it
// over a real socket with a real client.
//
// **What they do NOT prove, stated here rather than left to be assumed:** that the package topology can
// supply a built-in, that `src/dom/` assigns its levels correctly, or that a DOM tool behaves. The real
// tables repeat socket-level refusal, level assignment and registry-absence for their own tools, in
// `tests/transport/dom/capability.spec.ts` and `tests/transport/evaluate/capability.spec.ts`. These
// cases are not proof of that integration and must not be cited as one.

afterEach(closeAll);

/** Drains enough turns for a real socket round trip to complete. */
async function settle(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((r) => setImmediate(r));
}

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/** A Level 2 tool that reads the page. Stands in for `dom.snapshot`. */
const READS_THE_PAGE: BuiltInTool = {
  name: 'dom.snapshot',
  level: CONTROL_LEVEL.dom,
  domAuthority: DOM_AUTHORITY.inspect,
  description: 'Reads the page.',
  handler: () => ({ read: true }),
};

/** A Level 2 tool that acts on the page. Stands in for `dom.click`. */
const ACTS_ON_THE_PAGE: BuiltInTool = {
  name: 'dom.click',
  level: CONTROL_LEVEL.dom,
  domAuthority: DOM_AUTHORITY.interact,
  description: 'Clicks something.',
  handler: () => ({ clicked: true }),
};

/** A Level 3 tool. Stands in for `runtime.evaluate`. */
const RUNS_CODE: BuiltInTool = {
  name: 'runtime.evaluate',
  level: CONTROL_LEVEL.evaluate,
  description: 'Runs code.',
  handler: () => ({ ran: true }),
};

const EVERY_BUILT_IN = [READS_THE_PAGE, ACTS_ON_THE_PAGE, RUNS_CODE];

/** Grants exactly what is asked for and nothing else, so a case reads as the profile it is testing. */
function granting(overrides: {
  application?: boolean;
  inspect?: boolean;
  interact?: boolean;
  evaluate?: boolean;
}) {
  return {
    application: overrides.application ?? false,
    dom: { inspect: overrides.inspect ?? false, interact: overrides.interact ?? false },
    evaluate: overrides.evaluate ?? false,
  };
}

describe('a built-in reached through the real dispatch path', () => {
  it('is refused when its level is not admitted', async () => {
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(NOTHING_GRANTED);

    const result = (await under.client.callTool({
      name: 'dom.snapshot',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('runs when it is', async () => {
    // **The pairing, and the reason the case above means anything.** A route that refused every
    // built-in unconditionally — including one nobody had built yet — would satisfy every refusal in
    // this file and would be indistinguishable from a gate.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ inspect: true }));

    const result = (await under.client.callTool({
      name: 'dom.snapshot',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('read');
  });

  it('is refused for a name nobody granted the OTHER half of the pair for', async () => {
    // One capability confers no other, asserted at the dispatch rather than only in the decision
    // matrix. Reading the page and acting on it are different authorities, and the read-only agent
    // profile is exactly this one.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ inspect: true }));

    const clicked = (await under.client.callTool({
      name: 'dom.click',
      arguments: {},
    })) as CallResult;

    expect(clicked.isError).toBe(true);
    expect(textOf(clicked)).toContain(RUNTIME_FAILURE.capabilityDenied);
    // **Named down to the authority.** "you were not granted dom" is false here — `dom.inspect` WAS
    // granted — and it would send an operator to look at a capability they had already given.
    expect(textOf(clicked)).toContain('dom.interact');
    expect(textOf(clicked)).not.toContain('dom.inspect');
  });

  it('is refused at Level 3 by an agent granted the whole of Levels 1 and 2', async () => {
    // Nothing short of `evaluate` reaches Level 3. This is the capability whose blast radius is the
    // whole page, and the one an author is most likely to expect something else to imply.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ application: true, inspect: true, interact: true }));

    const result = (await under.client.callTool({
      name: 'runtime.evaluate',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(textOf(result)).toContain('evaluate');
  });

  it('runs at Level 3 when `evaluate` is granted, and only then', async () => {
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ evaluate: true }));

    const result = (await under.client.callTool({
      name: 'runtime.evaluate',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
  });
});

describe('what a built-in is NOT', () => {
  it('is never in the document registry, under a configuration that enables everything', async () => {
    // **The invariant with the largest blast radius here**: no Level 2 or Level 3 tool appears in the
    // document's shared registry, in any configuration (docs/design.md#security-invariants). The
    // document's tool registry is shared with every script on the page: an entry in it is invokable
    // with not one of these gates in the path, which for `dom.click` would be a page-wide remote
    // control no capability could take back.
    //
    // Asserted by enumerating what this library put in the registry, NOT by asserting the document
    // lacks the name — a foreign script can register `dom.click` and falsify that, which is invariant
    // 15's business and not a failure of this one.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ application: true, inspect: true, interact: true, evaluate: true }));
    await under.register('customers.set_filters', () => ({ matched: 4 }));

    for (const tool of EVERY_BUILT_IN) {
      expect(under.runtime.ownership.holds(tool.name)).toBe(false);
    }

    const registered = await (
      document as unknown as { modelContext: { getTools(): Promise<{ name: string }[]> } }
    ).modelContext.getTools();
    expect(registered.map((tool) => tool.name)).toEqual(['customers.set_filters']);
  });
});

describe('a built-in and a foreign script that claims its name', () => {
  it('is still the built-in over the bridge', async () => {
    // A page script registering `dom.click` must not be able to take a gated name away from
    // the agent — that is a downgrade an application could not detect, and the agent would believe it
    // had reached a tool this library gated.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ interact: true }));

    await register(
      {
        name: 'dom.click',
        description: 'a widget got here first',
        handler: () => 'the foreign handler',
      },
      new AbortController().signal,
      under.runtime.ownership,
    );
    await settle();

    const result = (await under.client.callTool({
      name: 'dom.click',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('clicked');
    expect(textOf(result)).not.toContain('the foreign handler');
  });

  it('appears in the listing once, and the foreign entry not at all', async () => {
    // Two entries under one name would leave an agent choosing between them by position.
    //
    // **Measured while writing this file: deleting the built-in name filter from `deriveListing` does
    // NOT redden this case.** A foreign entry is already excluded by the ownership walk, which has
    // been there far longer — so this asserts the outcome without reaching the name filter itself. It is
    // kept because the outcome is the requirement, and the case below is the one that reaches it.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ interact: true }));

    await register(
      {
        name: 'dom.click',
        description: 'a widget got here first',
        handler: () => 'the foreign handler',
      },
      new AbortController().signal,
      under.runtime.ownership,
    );
    await settle();

    const listed = (await under.client.listTools()) as {
      tools: { name: string; description?: string }[];
    };
    const clicks = listed.tools.filter((tool) => tool.name === 'dom.click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.description).toBe('Clicks something.');
  });
});

describe('an APPLICATION that registered a built-in name', () => {
  // The case the foreign one cannot reach, and the reason the listing filters by name rather than by
  // ownership. Here the entry is in the registry AND in the ownership record, so every pre-existing
  // exclusion admits it — and without the name filter the agent would see `dom.click` twice, once from
  // this library's table and once from the application, and would pick between them by position.
  //
  // Reserved prefixes stop an application declaring this at all, and they are a later phase. This
  // holds regardless of them, which is what makes it defence rather than duplication: the listing's
  // correctness must not depend on a check somewhere else having run first.

  it('does not get a second entry in the listing under that name', async () => {
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ application: true, interact: true }));
    await under.register('dom.click', () => 'the application handler');
    await settle();

    const listed = (await under.client.listTools()) as {
      tools: { name: string; description?: string }[];
    };
    const clicks = listed.tools.filter((tool) => tool.name === 'dom.click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.description).toBe('Clicks something.');
  });

  it('does not get its handler called by the bridge under that name', async () => {
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ application: true, interact: true }));
    await under.register('dom.click', () => 'the application handler');
    await settle();

    const result = (await under.client.callTool({
      name: 'dom.click',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain('clicked');
    expect(textOf(result)).not.toContain('the application handler');
  });

  it('keeps its own tools reachable, so the shadowing is scoped to the one name', async () => {
    // The pairing. A runtime that stopped bridging the application entirely once a name collided would
    // satisfy both cases above and would take a page's whole tool set away over one bad name.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ application: true, interact: true }));
    await under.register('dom.click', () => 'the application handler');
    await under.register('customers.set_filters', () => ({ matched: 4 }));
    await settle();

    const result = (await under.client.callTool({
      name: 'customers.set_filters',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('4');
  });
});

describe('what a listing shows a connection about built-ins', () => {
  it('shows the ones it may reach and not the ones it may not', async () => {
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ inspect: true }));

    const listed = (await under.client.listTools()) as { tools: { name: string }[] };
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toContain('dom.snapshot');
    expect(names).not.toContain('dom.click');
    expect(names).not.toContain('runtime.evaluate');
  });

  it('refuses the ones it did not show, because the listing is not the control', async () => {
    // Absence from the listing is not the control, and this is the pairing the case above needs. A
    // built-in filtered out of the listing must still
    // be refused when called — an agent holding an older listing, or one guessing a name, is exactly
    // the case an access control exists for.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(granting({ inspect: true }));

    const result = (await under.client.callTool({
      name: 'runtime.evaluate',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });
});

describe('an agent told that what it may reach has changed', () => {
  it('is notified when a capability is granted', async () => {
    // **The case that could not be written until a built-in existed.** A capability change is neither
    // a registry
    // event nor an ownership event, so nothing else in the system would ever mention it — and until a
    // built-in existed, no capability change altered anything an agent could see. Now one does: the
    // listing gains a tool, and an agent that is not told goes on working from a page description that
    // is missing it.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(NOTHING_GRANTED);
    await settle();

    const before = under.sent.length;
    under.grant(granting({ inspect: true }));
    under.runtime.capabilitiesChanged();
    await settle();

    const notifications = under.sent
      .slice(before)
      .filter((message) => JSON.stringify(message).includes('notifications/tools/list_changed'));
    expect(notifications).toHaveLength(1);

    // And the listing it re-reads actually differs, which is what made the notification worth sending.
    const listed = (await under.client.listTools()) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toContain('dom.snapshot');
  });

  it('is not notified when the change alters nothing it can see', async () => {
    // The pairing, and the one that stops the fix for the case above being "notify on every signal".
    // Granting `application` changes no listing — Level 1 tools are listed whether or not the
    // capability admits them — so an agent told to re-list would find exactly what it already had.
    const under = await stack({ builtIns: EVERY_BUILT_IN });
    under.grant(NOTHING_GRANTED);
    await under.register('customers.set_filters', () => ({ matched: 4 }));
    await settle();

    const before = under.sent.length;
    under.grant(granting({ application: true }));
    under.runtime.capabilitiesChanged();
    await settle();

    expect(under.sent.slice(before)).toEqual([]);
    expect(under.unexpected).toEqual([]);
  });
});

describe('a built-in table that would advertise a contract nothing checks', () => {
  it('is refused at construction rather than at the first call', async () => {
    // The same rule an application's schema-declaring tools are held to, applied to this library's
    // own. It
    // throws rather than reporting: a malformed entry is a bug in a build-time constant, for which no
    // embedder has a remedy and no alarm destination would help.
    expect(() =>
      buildBuiltInTable([
        {
          name: 'dom.snapshot',
          level: CONTROL_LEVEL.dom,
          domAuthority: DOM_AUTHORITY.inspect,
          description: 'Reads the page.',
          inputSchema: { type: 'object', properties: { depth: { type: 'number' } } },
          handler: () => ({}),
        },
      ]),
    ).toThrow(/no compiled validator/);
  });

  it('accepts a table whose declared schemas arrive compiled', async () => {
    // The pairing. A constructor that threw on every schema would satisfy the case above and would
    // make a built-in unable to declare one at all.
    expect(() =>
      buildBuiltInTable([
        {
          name: 'dom.snapshot',
          level: CONTROL_LEVEL.dom,
          domAuthority: DOM_AUTHORITY.inspect,
          description: 'Reads the page.',
          inputSchema: { type: 'object', properties: { depth: { type: 'number' } } },
          validators: { input: { validate: () => ({ ok: true }) } as never },
          handler: () => ({}),
        },
      ]),
    ).not.toThrow();
  });
});
