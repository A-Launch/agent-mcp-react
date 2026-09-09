// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';
import { closeAll, stack } from './harness.ts';

// Step 4 of the gate chain: whether the application is currently offering the tool.
//
// **The distinction this file exists to keep sharp is between three ways a tool can be out of reach**,
// which a single "refused" would merge and an agent needs to tell apart:
//
//   - the name is not registered — nobody declared it, and nothing will change that;
//   - the capability does not admit it — an operator's decision about the whole connection;
//   - the application is not offering it right now — usually state the agent can change, so waiting
//     and retrying is the right response rather than giving up.
//
// **And between availability and withdrawal.** An unavailable tool is still registered. Every script
// in the page still invokes it, because a permission governs this library's bridge and not the page
// (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page). A design that
// expressed "unavailable" as "not registered" would pass every refusal case here and would take a
// page's own access to its own actions away.

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

/**
 * A tool that records whether it was entered.
 *
 * **Added after an adversarial review found the gap.** Without it, a runtime that ran the handler and
 * then returned `MCP_TOOL_DISABLED` satisfies every refusal, ordering and redaction assertion in this
 * file — and the tool the application closed would have run anyway. The response is not the guarantee;
 * the handler not being entered is.
 */
function recordingTool(result: unknown = 'paid'): {
  entered: () => number;
  handler: () => unknown;
} {
  let entries = 0;
  return {
    entered: () => entries,
    handler: () => {
      entries += 1;
      return result;
    },
  };
}

describe('a tool the application declares unavailable', () => {
  it('is refused at invocation, and the handler is never entered', async () => {
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, { available: false });

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
    // The assertion the response alone does not make. A gate that ran the handler and reported an
    // error afterwards would satisfy everything above, and the application would have changed.
    expect(tool.entered()).toBe(0);
  });

  it('is refused for an agent that never listed, because the listing is not the control', async () => {
    // The refusal at invocation is the control rather than the listing, and this is the case
    // that makes the exclusion below honest. An agent holding a listing
    // from a moment ago, or one guessing a plausible name, is exactly what a control exists for — and
    // it is the only agent whose behaviour a hidden-from-the-list design would get wrong.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, { available: false });

    // No `listTools` anywhere in this case, deliberately.
    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
  });

  it('runs when the application offers it — same tool, same connection', async () => {
    // The pairing. Without it a runtime that refused everything satisfies this whole file.
    const under = await stack();
    const tool = recordingTool();
    await under.register('invoice.mark_paid', tool.handler, undefined, { available: true });

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('paid');
    expect(tool.entered()).toBe(1);
  });

  it('runs when the application says nothing about it at all', async () => {
    // Absent means available, which is NOT the capability rule inverted. There, absence means an
    // operator did not grant something. Here it means an application said nothing about a tool it went
    // to the trouble of declaring — and reading that as "closed" would make every tool written before
    // this feature unavailable.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid');

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
  });
});

describe('what an unavailable tool is NOT', () => {
  it('is still in the document registry, and a page script still runs it', async () => {
    // **Both halves matter and they say different things.** The first is that availability is not
    // withdrawal — the registration is untouched. The second is the bridge-only truth this feature
    // must not obscure: an author who moves a domain rule out of a handler and into `available` has
    // stopped enforcing it for every caller that is not this agent.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, { available: false });

    const registry = (document as unknown as { modelContext?: Record<string, unknown> })
      .modelContext;
    if (registry === undefined) throw new Error('the document has no registry');

    const listed = await (registry as { getTools(): Promise<{ name: string }[]> }).getTools();
    expect(listed.map((tool) => tool.name)).toContain('invoice.mark_paid');

    const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
      .executeToolByName;
    const result = await invoke.call(
      registry,
      'invoice.mark_paid',
      JSON.stringify({}),
      undefined,
      true,
    );
    expect(JSON.stringify(result)).toContain('paid');
  });

  it('is told apart from a name nobody registered', async () => {
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, { available: false });

    const unknown = (await under.client.callTool({
      name: 'invoice.mark_unpaid',
      arguments: {},
    })) as CallResult;

    expect(textOf(unknown)).toContain(RUNTIME_FAILURE.toolNotFound);
    expect(textOf(unknown)).not.toContain(RUNTIME_FAILURE.toolUnavailable);
  });

  it('is told apart from a capability denial', async () => {
    // The two most confusable refusals in the chain, asserted next to each other so a change that
    // merged them cannot pass. One says an operator withheld something from the whole connection; the
    // other says the application closed one tool, probably temporarily.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, { available: false });
    await under.register('invoice.send', () => 'sent');

    const unavailable = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(textOf(unavailable)).toContain(RUNTIME_FAILURE.toolUnavailable);
    expect(textOf(unavailable)).not.toContain(RUNTIME_FAILURE.capabilityDenied);

    under.grant({
      application: false,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });

    const denied = (await under.client.callTool({
      name: 'invoice.send',
      arguments: {},
    })) as CallResult;
    expect(textOf(denied)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(textOf(denied)).not.toContain(RUNTIME_FAILURE.toolUnavailable);
  });
});

describe('what the agent is shown', () => {
  it('leaves an unavailable tool out of the listing', async () => {
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, { available: false });
    await under.register('invoice.send', () => 'sent');
    await settle();

    const listed = (await under.client.listTools()) as { tools: { name: string }[] };
    const names = listed.tools.map((tool) => tool.name);

    expect(names).not.toContain('invoice.mark_paid');
    // The neighbouring tool is untouched. A filter that took the whole listing down would satisfy the
    // assertion above and would look identical to an application that unmounted.
    expect(names).toContain('invoice.send');
  });
});

describe('where the availability gate sits among the others', () => {
  it('refuses on the capability first, when both would refuse', async () => {
    // A tool an operator has put out of reach entirely should not be described as "the application is
    // not offering it right now" — that reads as temporary, and an agent would wait for something that
    // is never going to change.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid', undefined, { available: false });
    under.grant({
      application: false,
      dom: { inspect: false, interact: false },
      evaluate: false,
    });

    const result = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(textOf(result)).not.toContain(RUNTIME_FAILURE.toolUnavailable);
  });

  it('refuses on availability before it looks at the arguments', async () => {
    // Same reasoning as the capability ordering: an agent refused a tool the application has closed
    // should not be sent off correcting arguments for a call that would have been refused anyway.
    const under = await stack();
    const tool = recordingTool('charged');
    await under.registerWithSchemas(
      'billing.charge',
      tool.handler,
      {
        input: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
      },
      { available: false },
    );
    under.grant(APPLICATION_ONLY);

    const result = (await under.client.callTool({
      name: 'billing.charge',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolUnavailable);
    expect(textOf(result)).not.toContain(RUNTIME_FAILURE.argumentsInvalid);
    expect(tool.entered()).toBe(0);
  });

  it('still refuses invalid arguments once the tool is offered', async () => {
    // The pairing for the ordering case. A gate that swallowed every call before validation would
    // satisfy the case above while quietly removing argument validation altogether.
    const under = await stack();
    await under.registerWithSchemas(
      'billing.charge',
      () => 'charged',
      {
        input: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
      },
      { available: true },
    );

    const result = (await under.client.callTool({
      name: 'billing.charge',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.argumentsInvalid);
  });
});

describe('what an unavailability refusal is allowed to carry back', () => {
  it('never echoes what the agent sent', async () => {
    const under = await stack();
    await under.register('auth.sign_in', () => 'ok', undefined, { available: false });

    const result = (await under.client.callTool({
      name: 'auth.sign_in',
      arguments: { password: 'hunter2-secret', token: 'sk-ant-SECRETKEY' },
    })) as CallResult;

    const text = textOf(result);
    expect(text).toContain(RUNTIME_FAILURE.toolUnavailable);
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('sk-ant-SECRETKEY');
  });
});
