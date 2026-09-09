// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { type BrowserConnection, connectClient, startGateway } from 'agent-mcp-mock-agent';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../../src/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// What an agent HEARS while a real React tree renders, rerenders and navigates — over a real socket,
// with a real MCP client counting the notifications it actually receives.
//
// **The silences are the subject, and every one of them is paired with a positive control on the same
// connection.** A count of zero proves nothing on its own: a delivery path that was never wired at all
// produces zero for every case in this file. The pairing is what turns "we heard nothing" into "we
// heard nothing, and we would have."
//
// Counted at the CLIENT, never at the registry. The registry's change event is an input to the
// decision this feature makes; counting it would be counting the question rather than the answer.

const sharedValidator = createAjvValidator();

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

/**
 * Yields until the whole chain is quiet: React's effects, the registry's microtask, the publication
 * drain, and the socket.
 *
 * It ends on a `listTools()` round trip rather than on a turn count. That round trip is a real
 * request over the real socket, so it cannot complete before everything queued ahead of it on that
 * connection has been written — which is the synchronization this needs, rather than a number of
 * turns chosen because it was enough last time. The count was a tolerance rather than a fix, and a
 * notification arriving on turn 15 would have passed every zero and upper-bound assertion in this
 * file.
 */
async function settle(agent: { drain: () => Promise<unknown> }): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((r) => setImmediate(r));
    await agent.drain();
    for (let turn = 0; turn < 6; turn += 1) await new Promise((r) => setImmediate(r));
    await agent.drain();
  });
}

interface ListeningAgent {
  url: () => string;
  count: () => number;
  reset: () => void;
  names: () => Promise<string[]>;
  /** A real round trip on the same connection, used as a barrier. */
  drain: () => Promise<unknown>;
  /** Calls a tool and returns its text, so a silence can be paired with the tool still working. */
  call: (name: string) => Promise<string>;
  /** Resolves once the client exists and its notification handler is installed. */
  ready: () => Promise<void>;
}

/**
 * A gateway with a client attached, counting the notifications the client receives.
 *
 * **`ready()` is not a convenience.** The first version of this helper returned before the client and
 * its notification handler existed, so a case could run its negative phase with nothing listening —
 * counting zero because nobody was counting — and then install the handler in time for the positive
 * control to pass. Both halves would be green and neither would mean anything.
 */
async function listeningAgent(): Promise<ListeningAgent> {
  declareSecureContext();
  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });

  const gateway = await startGateway({ onConnection: (c) => announce?.(c) });
  toClose.push(() => gateway.close());

  let seen = 0;
  let client: Awaited<ReturnType<typeof connectClient>> | undefined;
  const listening = accepted.then(async (connection) => {
    const attached = await connectClient(connection);
    toClose.push(() => attached.close());
    attached.setNotificationHandler('notifications/tools/list_changed', () => {
      seen += 1;
    });
    client = attached;
  });

  const require = async (): Promise<NonNullable<typeof client>> => {
    await listening;
    if (client === undefined) throw new Error('the client never attached');
    return client;
  };

  return {
    url: () => gateway.mintUrl('tab-1'),
    count: () => seen,
    reset: () => {
      seen = 0;
    },
    ready: async () => {
      await listening;
    },
    drain: async () => (await require()).listTools(),
    call: async (name) => {
      const result = (await (await require()).callTool({ name, arguments: {} })) as {
        content?: { type?: string; text?: string }[];
      };
      return (result.content ?? []).map((block) => block.text ?? '').join('');
    },
    names: async () => {
      const listed = await (await require()).listTools();
      return listed.tools.map((tool) => tool.name).sort();
    },
  };
}

function Tool({ name, note }: { name: string; note?: string }): null {
  useMcpTool({
    name,
    description: note ?? `the ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    handler: () => name,
  });
  return null;
}

describe('what an agent hears while a tree renders', () => {
  it('hears nothing from a hundred rerenders, on a connection that is delivering', async () => {
    const agent = await listeningAgent();
    let bump: ((n: number) => void) | undefined;
    let renders = 0;

    function Screen(): React.ReactNode {
      const [tick, setTick] = useState(0);
      bump = setTick;
      renders += 1;
      // A declaration rebuilt on every render, with an INLINE input schema — a new object every time.
      // This is the ordinary way an author writes a tool, and the shape that costs one
      // withdraw-and-register cycle per rerender unless the descriptor is compared by CONTENT rather
      // than by identity.
      //
      // A negative tick mounts a SECOND tool. That is the positive control, and it has to be a real
      // change to the tool set rather than another rerender — which is what the first draft of this
      // case got wrong, asserting a pairing it did not have.
      return (
        <>
          <Tool name="quiet.one" />
          {tick < 0 ? <Tool name="quiet.two" /> : null}
        </>
      );
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.resolve(agent.url()) }}
        server={{ name: 'quiet', version: '0' }}
        validation={{ validator: sharedValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await agent.ready();
    await settle(agent);
    agent.reset();

    // **A hundred separate commits, not a hundred updates in one.** Batched inside a single `act`,
    // React collapses them into ONE render — so the first version of this case rendered once and
    // called it a hundred rerenders. Each `act` below is its own commit, which is what a component
    // rerendering during typing actually does.
    for (let turn = 0; turn < 100; turn += 1) {
      await act(async () => {
        bump?.(turn + 1);
      });
    }
    expect(renders).toBeGreaterThanOrEqual(100);
    await settle(agent);

    expect(agent.count()).toBe(0);

    // The pairing. Same connection, same handler — a genuine change to the tool set IS heard, so the
    // zero above is a silence and not a wire that was never connected.
    await act(async () => {
      bump?.(-1);
    });
    await settle(agent);
    expect(agent.count()).toBe(1);
    expect(await agent.names()).toEqual(['quiet.one', 'quiet.two']);
  });

  it('hears exactly one notification for a descriptor change', async () => {
    const agent = await listeningAgent();
    let describe: ((text: string) => void) | undefined;

    function Screen(): React.ReactNode {
      const [note, setNote] = useState('first');
      describe = setNote;
      return <Tool name="changing.one" note={note} />;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.resolve(agent.url()) }}
        server={{ name: 'changing', version: '0' }}
        validation={{ validator: sharedValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await agent.ready();
    await settle(agent);
    agent.reset();

    await act(async () => {
      describe?.('second');
    });
    await settle(agent);

    // Exactly one. A descriptor change is one withdraw-and-register cycle, and the agent must not
    // hear the withdrawal as a separate event — there is a window inside that cycle where the tool
    // does not exist, and an agent that listed in it would see the tool gone.
    expect(agent.count()).toBe(1);
    expect(await agent.names()).toEqual(['changing.one']);
  });
});

describe('a handler that changes without its descriptor changing', () => {
  it('costs the agent nothing, and the next call reaches the new handler', async () => {
    const agent = await listeningAgent();
    let setReply: ((text: string) => void) | undefined;

    function Screen(): React.ReactNode {
      const [reply, setReplyState] = useState('first');
      setReply = setReplyState;
      // Same name, same description, same schema — only the closed-over value the handler returns
      // differs. The agent's picture of the page is identical, so it must be told nothing.
      useMcpTool({
        name: 'stable.one',
        description: 'the stable.one tool',
        inputSchema: { type: 'object', properties: {} },
        handler: () => reply,
      });
      return null;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.resolve(agent.url()) }}
        server={{ name: 'stable', version: '0' }}
        validation={{ validator: sharedValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await agent.ready();
    await settle(agent);
    agent.reset();

    await act(async () => {
      setReply?.('second');
    });
    await settle(agent);

    expect(agent.count()).toBe(0);

    // And the silence is not because the tool stopped working: the call reaches the NEW handler.
    // This is the pairing — without it, a tool that had silently vanished would also count zero.
    const called = await agent.call('stable.one');
    expect(called).toContain('second');
  });
});

describe('a route change', () => {
  it('costs at most two notifications, however many tools move', async () => {
    const agent = await listeningAgent();
    let navigate: ((names: string[]) => void) | undefined;

    function Router(): React.ReactNode {
      const [names, setNames] = useState<string[]>(['a.one', 'a.two', 'a.three']);
      navigate = setNames;
      return (
        <>
          {names.map((name) => (
            <Tool key={name} name={name} />
          ))}
        </>
      );
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => Promise.resolve(agent.url()) }}
        server={{ name: 'router', version: '0' }}
        validation={{ validator: sharedValidator }}
        onUnexpectedState={() => undefined}
      >
        <Router />
      </AgentMcpProvider>,
    );
    await agent.ready();
    await settle(agent);
    agent.reset();

    await act(async () => {
      navigate?.(['b.one', 'b.two', 'b.three']);
    });
    await settle(agent);

    // Two, and the number is explained by the mechanism rather than tuned to it: the departing tools'
    // effect cleanups abort synchronously and coalesce into one registry event; the arriving
    // registrations travel through the asynchronous gateway and coalesce into another.
    expect(agent.count()).toBeGreaterThan(0);
    expect(agent.count()).toBeLessThanOrEqual(2);

    // And the listing after the last notification is the complete new set — the property that makes a
    // two-notification transition safe, because an agent re-listing on the first would otherwise be
    // left holding half a page.
    expect(await agent.names()).toEqual(['b.one', 'b.three', 'b.two']);

    // **Ten for ten**, and it has to be ten OUT as well as ten in — the first version of this
    // replaced three with ten, which says nothing about whether the count grows with the number
    // leaving. Then thirty for thirty.
    agent.reset();
    await act(async () => {
      navigate?.(Array.from({ length: 10 }, (_, index) => `c.${String(index)}`));
    });
    await settle(agent);
    agent.reset();

    await act(async () => {
      navigate?.(Array.from({ length: 10 }, (_, index) => `d.${String(index)}`));
    });
    await settle(agent);

    // A LOWER bound as well as an upper one. `toBeLessThanOrEqual(2)` alone is satisfied by zero, so
    // a disabled delivery path passed it — which is how the StrictMode case in this file shipped
    // green while proving nothing.
    expect(agent.count()).toBeGreaterThan(0);
    expect(agent.count()).toBeLessThanOrEqual(2);
    expect(await agent.names()).toHaveLength(10);

    agent.reset();
    await act(async () => {
      navigate?.(Array.from({ length: 30 }, (_, index) => `e.${String(index)}`));
    });
    await settle(agent);

    expect(agent.count()).toBeGreaterThan(0);
    expect(agent.count()).toBeLessThanOrEqual(2);
    expect(await agent.names()).toHaveLength(30);
  });
});

describe('StrictMode', () => {
  it('does not tell the agent about a set that never differed', async () => {
    const agent = await listeningAgent();
    let addSecond: ((on: boolean) => void) | undefined;

    function Screen(): React.ReactNode {
      const [second, setSecond] = useState(false);
      addSecond = setSecond;
      return (
        <>
          <Tool name="strict.one" />
          {second ? <Tool name="strict.two" /> : null}
        </>
      );
    }

    render(
      <StrictMode>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: () => Promise.resolve(agent.url()) }}
          server={{ name: 'strict', version: '0' }}
          validation={{ validator: sharedValidator }}
          onUnexpectedState={() => undefined}
        >
          <Screen />
        </AgentMcpProvider>
      </StrictMode>,
    );
    await agent.ready();
    await settle(agent);

    // Development mounts, unmounts and remounts every component. Whatever churn that causes in the
    // registry, the agent's picture went from nothing to one tool — so it is owed at most one
    // notification, never a pair describing a set that briefly vanished and came back.
    expect(agent.count()).toBeLessThanOrEqual(1);
    expect(await agent.names()).toEqual(['strict.one']);

    // **The pairing, and this case shipped without it.** `toBeLessThanOrEqual(1)` is satisfied by
    // zero, so a completely disabled notification path passed it — found by disabling `send` and
    // watching eight of ten cases in this suite fail while this one stayed green. A bound that a
    // broken mechanism satisfies is not an assertion about the mechanism.
    agent.reset();
    await act(async () => {
      addSecond?.(true);
    });
    await settle(agent);
    expect(agent.count()).toBe(1);
    expect(await agent.names()).toEqual(['strict.one', 'strict.two']);
  });
});
