import {
  type BrowserConnection,
  browserConnectionTransport,
  connectClient,
  type Gateway,
  startGateway,
} from '@agent-mcp/mock-agent';
import { Server, type Transport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

// A complete MCP round trip over a real socket: a server on the page side, this repository's gateway
// in the middle, and the mock agent's real MCP client driving `tools/list` and `tools/call`.
//
// Why it exists with no library code in the path: the client, the gateway and the framing are
// asserted on their own, and a client that has never completed an `initialize` handshake is a client
// nobody has run. This proves the harness the browser suites plug into, so their first failure is
// about the browser rather than about the harness.
//
// **The page side here is a stand-in, not a preview of the library.** It imports neither
// `src/transport/` nor `src/runtime/`; the server below is the minimum that answers the protocol,
// written inside the test because that is honestly what it is. This suite keeps asserting the gateway
// and the client, and the library's own transport gets its own cases.

let gateway: Gateway | undefined;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  await gateway?.close();
  gateway = undefined;
});

/**
 * A `Transport` over the page's end of the socket. One JSON-RPC message per text frame, with nothing
 * wrapped around it (docs/websocket-framing.md).
 */
function pageTransport(socket: WebSocket): Transport {
  const transport: Transport = {
    async start(): Promise<void> {
      socket.on('message', (data) => transport.onmessage?.(JSON.parse(data.toString())));
      socket.on('close', () => transport.onclose?.());
      socket.on('error', (error) => transport.onerror?.(error));
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

describe('an MCP round trip over the local gateway', () => {
  it('completes initialize, lists a tool and calls it', async () => {
    let accepted: ((connection: BrowserConnection) => void) | undefined;
    const connectionAccepted = new Promise<BrowserConnection>((resolve) => {
      accepted = resolve;
    });

    gateway = await startGateway({ onConnection: (connection) => accepted?.(connection) });

    // --- the page side: a socket, and an MCP server answering on it ---
    const pageSocket = new WebSocket(gateway.mintUrl('tab-under-test'));
    openSockets.push(pageSocket);
    await new Promise<void>((resolve, reject) => {
      pageSocket.once('open', resolve);
      pageSocket.once('error', reject);
    });

    const server = new Server(
      { name: 'page-under-test', version: '0.0.0' },
      // Declared up front because `sendToolListChanged()` throws without it, and a capability
      // discovered to be missing at the moment a tool set changes is discovered too late.
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'customers.set_filters',
          description: 'Applies the customer list filters.',
          inputSchema: {
            type: 'object' as const,
            properties: { status: { type: 'string' } },
            required: ['status'],
          },
        },
      ],
    }));
    server.setRequestHandler('tools/call', (request) => ({
      content: [
        { type: 'text' as const, text: `applied ${JSON.stringify(request.params.arguments)}` },
      ],
      structuredContent: { applied: true, arguments: request.params.arguments },
    }));
    await server.connect(pageTransport(pageSocket));

    // --- the agent side: the mock agent's real client over the accepted connection ---
    const connection = await connectionAccepted;
    expect(connection.tabId).toBe('tab-under-test');

    const client = await connectClient(connection);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['customers.set_filters']);

    const result = await client.callTool({
      name: 'customers.set_filters',
      arguments: { status: 'active' },
    });

    // Structured output is asserted alongside the text block, because carrying structure is the whole
    // reason the bridge invokes a handler directly rather than through a surface that serializes to a
    // string — the result contract carries structure, with the text block additional rather than the
    // only channel (docs/design.md#tool-results).
    expect(result.structuredContent).toEqual({ applied: true, arguments: { status: 'active' } });

    await client.close();
    await server.close();
  });

  it('reports a frame that is not JSON-RPC instead of dropping it', async () => {
    let accepted: ((connection: BrowserConnection) => void) | undefined;
    const connectionAccepted = new Promise<BrowserConnection>((resolve) => {
      accepted = resolve;
    });

    gateway = await startGateway({ onConnection: (connection) => accepted?.(connection) });

    const pageSocket = new WebSocket(gateway.mintUrl());
    openSockets.push(pageSocket);
    await new Promise<void>((resolve, reject) => {
      pageSocket.once('open', resolve);
      pageSocket.once('error', reject);
    });

    const connection = await connectionAccepted;
    const transport = browserConnectionTransport(connection);
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);
    await transport.start();

    pageSocket.send('this is not JSON');

    await expect.poll(() => errors.length).toBe(1);
    // The frame is named in the error. An unparseable frame that logs "parse error" and nothing else
    // leaves an operator staring at a socket with no way to tell what came across it — an unexpected
    // state fails loud rather than becoming a hidden unknown.
    expect(errors[0]?.message).toContain('this is not JSON');
  });
});
