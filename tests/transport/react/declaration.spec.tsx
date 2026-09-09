// @vitest-environment jsdom
import { type BrowserConnection, connectClient, startGateway } from '@agent-mcp/mock-agent';
import { act, cleanup, render } from '@testing-library/react';
import { Component, type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../../src/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// What an AGENT sees when a schema-declaring tool has no validator: nothing.
//
// This is the central rule of argument validation and the one an application feels first, so it is
// asserted from
// the far end of a real socket rather than from the registry. A tool that is merely absent from the
// registry might still be reachable some other way; a tool an MCP client cannot list and cannot call
// is genuinely not exposed.
//
// The pairing carries the whole file: the SAME component, on the SAME kind of connection, with the
// validator supplied. Without it, a page where nothing worked at all would pass the first case.

const toClose: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  cleanup();
  for (const close of toClose.splice(0)) await close();
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
});

function declareSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

async function agent(): Promise<{
  url: () => string;
  names: () => Promise<string[]>;
  describe: (name: string) => Promise<{ properties?: unknown } | undefined>;
  call: (name: string) => Promise<{ failed: boolean; text: string }>;
  notifications: () => number;
  resetNotifications: () => void;
  settle: () => Promise<void>;
}> {
  declareSecureContext();
  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });
  const gateway = await startGateway({ onConnection: (c) => announce?.(c) });
  toClose.push(() => gateway.close());

  let client: Awaited<ReturnType<typeof connectClient>> | undefined;
  let seen = 0;
  const attached = accepted.then(async (connection) => {
    const made = await connectClient(connection);
    toClose.push(() => made.close());
    made.setNotificationHandler('notifications/tools/list_changed', () => {
      seen += 1;
    });
    client = made;
  });

  const require = async (): Promise<NonNullable<typeof client>> => {
    await attached;
    if (client === undefined) throw new Error('the client never attached');
    return client;
  };

  return {
    url: () => gateway.mintUrl('tab-1'),
    settle: async () => {
      await act(async () => {
        for (let turn = 0; turn < 10; turn += 1) await new Promise((r) => setImmediate(r));
        await (await require()).listTools();
        for (let turn = 0; turn < 6; turn += 1) await new Promise((r) => setImmediate(r));
      });
    },
    names: async () => (await (await require()).listTools()).tools.map((tool) => tool.name).sort(),
    describe: async (name: string) => {
      const listed = (await (await require()).listTools()) as {
        tools: { name: string; outputSchema?: { properties?: unknown } }[];
      };
      return listed.tools.find((tool) => tool.name === name)?.outputSchema;
    },
    notifications: () => seen,
    resetNotifications: () => {
      seen = 0;
    },
    call: async (name) => {
      const result = (await (await require()).callTool({ name, arguments: { level: 'low' } })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      return {
        failed: result.isError === true,
        text: (result.content ?? []).map((block) => block.text ?? '').join(''),
      };
    },
  };
}

function Screen(): React.ReactNode {
  useMcpTool({
    name: 'panel.set',
    description: 'sets the panel',
    inputSchema: {
      type: 'object',
      properties: { level: { type: 'string', enum: ['low', 'high'] } },
    },
    handler: (input) => ({ set: input.level }),
  });
  // A tool alongside it that declares NO schema, so the two outcomes can be told apart on one page.
  useMcpTool({
    name: 'panel.ping',
    description: 'no schema at all',
    handler: () => 'pong',
  });
  return null;
}

/** Records what an error boundary caught, so a loud refusal is observable rather than fatal. */
class Boundary extends Component<{ into: unknown[]; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    this.props.into.push(error);
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

describe('a tool that declares a schema with no validator installed', () => {
  it('is refused loudly at declaration, naming the tool and the fix', async () => {
    // **In development the refusal is thrown to the AUTHOR**, which is the designed behaviour and the
    // same shape a duplicate name has: stopped at the moment it can be fixed, rather than discovered
    // later as a tool an agent cannot see. Production reports instead and leaves the page standing.
    //
    // So this case asserts the development contract, and the agent-facing half — that the tool is
    // absent from `tools/list` — follows from it: a registration that threw never happened.
    const caught: unknown[] = [];
    const listener = await agent();

    render(
      <Boundary into={caught}>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: () => Promise.resolve(listener.url()) }}
          server={{ name: 'unvalidated', version: '0' }}
          onUnexpectedState={() => undefined}
        >
          <Screen />
        </AgentMcpProvider>
      </Boundary>,
    );
    await listener.settle();

    expect(caught).toHaveLength(1);
    const message = (caught[0] as Error).message;
    expect(message).toContain('panel.set');
    // The message has to be actionable, not merely correct: an author reading it should not have to
    // find this feature's specification to learn what to do.
    expect(message).toContain('@agent-mcp/react/validation');
  });
});

describe('the same component with a validator supplied', () => {
  it('lists the tool and calls it', async () => {
    const listener = await agent();

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.resolve(listener.url()) }}
        server={{ name: 'validated', version: '0' }}
        validation={{ validator: createAjvValidator() }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await listener.settle();

    expect(await listener.names()).toEqual(['panel.ping', 'panel.set']);

    const called = await listener.call('panel.set');
    expect(called.failed).toBe(false);
    expect(called.text).toContain('low');
  });
});

describe('an output schema is agent-visible even though the registry cannot carry one', () => {
  it('appears in the listing, and a change to it alone still reaches the agent', async () => {
    const listener = await agent();
    let widen: ((on: boolean) => void) | undefined;

    function Reporting(): React.ReactNode {
      const [wide, setWide] = useState(false);
      widen = setWide;
      useMcpTool({
        name: 'panel.report',
        description: 'reports',
        // Only the OUTPUT schema differs between the two states. The name, the description and the
        // input schema are identical, so nothing the document registry can see changes at all.
        outputSchema: wide
          ? { type: 'object', properties: { n: { type: 'number' }, extra: { type: 'string' } } }
          : { type: 'object', properties: { n: { type: 'number' } } },
        handler: () => ({ n: 1 }),
      });
      return null;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.resolve(listener.url()) }}
        server={{ name: 'reporting', version: '0' }}
        validation={{ validator: createAjvValidator() }}
        onUnexpectedState={() => undefined}
      >
        <Reporting />
      </AgentMcpProvider>,
    );
    await listener.settle();

    const before = await listener.describe('panel.report');
    expect(before).toBeDefined();
    expect(Object.keys((before?.properties ?? {}) as object)).toEqual(['n']);

    listener.resetNotifications();
    await act(async () => {
      widen?.(true);
    });
    await listener.settle();

    // **The subtlety this case exists for.** The document registry's descriptor has no output schema,
    // so changing only the output schema produces NO registry change event. It reaches the agent at
    // all because the listing is derived from the ownership record, and it is NOTICED because the
    // publication token includes it — omit it there and the publisher compares equal and says nothing.
    const after = await listener.describe('panel.report');
    expect(Object.keys((after?.properties ?? {}) as object).sort()).toEqual(['extra', 'n']);
    expect(listener.notifications()).toBeGreaterThan(0);
  });
});
