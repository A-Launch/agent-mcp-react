// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpState, useMcpTool } from '../../../src/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// **The feature's actual claim, driven end to end.** A React component declares state, a real MCP
// client over a real socket lists the tool, calls it, and receives what the page is rendering.
//
// This is the shape the acceptance scenario's read-back steps need — "agent calls
// customers.get_state; returned state contains status = ['active']"
// (docs/design.md#the-acceptance-scenario) — and it is the reason state inspection exists. The
// scenario itself is driven end to end by `tests/integration/`; what is proved here is that the step
// it needs is expressible.
//
// Nothing is mocked. The gateway is real, the socket is real, and the client is the SDK's. A case
// that asserted against the library's own registry would be a test of the registry.

const SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    resultCount: { type: 'number' },
  },
  required: ['query', 'resultCount'],
} as const;

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

afterEach(closeAll);

/** A page whose state an agent can both change and read back — the acceptance scenario's pairing. */
function Customers(): React.ReactNode {
  const [query, setQuery] = useState('');
  const total = 48;
  // A trivially "filtered" count, so a read after a change is observably different rather than
  // merely differently spelled.
  const resultCount = query === '' ? total : 14;

  useMcpTool({
    name: 'customers.set_filters',
    description: 'Sets the customer query filter.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (input) => {
      setQuery(String(input.query));
      return { applied: input.query };
    },
  });

  useMcpState({
    name: 'customers',
    description: 'The current customer list state.',
    schema: SCHEMA as unknown as Record<string, unknown>,
    getState: () => ({ query, resultCount }),
  });

  return <output data-testid="count">{`${resultCount} of ${total}`}</output>;
}

describe('an agent reading application state over a real socket', () => {
  it('lists the derived tool with the declared description', async () => {
    const under = await stack(<Customers />);
    await act(async () => {
      await until(async () => (await listedNames(under.client)).length >= 2, 'waited for listing');
    });

    expect(await listedNames(under.client)).toContain('customers.get_state');

    const listed = await under.client.listTools();
    const state = listed.tools.find((tool) => tool.name === 'customers.get_state');
    expect(state?.description).toBe('The current customer list state.');
    // A read takes no arguments, so the tool advertises no properties to supply. Asserted because an
    // agent choosing a call reads this, and a phantom parameter would have it inventing one.
    expect(state?.inputSchema?.properties ?? {}).toEqual({});
  });

  it('returns the current state, with structured content alongside the text rendering', async () => {
    const under = await stack(<Customers />);
    await act(async () => {
      await until(async () => (await listedNames(under.client)).length >= 2, 'waited for listing');
    });

    const result = (await under.client.callTool({
      name: 'customers.get_state',
      arguments: {},
    })) as CallResult;

    expect(result.isError).not.toBe(true);
    // Structured content is ADDITIONAL, never instead of (docs/design.md#tool-results). A client that
    // does not read structured
    // content must still receive something it can use, so both channels are asserted rather than
    // whichever one happens to be convenient.
    expect(result.structuredContent).toEqual({ query: '', resultCount: 48 });
    expect(textOf(result)).toContain('48');
  });

  it('reads back what the agent just changed, and the SCREEN agrees — acceptance scenario steps 9 and 10', async () => {
    const under = await stack(<Customers />);
    await act(async () => {
      await until(async () => (await listedNames(under.client)).length >= 2, 'waited for listing');
    });

    const before = (await under.client.callTool({
      name: 'customers.get_state',
      arguments: {},
    })) as CallResult;
    expect(before.structuredContent).toEqual({ query: '', resultCount: 48 });

    await act(async () => {
      await under.client.callTool({
        name: 'customers.set_filters',
        arguments: { query: 'acme' },
      });
    });

    const after = (await under.client.callTool({
      name: 'customers.get_state',
      arguments: {},
    })) as CallResult;

    expect(after.structuredContent).toEqual({ query: 'acme', resultCount: 14 });

    // **The assertion that makes this a test of the product rather than of a return value.** A handler
    // that reported success while the DOM never changed is this system's characteristic defect. What
    // the agent was told and what a person is looking at must be the same thing.
    expect(under.rendered.getByTestId('count').textContent).toBe('14 of 48');
  });

  it('sends no notification when the state moves, only when the tool set does', async () => {
    const under = await stack(<Customers />);
    await act(async () => {
      await until(async () => (await listedNames(under.client)).length >= 2, 'waited for listing');
    });

    const baseline = under.notifications();

    await act(async () => {
      await under.client.callTool({
        name: 'customers.set_filters',
        arguments: { query: 'acme' },
      });
    });
    await act(async () => {
      await under.client.callTool({
        name: 'customers.set_filters',
        arguments: { query: 'acme corp' },
      });
    });

    // The state moved twice and the tool set did not move at all. Counted at the BROWSER side of the
    // socket, which is the side that decides to send — a count taken at the client could not tell
    // "nothing was sent" from "something was sent and dropped".
    expect(under.notifications()).toBe(baseline);
  });
});

describe('a state read with the application capability withheld', () => {
  it('is refused at invocation, and stays in the listing', async () => {
    const under = await stack(<Customers />);
    await act(async () => {
      await until(async () => (await listedNames(under.client)).length >= 2, 'waited for listing');
    });
    under.grant(NOTHING_GRANTED);
    await act(async () => {
      await Promise.resolve();
    });

    const refused = (await under.client.callTool({
      name: 'customers.get_state',
      arguments: {},
    })) as CallResult;

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(RUNTIME_FAILURE.capabilityDenied);

    // **Refused at invocation, NOT removed from the listing** — absence from a listing is not an
    // access control (docs/explanation-reachability.md#the-approach-refuse-at-invocation). A shrinking
    // listing reads to an
    // agent as an application that unmounted its features, which is a different and wrong story.
    expect(await listedNames(under.client)).toContain('customers.get_state');
  });

  it('still runs for a script on the page — a capability governs the bridge and not the page, asserted rather than documented', async () => {
    // The pairing that makes the case above a test of a CAPABILITY rather than of a withdrawal. A
    // capability governs this library's bridge; it does not and cannot govern the page. An operator
    // who reads `application: false` as "locked down" has misread it, and this is the assertion that
    // keeps that true rather than aspirational.
    const under = await stack(<Customers />);
    await act(async () => {
      await until(async () => (await listedNames(under.client)).length >= 2, 'waited for listing');
    });
    under.grant(NOTHING_GRANTED);
    await act(async () => {
      await Promise.resolve();
    });

    const registry = (document as unknown as { modelContext?: Record<string, unknown> })
      .modelContext;
    const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
      .executeToolByName;
    const raw = await invoke.call(
      registry,
      'customers.get_state',
      JSON.stringify({}),
      undefined,
      true,
    );
    const shaped = (typeof raw === 'string' ? JSON.parse(raw) : raw) as CallResult;

    expect(shaped.isError).not.toBe(true);
    expect(shaped.structuredContent).toEqual({ query: '', resultCount: 48 });
  });
});
