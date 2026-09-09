import { Server } from '@modelcontextprotocol/server';
import {
  type BrowserConnection,
  connectClient,
  type Gateway,
  startGateway,
} from 'agent-mcp-mock-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';

// The feature, end to end: a real MCP client, a real gateway, a real socket, and this library's
// transport carrying the page's MCP server.
//
// Nothing here is stubbed. The repository's first round trip had to supply a stand-in for the page's
// transport because none existed; this is that stand-in replaced by the real thing, which is the only
// way to find out
// whether the framing this module writes is the framing the agent's client can read.
//
// The URL comes from `gateway.mintUrl()` — the gateway's own ticket-bearing URL. That is the seam
// working as specified: the transport is handed a URL, dials it, and never learns that part of it was
// a credential.

let gateway: Gateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

/** Stands up the gateway and returns a promise for the connection it accepts. */
async function gatewayAcceptingOneConnection(): Promise<{
  gateway: Gateway;
  accepted: Promise<BrowserConnection>;
}> {
  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });
  const started = await startGateway({ onConnection: (connection) => announce?.(connection) });
  gateway = started;
  return { gateway: started, accepted };
}

/** A page-side MCP server exposing one tool that echoes what it was called with. */
function pageServer(): Server {
  const server = new Server(
    { name: 'page-under-test', version: '0.0.0' },
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
  return server;
}

describe('a full MCP exchange over this transport', () => {
  it('completes initialize, lists a tool and calls it', async () => {
    const { gateway: started, accepted } = await gatewayAcceptingOneConnection();

    const server = pageServer();
    // `connect()` installs the callbacks and then calls `start()` itself. Nothing else may call it:
    // a transport started before the callbacks exist drops whatever arrives in that window.
    await server.connect(
      createBrowserWebSocketTransport({ getUrl: () => started.mintUrl('tab-under-test') }),
    );

    const connection = await accepted;
    expect(connection.tabId).toBe('tab-under-test');

    const client = await connectClient(connection);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['customers.set_filters']);

    const result = await client.callTool({
      name: 'customers.set_filters',
      arguments: { status: 'active' },
    });
    expect(result.structuredContent).toEqual({ applied: true, arguments: { status: 'active' } });

    await client.close();
    await server.close();
  });

  it('gives every one of several in-flight requests its own response', async () => {
    const { gateway: started, accepted } = await gatewayAcceptingOneConnection();

    const server = new Server(
      { name: 'page-under-test', version: '0.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'echo',
          description: 'Returns what it was given.',
          inputSchema: { type: 'object' as const, properties: { n: { type: 'number' } } },
        },
      ],
    }));
    // Deliberately answered out of arrival order: a higher `n` waits longer, so if the transport
    // serialized or coalesced anything, the responses would arrive matched to the wrong requests.
    server.setRequestHandler('tools/call', async (request) => {
      const n = (request.params.arguments as { n: number }).n;
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 10));
      return { content: [{ type: 'text' as const, text: String(n) }], structuredContent: { n } };
    });
    await server.connect(createBrowserWebSocketTransport({ getUrl: () => started.mintUrl() }));

    const client = await connectClient(await accepted);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => client.callTool({ name: 'echo', arguments: { n } })),
    );

    // Each response matched to its own request — none lost, duplicated or mismatched.
    expect(results.map((result) => result.structuredContent)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
      { n: 5 },
    ]);

    await client.close();
    await server.close();
  });
});
