// @vitest-environment jsdom

import { Server, type Transport } from '@modelcontextprotocol/server';
import { cleanup, render, waitFor } from '@testing-library/react';
import { type MockAgent, startMockAgent } from 'agent-mcp-mock-agent';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTabId, useMcpTool } from '../../../src/index.ts';
import type { UnexpectedStateReport } from '../../../src/react/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';
import { declareSecureContext } from './harness.tsx';

// Two page instances connected AT THE SAME TIME, addressed by the identities the library minted.
//
// **Why this is a separate file from the identity suite, and what it adds.** That one drives page
// instances sequentially and compares the ids the gateway recorded — which establishes that two
// instances get two identities, and nothing about ROUTING. A selector that still answered from an
// arbitrary page would leave every case there green, because nothing there ever names an id and asks
// for an answer. This file does, through the agent's own control surface.
//
// **What is real and what is stood in for.** Both connections are real, live at once, and carry
// identities the library minted. One of them is a real provider — the library, its transport and its
// registry. The other is a stand-in MCP server on a second socket, because a second page instance is a
// second DOCUMENT and this environment has one. That is the honest boundary of what this layer can
// show, and the two-real-browser-pages version of the claim is the live run.

const KEY = Symbol.for('agent-mcp-react.page-instance-identity');
const validator = createAjvValidator();

let agent: MockAgent | undefined;
const openSockets: WebSocket[] = [];
let unexpected: UnexpectedStateReport[] = [];

afterEach(async () => {
  const reported = unexpected;
  try {
    cleanup();
    for (const socket of openSockets.splice(0)) socket.close();
    await agent?.close();
  } finally {
    agent = undefined;
    unexpected = [];
    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');
    delete (document as unknown as Record<symbol, unknown>)[KEY];
  }
  expect(reported).toEqual([]);
});

/** Reads the identity this document currently holds, minting one if there is none. */
function currentIdentity(): string {
  const held = (document as unknown as Record<symbol, { id: string } | undefined>)[KEY];
  if (held === undefined) throw new Error('nothing has minted an identity yet');
  return held.id;
}

/** Clears the marker so the next read mints a second, distinct identity. */
function mintAnother(read: () => string): string {
  delete (document as unknown as Record<symbol, unknown>)[KEY];
  return read();
}

function transportFor(socket: WebSocket): Transport {
  const transport: Transport = {
    async start(): Promise<void> {
      socket.addEventListener('message', (event) =>
        transport.onmessage?.(JSON.parse(String((event as MessageEvent).data))),
      );
      socket.addEventListener('close', () => transport.onclose?.());
    },
    async send(message): Promise<void> {
      socket.send(JSON.stringify(message));
    },
    async close(): Promise<void> {
      socket.close();
    },
  };
  return transport;
}

/** A second page instance, standing in for a second document, serving one named tool. */
async function serveSecondPage(tabId: string, toolName: string): Promise<void> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const socket = new WebSocket(agent.gateway.mintUrl(tabId));
  openSockets.push(socket);

  const server = new Server(
    { name: 'second-page', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: toolName,
        description: 'Belongs to the second page instance.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));
  await server.connect(transportFor(socket));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('the second page could not connect')));
  });
}

function FirstPage({ url }: { url: (tabId: string) => string }): ReactNode {
  const tabId = useMcpTabId();
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: () => url(tabId) }}
      server={{ name: 'first-page', version: '0.0.0' }}
      validation={{ validator }}
      onUnexpectedState={(failure: UnexpectedStateReport) => unexpected.push(failure)}
    >
      <FirstPageTools />
    </AgentMcpProvider>
  );
}

function FirstPageTools(): ReactNode {
  useMcpTool({
    name: 'first.only',
    description: 'Belongs to the first page instance.',
    handler: () => ({ ok: true }),
  });
  return null;
}

interface ToolsBody {
  readonly tools?: { readonly name: string }[];
  readonly error?: string;
}

async function tools(tabId: string): Promise<{ status: number; body: ToolsBody }> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const response = await fetch(`${agent.gateway.httpUrl}/tools?tab=${encodeURIComponent(tabId)}`);
  return { status: response.status, body: (await response.json()) as ToolsBody };
}

describe('two page instances connected at once', () => {
  it('each answer for themselves when addressed by the identity they minted', async () => {
    declareSecureContext();
    agent = await startMockAgent({ port: 0, handshakeTimeoutMs: 2_000 });

    render(<FirstPage url={(tabId) => agent?.gateway.mintUrl(tabId) ?? ''} />);
    await waitFor(() => expect(agent?.tabs().length).toBe(1));
    const first = currentIdentity();

    // A second page instance: a fresh document would have no marker, so removing it is that state.
    const second = mintAnother(() => {
      const marker = { id: crypto.randomUUID() };
      Object.defineProperty(document, KEY, { value: marker, configurable: true });
      return marker.id;
    });
    expect(second).not.toBe(first);

    await serveSecondPage(second, 'second.only');
    await waitFor(() => expect(agent?.tabs().filter((t) => t.state === 'ready').length).toBe(2));

    // **Both live, and each named id answers with its OWN tools.** This is the assertion the previous
    // version of this claim was missing: it compared acceptance records and never asked a question, so
    // a selector answering from an arbitrary page would have left it green.
    const fromFirst = await tools(first);
    expect(fromFirst.status).toBe(200);
    expect(fromFirst.body.tools?.map((tool) => tool.name)).toEqual(['first.only']);

    const fromSecond = await tools(second);
    expect(fromSecond.status).toBe(200);
    expect(fromSecond.body.tools?.map((tool) => tool.name)).toEqual(['second.only']);
  });

  it('are refused as ambiguous if they ever shared an identity', async () => {
    declareSecureContext();
    agent = await startMockAgent({ port: 0, handshakeTimeoutMs: 2_000 });

    render(<FirstPage url={(tabId) => agent?.gateway.mintUrl(tabId) ?? ''} />);
    await waitFor(() => expect(agent?.tabs().length).toBe(1));
    const shared = currentIdentity();

    // The collision this feature removes, reproduced deliberately by handing the second page the FIRST
    // one's identity. It is what the demonstrator's hardcoded `dashboard` produced for real.
    await serveSecondPage(shared, 'second.only');
    await waitFor(() => expect(agent?.tabs().filter((t) => t.state === 'ready').length).toBe(2));

    const ambiguous = await tools(shared);

    // Refused rather than answered from whichever connected first. The guard is the harness's, and it
    // is the safety net — what this feature does is make the collision stop happening, so the net is
    // never reached. Both halves matter, and this case pins the net.
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain(shared);
  });
});
