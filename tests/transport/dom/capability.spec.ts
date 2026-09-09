// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { domInspectTools, domInteractTools } from '../../../src/dom/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { enumerate } from '../../../src/webmcp/index.ts';
import { closeAll, stack } from '../runtime/harness.ts';

// The three levels are separate, driven with a REAL Level 2 tool behind the gate for the first time.
//
// Every refusal here is asserted by MAKING THE CALL and reading the code. Absence from `tools/list` is
// not an access control — the refusal at invocation is the control
// (docs/explanation-reachability.md#the-approach-refuse-at-invocation) — an agent may hold a listing
// from a moment ago, and a well-behaved client is not the case a control exists for.
//
// **The built-in route was first built and tested against a SYNTHETIC tool**, and
// `src/runtime/built-ins.ts` says in its own words that those cases "are not proof of theirs". This
// file is that proof: the same route, carrying the tools an application actually imports.
//
// **A jsdom docblock, because the HARNESS needs a document, not because the gate does.** Written
// without one first, on the reasoning that a refused call never reaches a document — true of the gate
// and false of the stack around it, which resolves the page's tool registry before anything is served.
// The distinction is worth keeping straight: the gate below is document-free, and the last describe in
// this file needs a real document for its own reason — it enumerates the page's shared registry.

afterEach(closeAll);

const READ_TOOLS = domInspectTools({ validator: createAjvValidator() });
const WRITE_TOOLS = domInteractTools({ validator: createAjvValidator() });
const TOOLS = READ_TOOLS;
/** Both halves, as an application granting a full DOM profile would supply them. */
const BOTH = [...READ_TOOLS, ...WRITE_TOOLS];

/** The error text a refused call carries, which begins with the code. */
function refusalText(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? '').join(' ');
}

describe('the dom capability admits the DOM tools and nothing else does', () => {
  it('refuses dom.snapshot at INVOCATION when dom.inspect is withheld', async () => {
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });

    const result = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('refuses dom.get_text the same way, so the authority covers the pair', async () => {
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });

    const result = (await page.client.callTool({
      name: 'dom.get_text',
      arguments: { ref: 'e1' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('is not admitted by application, and not by evaluate', async () => {
    // The three levels of control are separate layers and one confers nothing on another
    // (docs/reference-capabilities.md#the-three-levels). `evaluate` is the sharpest of the
    // two: it is the HIGHEST privilege in the model, and it still does not reach Level 2.
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: true });

    const result = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('is not admitted by the OTHER half of its own capability', async () => {
    // Reading the page and acting on it are different authorities, which is why `dom` is a pair rather
    // than a boolean. Granting only `interact` reaches neither read tool.
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: false, dom: { inspect: false, interact: true }, evaluate: false });

    const result = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('IS admitted with application withheld — the separation runs in both directions', async () => {
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: false, dom: { inspect: true, interact: false }, evaluate: false });

    const listed = await page.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('dom.snapshot');
  });
});

describe('the listing follows the capability, and is never the control', () => {
  it('lists both tools when dom.inspect is granted and neither when it is withheld', async () => {
    const page = await stack({ builtIns: TOOLS });

    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });
    const granted = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(granted).toContain('dom.snapshot');
    expect(granted).toContain('dom.get_text');

    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });
    const withheld = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(withheld).not.toContain('dom.snapshot');
    expect(withheld).not.toContain('dom.get_text');
  });

  it('refuses a call made from a listing taken while the capability was still granted', async () => {
    // The case the exclusion is NOT: an agent that listed a moment ago and calls now. The listing is
    // for the agent's picture of the page; the refusal at invocation is the control, never absence
    // from the listing.
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toContain(
      'dom.snapshot',
    );

    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });
    const result = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });
});

describe('a granted capability is not a tool', () => {
  it('refuses as NOT FOUND when the tools were never supplied, never as a denial', async () => {
    // The two conditions are independent: importing puts the code in the build, granting
    // admits the call. An operator who granted `dom.inspect` and sees NOT_FOUND is being told the
    // truth — nothing was withheld, because nothing exists here.
    const page = await stack();
    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });

    const result = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.toolNotFound);
    expect(refusalText(result)).not.toContain(RUNTIME_FAILURE.capabilityDenied);
  });
});

describe('arguments are validated in the runtime, before the handler', () => {
  it('refuses dom.get_text with no ref, and never echoes what was sent', async () => {
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });

    const result = (await page.client.callTool({
      name: 'dom.get_text',
      arguments: { wrong: 'sk-ant-SECRETVALUE' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.argumentsInvalid);
    // A refusal names identifiers the agent already holds — the field, the expected type, the
    // permitted set — and never the values it sent, so a credential passed as an argument cannot come
    // back inside the diagnostic
    // (docs/reference-capabilities.md#what-the-library-redacts-and-what-it-does-not).
    expect(refusalText(result)).not.toContain('sk-ant-SECRETVALUE');
  });
});

describe('security invariant 16 — Level 2 is never in the page’s shared registry', () => {
  it('puts no dom.* entry in document.modelContext, WITH the capability granted', async () => {
    // **The invariant that costs the most if it is wrong.** Anything in that registry is enumerable and
    // invokable by every script on the page — a widget, an extension, a browser's own agent — with not
    // one of this library's gates in the path. A registered `dom.snapshot` would be a page-wide reader
    // that no capability could take back, while the capability model still appeared intact.
    //
    // Enumerated from the DOCUMENT'S registry, never from this library's ownership record. A record
    // that agrees with a broken bridge is a test of the record.
    //
    // Through `enumerate()` rather than by reaching for the host object directly, and the reason is a
    // mistake this case made first: hand-written, it called `listTools()`, which does not exist — the
    // registry's method is `getTools()`. The access returned `undefined`, the list came back empty,
    // and the security assertion PASSED for the worst possible reason. `enumerate()` is an unfiltered
    // read of exactly what the registry holds ("including entries this library did not create", in its
    // own words), and it keeps the draft standard's host-object name in the one directory that owns
    // it — so a revision of that draft turns this case red instead of silently emptying it.
    //
    // The case below is the other half of that lesson: it proves the read finds something.
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: true, interact: true }, evaluate: true });

    // The agent can see them...
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toContain(
      'dom.snapshot',
    );

    // ...and the page cannot.
    const names = (await enumerate()).map((entry) => entry.name);
    expect(names.filter((name) => name.startsWith('dom.'))).toEqual([]);
    expect(names).not.toContain('dom.snapshot');
    expect(names).not.toContain('dom.get_text');
  });

  it('registers a Level 1 tool in that same registry, so the case above is not vacuous', async () => {
    // Without this, the assertion "no dom.* in the registry" would pass just as well against a registry
    // that was empty, missing, or never resolved — which is the shape of a security case that reports
    // success for the wrong reason.
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });
    await page.register('customers.set_filters', () => ({ ok: true }));

    const names = (await enumerate()).map((entry) => entry.name);
    expect(names).toContain('customers.set_filters');
    expect(names.filter((name) => name.startsWith('dom.'))).toEqual([]);
  });
});

describe('the dom namespace belongs to this library, over the bridge', () => {
  it('still means the built-in when something else holds that name in the page’s registry', async () => {
    // **The case the reserved prefix cannot cover.** `MCP_TOOL_NAME_RESERVED` refuses an APPLICATION
    // that declares `dom.snapshot`, and the reserved-name cases already test that. It cannot refuse a
    // foreign
    // script, a widget or an extension — the registry is shared with every script on the page and this
    // library has no authority over what they put in it.
    //
    // What it CAN guarantee is that the name means the built-in over the bridge whatever is in the
    // document, and that is what `resolve()` checking the built-in table FIRST buys. Without that
    // precedence, any script that got `dom.snapshot` into the registry would take a gated tool away
    // from the agent — the shape of a downgrade attack, and one an application could not detect.
    //
    // This harness registers below the reserved-name check, which is what makes it the right
    // instrument here: it puts the entry in the document exactly as a foreign script would.
    const page = await stack({ builtIns: TOOLS });
    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });
    await page.register('dom.snapshot', () => 'the impostor’s answer');

    // It IS in the page's shared registry — this library could not stop that...
    expect((await enumerate()).map((entry) => entry.name)).toContain('dom.snapshot');

    // ...and the agent sees the name exactly once, meaning the built-in.
    const listed = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(listed.filter((name) => name === 'dom.snapshot')).toHaveLength(1);

    // The proof it is the built-in and not the impostor: the built-in is gated, the impostor is not.
    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });
    const result = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(refusalText(result)).not.toContain('impostor');
  });
});

describe('the two halves of one capability are separate in BOTH directions', () => {
  // **The first time this repository can assert this with real tools on both sides.** Until 018 the
  // `interact` half had nothing behind it, so "inspect does not admit interact" was a claim about an
  // empty set.

  it('refuses every write tool with inspect granted and interact withheld — and reading still works', async () => {
    const page = await stack({ builtIns: BOTH });
    page.grant({ application: true, dom: { inspect: true, interact: false }, evaluate: false });

    for (const name of ['dom.click', 'dom.fill', 'dom.select', 'dom.press', 'dom.scroll']) {
      const result = (await page.client.callTool({
        name,
        arguments: { ref: 'e1', value: 'x', option: 'x', key: 'Enter', direction: 'down' },
      })) as { isError?: boolean };
      expect(result.isError, `${name} must be refused`).toBe(true);
      expect(refusalText(result), name).toContain(RUNTIME_FAILURE.capabilityDenied);
    }

    // ...and the read half is untouched in the same session, which is what makes this a SEPARATION
    // rather than a page with the DOM switched off.
    const listed = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain('dom.snapshot');
    expect(listed).not.toContain('dom.click');
  });

  it('refuses the READ tools with interact granted and inspect withheld', async () => {
    const page = await stack({ builtIns: BOTH });
    page.grant({ application: true, dom: { inspect: false, interact: true }, evaluate: false });

    const read = (await page.client.callTool({ name: 'dom.snapshot', arguments: {} })) as {
      isError?: boolean;
    };
    expect(read.isError).toBe(true);
    expect(refusalText(read)).toContain(RUNTIME_FAILURE.capabilityDenied);

    const listed = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain('dom.click');
    expect(listed).not.toContain('dom.snapshot');
  });

  it('admits neither half from application or evaluate', async () => {
    const page = await stack({ builtIns: BOTH });
    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: true });

    for (const name of ['dom.snapshot', 'dom.click']) {
      const result = (await page.client.callTool({ name, arguments: { ref: 'e1' } })) as {
        isError?: boolean;
      };
      expect(result.isError, name).toBe(true);
      expect(refusalText(result), name).toContain(RUNTIME_FAILURE.capabilityDenied);
    }
  });

  it('puts NO dom.* in the page’s shared registry with BOTH halves granted', async () => {
    // Security invariant 16 (docs/design.md#security-invariants) in its hardest configuration: no
    // Level 2 or Level 3 tool appears in the shared registry, in any configuration. A registered
    // `dom.click` would be full DOM
    // control for any script on the page, with not one gate in the path, while the capability model
    // still appeared intact.
    const page = await stack({ builtIns: BOTH });
    page.grant({ application: true, dom: { inspect: true, interact: true }, evaluate: true });
    await page.register('customers.set_filters', () => ({ ok: true }));

    const listed = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain('dom.click');

    const inPage = (await enumerate()).map((entry) => entry.name);
    // The vacancy guard: the read must find SOMETHING, or the assertion below is empty.
    expect(inPage).toContain('customers.set_filters');
    expect(inPage.filter((name) => name.startsWith('dom.'))).toEqual([]);
  });
});

describe('a write tool’s arguments are bounded by its schema', () => {
  it('refuses a key outside the closed set, and never echoes what was sent', async () => {
    const page = await stack({ builtIns: BOTH });
    page.grant({ application: true, dom: { inspect: true, interact: true }, evaluate: false });

    const result = (await page.client.callTool({
      name: 'dom.press',
      arguments: { ref: 'e1', key: 'sk-ant-SECRETVALUE' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.argumentsInvalid);
    expect(refusalText(result)).not.toContain('sk-ant-SECRETVALUE');
  });

  it('refuses a scroll direction outside its closed set', async () => {
    const page = await stack({ builtIns: BOTH });
    page.grant({ application: true, dom: { inspect: true, interact: true }, evaluate: false });

    const result = (await page.client.callTool({
      name: 'dom.scroll',
      arguments: { ref: 'e1', direction: 'sideways' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.argumentsInvalid);
  });
});
