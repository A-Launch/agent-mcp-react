// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeEvaluateTool } from '../../../src/evaluate/index.ts';
import { CONFIRMATION } from '../../../src/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { enumerate } from '../../../src/webmcp/index.ts';
import { closeAll, stack } from '../runtime/harness.ts';

// **The negative suite IS this feature.** The design requires `runtime.evaluate` to be treated as
// equivalent to privileged code execution in the application origin (docs/javascript-evaluation.md),
// so what ships is a set of conditions and the tool is the small part. Every case below asserts a
// refusal at INVOCATION.
//
// The sharpest single assertion in this repository is `document.modelContext holds no runtime.*` with
// the capability GRANTED. Anything in that registry is callable by every script on the page with not
// one gate in the path — for this tool that is the whole origin, handed over silently, while the
// capability model still appears intact.

afterEach(closeAll);

const TOOL = runtimeEvaluateTool({ validator: createAjvValidator() });

/** What an application would plausibly write. Level 3 withheld — which is the default that matters. */
const ORDINARY = {
  application: true,
  dom: { inspect: true, interact: true },
  evaluate: false,
} as const;

const GRANTED = {
  application: false,
  dom: { inspect: false, interact: false },
  evaluate: true,
} as const;

function refusalText(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content ?? [])
    .map((part) => part.text ?? '')
    .join(' ');
}

async function callEvaluate(page: Awaited<ReturnType<typeof stack>>, expression: string) {
  return (await page.client.callTool({
    name: 'runtime.evaluate',
    arguments: { expression },
  })) as { isError?: boolean; structuredContent?: unknown };
}

describe('nothing short of the evaluate capability admits it', () => {
  it('refuses under a capability set an application would plausibly write', async () => {
    // The security invariant "JavaScript evaluation is disabled by default"
    // (docs/design.md#security-invariants) — asserted as the thing an
    // application actually produces rather than as an empty object.
    const page = await stack({ builtIns: TOOL });
    page.grant(ORDINARY);
    page.askWith(() => CONFIRMATION.approved);

    const result = await callEvaluate(page, 'return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('is not admitted by application, nor by either half of dom, even both at once', async () => {
    const page = await stack({ builtIns: TOOL });
    page.grant({ application: true, dom: { inspect: true, interact: true }, evaluate: false });
    page.askWith(() => CONFIRMATION.approved);

    const result = await callEvaluate(page, 'return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('is admitted by evaluate alone, with everything else withheld', async () => {
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);
    page.askWith(() => CONFIRMATION.approved);

    const result = await callEvaluate(page, 'return 6 * 7;');
    expect(result.isError, refusalText(result)).not.toBe(true);
    expect(JSON.stringify(result.structuredContent ?? refusalText(result))).toContain('42');
  });
});

describe('security invariant 16 — Level 3 is never in the page’s shared registry', () => {
  it('puts no runtime.* entry in document.modelContext WITH evaluate granted', async () => {
    // **The one that costs the whole origin if it is wrong.**
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);
    await page.register('customers.set_filters', () => ({ ok: true }));

    // The agent can see it...
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toContain(
      'runtime.evaluate',
    );

    // ...and the page cannot. Read through `enumerate()`, which is an unfiltered read of what the
    // registry holds — a hand-written access to the host object once returned `undefined` from a
    // misspelled method and passed a security assertion for the worst possible reason.
    const inPage = (await enumerate()).map((entry) => entry.name);
    // The vacancy guard: the read must find SOMETHING, or the assertion below is empty.
    expect(inPage).toContain('customers.set_filters');
    expect(inPage.filter((name) => name.startsWith('runtime.'))).toEqual([]);
    expect(inPage).not.toContain('runtime.evaluate');
  });
});

describe('a granted capability is not a tool', () => {
  it('refuses as NOT FOUND when the subpath was never imported', async () => {
    // The condition an operator cannot switch on after the fact: code that is not in the bundle
    // cannot be reached by any capability.
    const page = await stack();
    page.grant(GRANTED);

    const result = await callEvaluate(page, 'return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.toolNotFound);
    expect(refusalText(result)).not.toContain(RUNTIME_FAILURE.capabilityDenied);
  });
});

describe('a person must approve every call', () => {
  it('refuses when a person declines, and THE EXPRESSION NEVER RAN', async () => {
    // Asserted by an observable side effect that did not happen, not by the return value. A
    // confirmation that resolved after the handler ran would be an apology rather than a gate.
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);
    page.askWith(() => CONFIRMATION.refused);
    Reflect.deleteProperty(globalThis as object, '__evaluateRan');

    const result = await callEvaluate(page, 'globalThis.__evaluateRan = true; return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.confirmationRefused);
    expect(
      (globalThis as Record<string, unknown>).__evaluateRan,
      'the expression must not have run',
    ).toBeUndefined();
  });

  it('refuses with its own cause when there is nobody to ask, and stays LISTED', async () => {
    // A deployment fact rather than a property of the tool: an operator reading it fixes it by
    // supplying a resolver, and hiding the tool would tell an agent the action does not exist when
    // what is true is that it cannot be approved here.
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);

    const result = await callEvaluate(page, 'return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.confirmationUnavailable);
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toContain(
      'runtime.evaluate',
    );
  });

  it('refuses an approval that arrives after the capability was withdrawn', async () => {
    // Capability is re-read when a confirmation answers, because a confirmation is human-scale and an
    // operator can revoke while one is open.
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);
    Reflect.deleteProperty(globalThis as object, '__evaluateRanLate');
    page.askWith(() => {
      page.grant({ ...GRANTED, evaluate: false });
      return CONFIRMATION.approved;
    });

    const result = await callEvaluate(page, 'globalThis.__evaluateRanLate = true; return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect((globalThis as Record<string, unknown>).__evaluateRanLate).toBeUndefined();
  });

  it('shows the resolver the CODE that will run', async () => {
    // A person approving an evaluation who cannot see what will run is not approving anything.
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);
    let shown: unknown;
    page.askWith((request) => {
      shown = request.arguments;
      return CONFIRMATION.approved;
    });

    await callEvaluate(page, 'return "visible to the approver";');
    expect(JSON.stringify(shown)).toContain('visible to the approver');
  });
});

describe('the runtime namespace belongs to this library', () => {
  it('still means the built-in when a foreign script holds that name in the page’s registry', async () => {
    const page = await stack({ builtIns: TOOL });
    page.grant(GRANTED);
    page.askWith(() => CONFIRMATION.approved);
    await page.register('runtime.evaluate', () => 'the impostor’s answer');

    expect((await enumerate()).map((entry) => entry.name)).toContain('runtime.evaluate');
    const listed = (await page.client.listTools()).tools.map((tool) => tool.name);
    expect(listed.filter((name) => name === 'runtime.evaluate')).toHaveLength(1);

    // The proof it is the built-in: withdrawing the capability refuses it, which the impostor is not
    // subject to.
    page.grant({ ...GRANTED, evaluate: false });
    const result = await callEvaluate(page, 'return 1;');
    expect(result.isError).toBe(true);
    expect(refusalText(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(refusalText(result)).not.toContain('impostor');
  });
});
