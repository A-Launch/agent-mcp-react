// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { APPLICATION_ONLY, NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, stack } from './harness.ts';

// Step 3 of the gate chain, driven by a real MCP client over a real socket.
//
// **Every case here is paired, and the pairing is the work rather than the ceremony.** A suite of
// refusals is satisfied by a runtime that refuses everything: it would be green with the capability
// model replaced by `return refused`, and an application whose agent could do nothing would look
// exactly like an application whose gates worked. So each denial sits next to the grant that must
// still succeed on the same tool, over the same connection.
//
// Two things this file asserts that a registry-level or unit-level case could not:
//
//   - The refusal reaches the AGENT, as a tool error on the wire, rather than being a decision made
//     somewhere inside the page and reported to nobody.
//   - The gate is on the bridged path and only there. Level 1 tools stay in the document's shared
//     registry whatever the capability says: a capability governs this library's bridge and not the
//     page (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page), which is
//     the thing the capability documentation states out loud.

afterEach(closeAll);

/** Drains enough turns for a real socket round trip to complete. */
async function settle(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((r) => setImmediate(r));
}

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

/** The text the agent actually received, so an assertion is about the wire and not about a return. */
function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

describe('a Level 1 tool with the application capability withheld', () => {
  it('is refused at invocation, and the refusal names the capability', async () => {
    const under = await stack();
    await under.register('customers.set_filters', () => ({ matched: 4 }));
    under.grant(NOTHING_GRANTED);

    const result = (await under.client.callTool({
      name: 'customers.set_filters',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    // What an operator needs in order to fix it. The agent cannot change a capability; the person
    // reading this in an alarm destination can, and a refusal that named nothing would send them to
    // the tool's own code.
    expect(textOf(result)).toContain('application');
  });

  it('runs when the capability is granted — same tool, same connection', async () => {
    // **The pairing.** Without it every case in this file is satisfied by a runtime that refuses
    // everything, and an agent that could do nothing at all would pass the suite.
    const under = await stack();
    await under.register('customers.set_filters', () => ({ matched: 4 }));
    under.grant(APPLICATION_ONLY);

    const result = (await under.client.callTool({
      name: 'customers.set_filters',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('4');
  });

  it('is still listed, because absence from a listing is not access control', async () => {
    // Absence from a listing is not an access control, asserted rather than assumed. A shrinking list
    // looks to an agent like an application that
    // unmounted its features; a named refusal tells it what actually happened, and is the only one of
    // the two an agent can report back to a person.
    const under = await stack();
    await under.register('customers.set_filters', () => ({ matched: 4 }));
    under.grant(NOTHING_GRANTED);

    const listed = (await under.client.listTools()) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toContain('customers.set_filters');
  });

  it('is still callable by a script in the page, which is what a capability does NOT govern', async () => {
    // The sentence the capability prop's own documentation has to carry. Withholding
    // `application` refuses THIS LIBRARY'S BRIDGE. The registration stays in the document's shared
    // registry, where a widget, an extension or the application's own code reaches it with none of
    // these gates in the path.
    //
    // An author who moves a domain rule out of a handler and into a capability has therefore stopped
    // enforcing it for every caller that is not this agent — and only a case like this one makes that
    // fact something the suite states rather than something a reader has to infer.
    const under = await stack();
    await under.register('customers.set_filters', () => ({ matched: 4 }));
    under.grant(NOTHING_GRANTED);

    const registry = (document as unknown as { modelContext?: Record<string, unknown> })
      .modelContext;
    if (registry === undefined) throw new Error('the document has no registry');

    // The registry's OWN invocation entry point — the one this library never uses for a bridged call
    // (the bridge invokes the handler it registered, directly — docs/design.md#tool-results) and the
    // one a page script reaches for. Called ON the registry: it is a prototype method
    // that uses `this`.
    const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
      .executeToolByName;
    const result = await invoke.call(
      registry,
      'customers.set_filters',
      JSON.stringify({}),
      undefined,
      true,
    );

    // It RAN. Not "was not refused" — the handler produced its value, and the page saw it.
    expect(JSON.stringify(result)).toContain('4');
  });
});

describe('a capability changed while the connection is up', () => {
  it('applies to the next call, with nothing remounted and nothing reconnected', async () => {
    // **The live read.** The runtime is handed a supplier, not a set. A copy taken when the runtime
    // was built would keep admitting calls for the life of the page after an operator withdrew a
    // capability — and would make the confirmation recheck a later phase performs a comparison of a
    // snapshot with itself.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid');

    const before = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(before.isError).toBeUndefined();

    under.grant(NOTHING_GRANTED);

    const after = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(after.isError).toBe(true);
    expect(textOf(after)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('is granted back just as live, and the same connection carries the call', async () => {
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid');
    under.grant(NOTHING_GRANTED);

    expect(
      ((await under.client.callTool({ name: 'invoice.mark_paid', arguments: {} })) as CallResult)
        .isError,
    ).toBe(true);

    under.grant(APPLICATION_ONLY);

    const granted = (await under.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;
    expect(granted.isError).toBeUndefined();
    expect(textOf(granted)).toContain('paid');
  });

  it('sends nothing to the agent in this build, and the reason is written down', async () => {
    // `capabilitiesChanged()` reaches the publisher, which sends only when the DERIVED LISTING
    // actually differs. In this build nothing listed depends on a capability: Level 1 tools stay
    // listed when `application` is withheld, and there are no built-ins yet. So the correct number of
    // frames is zero, and a notification here would be an agent told to re-list for no change.
    //
    // **What this case does NOT establish, stated rather than left to be assumed:** that an agent is
    // told when a capability is granted. It cannot be established until the built-in route exists,
    // because until then no capability changes anything an agent can see. The case that asserts the
    // notification — and the break-it that reddens when the signal is removed — belongs with the
    // built-in table.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid');
    await settle();

    const before = under.sent.length;
    under.runtime.capabilitiesChanged();
    await settle();

    expect(under.sent.length).toBe(before);
    expect(under.unexpected).toEqual([]);
  });
});

describe('where the capability gate sits among the others', () => {
  it('refuses on the capability before it looks at the arguments', async () => {
    // The order is a requirement, not a detail. Telling an agent its arguments were wrong for a tool
    // it may not reach describes a contract it was never going to be held to — and it publishes the
    // shape of a tool this connection was refused, which is a small disclosure made for no benefit.
    const under = await stack();
    await under.registerWithSchemas('billing.charge', () => 'charged', {
      input: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      },
    });
    under.grant(NOTHING_GRANTED);

    const result = (await under.client.callTool({
      name: 'billing.charge',
      // Invalid: `amount` is required and missing. A gate ordered after validation would report this.
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(textOf(result)).not.toContain(RUNTIME_FAILURE.argumentsInvalid);
  });

  it('still refuses invalid arguments once the capability admits the call', async () => {
    // The pairing for the ordering case. A gate that swallowed every call before validation would
    // satisfy the case above while quietly removing argument validation altogether.
    const under = await stack();
    await under.registerWithSchemas('billing.charge', () => 'charged', {
      input: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      },
    });
    under.grant(APPLICATION_ONLY);

    const result = (await under.client.callTool({
      name: 'billing.charge',
      arguments: {},
    })) as CallResult;

    expect(textOf(result)).toContain(RUNTIME_FAILURE.argumentsInvalid);
  });

  it('tells an unknown name apart from a denied one', async () => {
    // Two opposite diagnoses that a single "refused" code would merge: nobody declared this, versus
    // somebody did and this connection may not reach it. An operator resolves the second by changing
    // a capability and would never find it under the first.
    const under = await stack();
    await under.register('invoice.mark_paid', () => 'paid');
    under.grant(NOTHING_GRANTED);

    const unknown = (await under.client.callTool({
      name: 'invoice.mark_unpaid',
      arguments: {},
    })) as CallResult;

    expect(textOf(unknown)).toContain(RUNTIME_FAILURE.toolNotFound);
    expect(textOf(unknown)).not.toContain(RUNTIME_FAILURE.capabilityDenied);
  });
});

describe('what a refusal is allowed to carry back', () => {
  it('never echoes what the agent sent, even when the call was refused before validation', async () => {
    // The redaction rule composes with every gate this feature adds, not only with the validator's
    // diagnostics. A refusal is the message most likely to be written by quoting the request, and this
    // is where that habit would arrive next.
    const under = await stack();
    await under.register('auth.sign_in', () => 'ok');
    under.grant(NOTHING_GRANTED);

    const result = (await under.client.callTool({
      name: 'auth.sign_in',
      arguments: { password: 'hunter2-secret', token: 'sk-ant-SECRETKEY' },
    })) as CallResult;

    const text = textOf(result);
    expect(text).toContain(RUNTIME_FAILURE.capabilityDenied);
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('sk-ant-SECRETKEY');
  });
});
