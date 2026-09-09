// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALL_PHASE,
  CALL_ROUTE,
  FAILURE_VOCABULARY,
  GATE_OUTCOME,
  type McpObservedCall,
} from '../../../src/index.ts';
import { useMcpTool } from '../../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// **The shared-registry consequence, made observable instead of documented.**
//
// A tool this library registers goes into the DOCUMENT's tool registry, which every script on the page
// shares. `permissions: { available: false }` governs this library's bridge and nothing else — the tool
// stays in the registry and still runs for a widget, a browser extension, or the application's own
// code. That has always been true and has always been stated in a paragraph; nothing demonstrated it.
//
// Two records for the same tool, one per route, are what make it visible:
//
//   over the BRIDGE   refused at `policy`
//   over the REGISTRY runs, with `policy` recorded as `notRun`
//
// The second is the one that matters. Its ungated steps are `notRun` and never `passed`, because a
// consumer reading `passed` would believe a check admitted the call when no check ran at all — and an
// operator who concluded from that record that availability was enforced would be wrong in the exact
// way this feature exists to prevent.
//
// **What these cases do NOT cover, established by measurement while writing them.** A refusal produced
// by THIS library on the registry route — carrying `FAILURE_VOCABULARY.route` — is not exercised here.
// A descriptor that declares an `inputSchema` is validated by the REGISTRY first, and a call refused
// there never reaches the callback at all (the last case below asserts exactly that). This library's
// own schema check on this route therefore only runs where the two validators disagree — ours is Ajv,
// the shim's is its own — which is a real but narrow window, and one no case here drives. The route
// vocabulary's other member, `toolNotDeclared`, has a window narrower still.
//
// Recorded rather than left as an untested branch nobody noticed: a reader would otherwise take the
// coverage above for coverage of the whole route.

afterEach(closeAll);

/**
 * Invokes a tool the way any script on the page can: through the registry's OWN entry point.
 *
 * Not `getTools()[n].handler` — the descriptors that enumeration returns carry no callable, which is a
 * property of the standard rather than of this library. `executeToolByName` is what a page script
 * actually reaches for, and it lands on the same registered callback the bridge never uses — the
 * bridge invokes the handler it registered, directly (docs/design.md#tool-results).
 * Called ON the registry rather than destructured off it: these are prototype methods using `this`.
 *
 * A refusal on this route can surface either as a throw or as a result carrying `isError`, so both are
 * normalised here — a helper that only caught exceptions would read half the refusals as successes.
 */
async function callFromPage(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('the document has no registry');
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  try {
    const result = await invoke.call(registry, name, JSON.stringify(args), undefined, true);
    const shaped = result as { isError?: boolean; content?: { text?: string }[] };
    const text =
      typeof result === 'string'
        ? result
        : (shaped.content ?? []).map((block) => block.text ?? '').join('');
    return { ok: shaped.isError !== true, text };
  } catch (cause) {
    return { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
  }
}

function outcomeOf(event: McpObservedCall, step: string): string | undefined {
  return event.gates.find((gate) => gate.step === step)?.outcome;
}

function lastTerminal(observed: readonly McpObservedCall[]): McpObservedCall | undefined {
  return observed.filter((event) => event.phase !== CALL_PHASE.start).at(-1);
}

/** A tool the application has closed. Refused over the bridge; still live for the page. */
function ClosedTool(): ReactNode {
  const [value, setValue] = useState('unset');
  useMcpTool({
    name: 'panel.set',
    description: 'Set the panel value.',
    permissions: { available: false },
    handler: (input) => {
      setValue(String(input.value));
      return { value: String(input.value) };
    },
  });
  return <p>{value}</p>;
}

describe('the same tool, reached by both routes', () => {
  it('is refused at policy over the bridge, and RUNS for a page script', async () => {
    const page = await stack(<ClosedTool />);

    await page.client.callTool({ name: 'panel.set', arguments: { value: 'from-agent' } });
    await until(() => lastTerminal(page.observed) !== undefined, 'the bridged call to be reported');

    const bridged = lastTerminal(page.observed);
    expect(bridged?.route).toBe(CALL_ROUTE.bridge);
    expect(outcomeOf(bridged as McpObservedCall, 'policy')).toBe(GATE_OUTCOME.refused);
    expect(bridged?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.toolUnavailable,
    });

    const before = page.observed.length;
    // The same tool, the same argument shape, from the page itself. It RUNS — availability never
    // reached this route, and pretending otherwise is what this case refuses to let anyone believe.
    await callFromPage('panel.set', { value: 'from-page' });
    await until(() => page.observed.length > before, 'the page call to be reported');

    const inPage = lastTerminal(page.observed);
    expect(inPage?.route).toBe(CALL_ROUTE.registry);
    expect(inPage?.phase).toBe(CALL_PHASE.result);
    // **`notRun`, never `passed`.** The distinction the whole feature turns on.
    expect(outcomeOf(inPage as McpObservedCall, 'policy')).toBe(GATE_OUTCOME.notRun);
    expect(outcomeOf(inPage as McpObservedCall, 'capability')).toBe(GATE_OUTCOME.notRun);
    expect(outcomeOf(inPage as McpObservedCall, 'confirm')).toBe(GATE_OUTCOME.notRun);
    // No socket was involved, so the step the gateway owns never applied either.
    expect(outcomeOf(inPage as McpObservedCall, 'authenticate')).toBe(GATE_OUTCOME.notRun);
    // What DID run on this route: the schema, and the handler.
    expect(outcomeOf(inPage as McpObservedCall, 'validate')).toBe(GATE_OUTCOME.passed);
    expect(outcomeOf(inPage as McpObservedCall, 'invoke')).toBe(GATE_OUTCOME.passed);
  });

  it('carries the route as a field, so it is never inferred from an absence', async () => {
    const page = await stack(<ClosedTool />);
    await callFromPage('panel.set', { value: 'x' });
    await until(() => lastTerminal(page.observed) !== undefined, 'the page call to be reported');

    // Present on every record of every phase. A consumer that had to deduce the route from a missing
    // field would deduce it wrongly the first time a field was added.
    for (const event of page.observed) {
      expect([CALL_ROUTE.bridge, CALL_ROUTE.registry]).toContain(event.route);
    }
  });
});

describe('what a page-script record does NOT claim', () => {
  it('names no caller, because a JavaScript call carries no trustworthy identity', async () => {
    const page = await stack(<ClosedTool />);
    await callFromPage('panel.set', { value: 'x' });
    await until(() => lastTerminal(page.observed) !== undefined, 'the page call to be reported');

    // A widget, an extension and the application's own code are indistinguishable at the callback.
    // Naming one would present a guess as a fact, and an explainable record tolerates a stated absence
    // far better than an invented attribution — so the record says HOW a call arrived and never WHO
    // made it.
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
    for (const event of page.observed) {
      for (const key of Object.keys(event)) expect(permitted.has(key)).toBe(true);
    }
  });
});

describe('what the registry route CANNOT observe, measured rather than assumed', () => {
  function SchemaTool(): ReactNode {
    useMcpTool({
      name: 'panel.typed',
      description: 'Takes a string.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      handler: (input) => ({ value: String(input.value) }),
    });
    return null;
  }

  it('produces NO record when the REGISTRY refuses a call before our callback runs', async () => {
    const page = await stack(<SchemaTool />);
    const before = page.observed.length;

    const refused = await callFromPage('panel.typed', { value: 42 });
    expect(refused.ok).toBe(false);
    // Measured, not reasoned about: the refusal text comes from the registry's own validator, not from
    // this library's vocabulary. `Input validation error: Instance type "number" is invalid.`
    expect(refused.text).toContain('validation');

    // Yield generously. The claim is an ABSENCE, so it has to be an absence that survives the work
    // having had every chance to happen.
    for (let turn = 0; turn < 40; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // **The limitation, stated as a case so it cannot be forgotten.** A descriptor that declares an
    // `inputSchema` is validated BY THE REGISTRY before the callback this library registered is
    // invoked. When that validation refuses, our callback never runs — so no observation is opened and
    // the call leaves no record at all.
    //
    // This is a property of instrumenting a callback somebody else decides whether to call, not a gap
    // in the projector. It cannot be closed from inside this library: the only place that would see
    // the call is the registry itself. An operator reading the observability surface must therefore
    // know that a page-script call refused on SHAPE is invisible, while one that reaches the handler
    // is fully reported — which is what the cases above establish.
    expect(page.observed.length).toBe(before);
  });
});
