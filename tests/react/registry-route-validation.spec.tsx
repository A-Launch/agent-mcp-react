import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, REACT_REFUSED, useMcpTool } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  testValidator,
  until,
} from './harness.ts';

// **The route nobody was watching.**
//
// This library puts a descriptor into the document's tool registry, and that descriptor carries a
// callback. The registry is shared with every script on the page, so that callback is reachable by
// any of them — an analytics snippet, a browser extension's content script, another MCP library.
// It does NOT go through the runtime, so none of the runtime's gates apply to it.
//
// Without a check in the runtime, that route would be guarded by whatever validation applications
// wrote inside their own handlers — and the whole selling point of validating in the runtime is
// deleting that code, which would have opened this route completely. Every case here calls through
// `document.modelContext` directly, the way a page script would, and never through an agent.
//
// What this cannot do is gate capability or per-tool policy on that route: those belong to the
// runtime's gate, and pretending otherwise here would be worse than the gap. What it can do is not
// regress.
//
// **A finding that changes what these cases prove, and is stated rather than glossed.** The portability
// shim currently in use validates arguments itself, before it reaches the callback this library
// registered — so on THIS registry the refusals below are the platform's, and these cases do not by
// themselves demonstrate that the library's own check ran. They demonstrate the property that matters
// either way: the call is refused and the handler is not entered.
//
// The library's check is kept regardless, and not as belt-and-braces. The registry is a moving draft
// this project does not control, a native implementation is not obliged to validate anything, and
// the conformance rule (docs/conformance.md) exists because a revision of the standard must be
// absorbable without discovering that a guarantee was actually the shim's. The check is asserted
// directly where it can be — against the bridged route, in
// `tests/transport/runtime/schemas.spec.ts` — and here the property is what is asserted.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(clearRegistry);

/** Calls a tool the way a page script would: through the registry, not through the runtime. */
async function callThroughRegistry(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('the document has no registry');
  // The registry's OWN invocation entry point — the one this library never uses for a bridged call,
  // and the one a page script reaches for. `executeTool` takes a descriptor from `getTools()`;
  // `callTool` takes a name. Both land on the same registered callback, which is the point: whichever
  // a page script picks, it arrives at application code without passing a single runtime gate.
  // Called ON the registry, not destructured off it: these are prototype methods that use `this`.
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  try {
    const result = await invoke.call(registry, name, JSON.stringify(args), undefined, true);
    const shaped = result as { isError?: boolean; content?: { text?: string }[] };
    const text =
      typeof result === 'string'
        ? result
        : (shaped.content ?? []).map((block) => block.text ?? '').join('');
    // A failing tool may surface as a RESULT carrying `isError` rather than as a throw, so a case that
    // only caught exceptions would read every refusal as a success.
    return {
      ok: shaped.isError !== true,
      text: text === '' ? JSON.stringify(result) : text,
    };
  } catch (cause) {
    return { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
  }
}

function Page({ onCall }: { onCall: () => void }): React.ReactNode {
  useMcpTool({
    name: 'panel.set',
    description: 'sets the panel',
    inputSchema: {
      type: 'object',
      properties: { level: { type: 'string', enum: ['low', 'high'] } },
      required: ['level'],
      additionalProperties: false,
    },
    handler: (input) => {
      onCall();
      return { set: input.level };
    },
  });
  return null;
}

async function mount(onCall: () => void): Promise<void> {
  render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      <Page onCall={onCall} />
    </AgentMcpProvider>,
  );
  await act(async () => {
    await until(async () => {
      const registry = (
        document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
      ).modelContext;
      const tools = (await registry?.getTools?.()) ?? [];
      return tools.length > 0;
    }, 'waited for the tool to reach the registry');
  });
}

describe('a page script calling the shared registry directly', () => {
  it('is refused when its arguments do not match the declared schema', async () => {
    let entered = 0;
    await mount(() => {
      entered += 1;
    });

    const refused = await callThroughRegistry('panel.set', { level: 'medium' });

    // The handler is the assertion. This route reaches application code directly, so a check that
    // only inspected the returned value would pass for a handler that ran and then reported failure.
    expect(entered).toBe(0);
    expect(refused.ok).toBe(false);
    // Refused with a validation message. WHICH layer produced it is the platform's business today —
    // see the header — so the assertion is deliberately not on our own wording. Asserting a message
    // this shim never produces would be a case that passes, when it passes, for a reason unrelated to
    // its claim.
    expect(refused.text.toLowerCase()).toContain('validation');
  });

  it('is refused by the REGISTRY before we see it, so no observer learns of it', async () => {
    // **Reported from the field: an operator watching the call log reads silence as "nobody called
    // it".** What actually happens is that the adopted registry validates arguments against the
    // declared schema itself, in `validateArgsForTool`, and throws before it ever invokes the
    // descriptor's callback. This library's own validation on this route — and the observation it
    // reports — is downstream of a call that never arrives.
    //
    // The library is not silent by choice and cannot be made to speak: there is no signal to observe.
    // What can be done is to stop the silence being mistaken for absence, which is why this is a case
    // rather than a paragraph.
    //
    // **If a registry ever stops pre-validating, this goes red** — our check runs, the refusal is
    // observed, and the expectation below becomes false. That is the right moment to learn it, and it
    // is why the assertion is on the absence rather than on the mechanism producing it.
    const errors: { code?: string }[] = [];
    let entered = 0;
    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
        onToolError={(event) => {
          const failure = event.failure;
          errors.push(failure !== undefined && 'code' in failure ? { code: failure.code } : {});
        }}
      >
        <Page
          onCall={() => {
            entered += 1;
          }}
        />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(async () => {
        const registry = (
          document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
        ).modelContext;
        const tools = (await registry?.getTools?.()) ?? [];
        return tools.length > 0;
      }, 'waited for the tool to reach the registry');
    });

    const refused = await callThroughRegistry('panel.set', { level: 'medium' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refused.ok).toBe(false);
    expect(entered).toBe(0);
    // The whole point: refused, and nothing to see.
    expect(errors).toEqual([]);
  });

  it('reaches the handler when they do — so the refusal above is a check, not a broken route', async () => {
    let entered = 0;
    await mount(() => {
      entered += 1;
    });

    const accepted = await callThroughRegistry('panel.set', { level: 'high' });

    expect(accepted.ok).toBe(true);
    expect(entered).toBe(1);
  });

  it('refuses a missing required field', async () => {
    let entered = 0;
    await mount(() => {
      entered += 1;
    });

    const refused = await callThroughRegistry('panel.set', {});
    expect(entered).toBe(0);
    expect(refused.text).toContain('level');
  });
});

// **The OUTPUT half of the same route.**
//
// The ownership entry's own comment claims that "both call routes use these same objects… One
// compiled contract per tool, so the two routes cannot enforce different things". That was true of
// INPUT and false of OUTPUT: the bridge validated a result and this route returned the handler's
// value to the page script unchecked. The claim was wrong for six
// features and nothing could see it, because no case asked.
//
// It is a CONTRACT fix rather than a confidentiality one, and the distinction matters for what these
// cases may claim. Bounding what a page script receives buys no secrecy — it already holds the whole
// JS heap. What it buys is that ONE declaration means ONE checked contract, whoever calls.

/** A tool whose handler can be told to return something its declared output schema forbids. */
function Reporter({ produce }: { produce: () => unknown }): React.ReactNode {
  useMcpTool({
    name: 'panel.report',
    description: 'reports the panel',
    outputSchema: {
      type: 'object',
      properties: { level: { type: 'string' }, count: { type: 'number' } },
      required: ['level'],
    },
    handler: () => produce(),
  });
  return null;
}

async function mountReporter(produce: () => unknown): Promise<void> {
  render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      <Reporter produce={produce} />
    </AgentMcpProvider>,
  );
  await act(async () => {
    await until(async () => {
      const registry = (
        document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
      ).modelContext;
      const tools = (await registry?.getTools?.()) ?? [];
      return tools.length > 0;
    }, 'waited for the reporting tool to reach the registry');
  });
}

describe('a page script receiving a result', () => {
  it('is refused when the handler returns something the declared output schema forbids', async () => {
    await mountReporter(() => ({ count: 3 }));

    const refused = await callThroughRegistry('panel.report', {});

    expect(refused.ok).toBe(false);
    // **Asserted on OUR OWN wording, unlike the input cases above** — and that difference is evidence
    // rather than inconsistency. There, the shim validates arguments before our callback runs, so the
    // refusal may be the platform's and asserting our message would be asserting something we cannot
    // guarantee. Here, NO registry implementation checks a RESULT: this sentence exists in exactly one
    // place in this repository, so its arrival proves the library's own check ran.
    expect(refused.text).toContain('does not match its declared output schema');
    // **The field path does NOT cross, and that is the opposite of the input rule.** On input, naming
    // the field is corrective — it is an identifier the agent sent and can fix. On OUTPUT the detail
    // is application-derived and the caller cannot act on it: Ajv names the offending property for an
    // `additionalProperties` failure, and an object's keys are routinely identifiers. This case
    // originally asserted that `level` crossed; a review showed why it must not.
    expect(refused.text).not.toContain('level');
  });

  it('loses our error CODE to the shim, which is why the observation surface carries it', async () => {
    // **A finding, recorded as a case rather than as a comment.** `AgentMcpReactError` carries a
    // `code` from a closed set, and on this route the caller never sees it: the shim catches whatever
    // the descriptor's callback throws and re-raises it as its own `UnknownError`, preserving the
    // message and dropping everything else. A page script therefore cannot branch on the code here,
    // however carefully we choose one.
    //
    // That is not a defect to fix in this feature — the registry is a moving draft this project does
    // not control, and re-raising through it is the standard's behaviour, not ours. It is a limit on
    // what this route can promise, and it is the reason the code is asserted through the observation
    // surface below instead of through what the caller catches. A future revision that started
    // preserving the code would make this case fail, which is the right moment to learn it.
    await mountReporter(() => ({ count: 3 }));

    const refused = await callThroughRegistry('panel.report', {});

    expect(refused.text).not.toContain(REACT_REFUSED.resultViolatesOutputSchema);
  });

  it('reports the refusal to the observation surface with its own code, never the arguments one', async () => {
    const errors: { code?: string }[] = [];
    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
        onToolError={(event) => {
          // Narrowed rather than cast: `ObservedFailure` is a union whose `uncoded` arm has no code
          // at all, which is the distinction between "a check refused this" and "the application
          // threw". Casting past it would let an uncoded failure be read as a coded one.
          const failure = event.failure;
          errors.push(failure !== undefined && 'code' in failure ? { code: failure.code } : {});
        }}
      >
        <Reporter produce={() => ({ count: 3 })} />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(async () => {
        const registry = (
          document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
        ).modelContext;
        const tools = (await registry?.getTools?.()) ?? [];
        return tools.length > 0;
      }, 'waited for the reporting tool to reach the registry');
    });

    await callThroughRegistry('panel.report', {});
    // The surface delivers on a microtask, deliberately outside the call path.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The distinction the two codes exist for: a caller told its ARGUMENTS were refused would believe
    // nothing happened and retry — performing the mutation a second time. Merging them would be
    // invisible in every case that only asked "was it refused".
    expect(errors.map((e) => e.code)).toContain(REACT_REFUSED.resultViolatesOutputSchema);
    expect(errors.map((e) => e.code)).not.toContain(REACT_REFUSED.argumentsInvalid);
  });

  it('passes a conforming result through unchanged', async () => {
    await mountReporter(() => ({ level: 'high', count: 3 }));

    const accepted = await callThroughRegistry('panel.report', {});

    expect(accepted.ok).toBe(true);
    expect(accepted.text).toContain('high');
  });

  it('does NOT reject a field the schema never mentioned — the schema is a contract, not a filter', async () => {
    // The central decision about a declared schema, asserted on this route because it is where the
    // temptation to "tidy up" would land. A closed variant of the author's schema is NEVER
    // synthesized: it would
    // advertise one contract while enforcing another, and it cannot express secrecy anyway —
    // `user: {type:'object'}` passes everything beneath it.
    await mountReporter(() => ({ level: 'high', undeclared: 'still crosses' }));

    const accepted = await callThroughRegistry('panel.report', {});

    expect(accepted.ok).toBe(true);
    expect(accepted.text).toContain('still crosses');
  });

  it('leaves a tool that declared no output schema entirely alone', async () => {
    // The check must be *not applicable* to such a tool rather than skipped for it — the same
    // distinction drawn for input. A tool promising nothing about its output can return anything,
    // and inventing a contract for it would break every existing tool on this route.
    function Unschemad(): React.ReactNode {
      useMcpTool({
        name: 'panel.freeform',
        description: 'promises nothing',
        handler: () => ({ anything: [1, 2, 3] }),
      });
      return null;
    }
    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Unschemad />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(async () => {
        const registry = (
          document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
        ).modelContext;
        const tools = (await registry?.getTools?.()) ?? [];
        return tools.length > 0;
      }, 'waited for the freeform tool to reach the registry');
    });

    const accepted = await callThroughRegistry('panel.freeform', {});

    expect(accepted.ok).toBe(true);
    // The handler's value reaches the caller unchanged, which is the assertion: a tool that promised
    // nothing about its output has no contract to violate, so nothing may be invented for it.
    expect(accepted.text).toContain('anything');
  });
});

// **The two routes must reach the SAME verdict, and this is where that is pinned.**
//
// This route first validated the raw handler return, reasoning that a page script receives the live
// object. That reasoning was wrong: the browser tool registry "serializes a result to a JSON string"
// (docs/conformance.md), so what a page script receives is the round trip, exactly as the agent
// does. Both routes normalize with the SAME function now.
//
// The divergence was measured in both directions before the fix, and each case below is one of them.
// Neither is exotic — a `Date` in a state object and a `toJSON` on a domain model are ordinary things
// for an application to return, and both produced a verdict that depended on who called.

describe('the two routes agree on what a result IS', () => {
  it('rejects a value whose serialized form violates the schema, though the raw object satisfies it', async () => {
    // `{ value: { toJSON: () => null } }` satisfies `value: { type: 'object' }` as a live object and
    // serializes to `{"value":null}`, which does not. Before the fix this route ACCEPTED it and
    // delivered a payload that violated the tool's own declared schema, while the agent was refused
    // the identical return.
    function Collapsing(): React.ReactNode {
      useMcpTool({
        name: 'panel.collapse',
        description: 'returns something whose serialized form differs',
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'object' } },
          required: ['value'],
        },
        handler: () => ({ value: { toJSON: () => null } }),
      });
      return null;
    }
    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Collapsing />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(async () => {
        const registry = (
          document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
        ).modelContext;
        return ((await registry?.getTools?.()) ?? []).length > 0;
      }, 'waited for the collapsing tool');
    });

    const result = await callThroughRegistry('panel.collapse', {});

    expect(result.ok).toBe(false);
    expect(result.text).toContain('does not match its declared output schema');
  });

  it('accepts a Date under a string schema, because that is what the caller receives', async () => {
    // The other direction, and the one that would have refused perfectly correct code. A `Date` is
    // not a string as a live object, and IS one by the time anybody reads it. Validating raw refused
    // this for a page script while the agent was served it happily.
    function Dated(): React.ReactNode {
      useMcpTool({
        name: 'panel.when',
        description: 'returns a date',
        outputSchema: {
          type: 'object',
          properties: { when: { type: 'string' } },
          required: ['when'],
        },
        handler: () => ({ when: new Date('2020-01-01T00:00:00.000Z') }),
      });
      return null;
    }
    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Dated />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(async () => {
        const registry = (
          document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
        ).modelContext;
        return ((await registry?.getTools?.()) ?? []).length > 0;
      }, 'waited for the dated tool');
    });

    const result = await callThroughRegistry('panel.when', {});

    expect(result.ok).toBe(true);
    expect(result.text).toContain('2020-01-01');
  });
});

describe('one compiled contract, not two that agree', () => {
  it('moves the registry route to the NEW schema when the declaration changes', async () => {
    // **The observable half of the identity claim.** Every other case here could pass with the
    // registry route holding a SECOND compilation of the same schema — the two would agree, until one
    // was recompiled and the other was not. The ownership entry makes the stronger claim in its own
    // comment: "Both call routes use these same objects… One compiled contract per tool, so the two
    // routes cannot enforce different things."
    //
    // What a case can actually see is that a schema change reaches THIS route, which is what would
    // fail if the descriptor's callback closed over a compilation of its own. The gateway compiles
    // once per registration and hands that one object to both the ownership entry and this ref, which
    // is what makes agreement into identity.
    function Versioned({ strict }: { strict: boolean }): React.ReactNode {
      useMcpTool({
        name: 'panel.versioned',
        description: 'declares an output contract that changes',
        outputSchema: strict
          ? { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
          : { type: 'object', properties: { ok: { type: 'boolean' } } },
        handler: () => ({ other: 1 }),
      });
      return null;
    }
    const host = (strict: boolean): React.ReactNode => (
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Versioned strict={strict} />
      </AgentMcpProvider>
    );

    const view = render(host(false));
    await act(async () => {
      await until(async () => {
        const registry = (
          document as unknown as { modelContext?: { getTools?: () => Promise<unknown[]> } }
        ).modelContext;
        return ((await registry?.getTools?.()) ?? []).length > 0;
      }, 'waited for the versioned tool');
    });

    // Lax schema: `{ other: 1 }` is fine, because `ok` is not required.
    expect((await callThroughRegistry('panel.versioned', {})).ok).toBe(true);

    view.rerender(host(true));
    await act(async () => {
      await until(
        async () => (await callThroughRegistry('panel.versioned', {})).ok === false,
        'waited for the new schema to reach the registry route',
      );
    });

    // Strict schema: the same handler return is now refused, on this route, without anything here
    // touching the runtime.
    const refused = await callThroughRegistry('panel.versioned', {});
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('does not match its declared output schema');
  });
});
