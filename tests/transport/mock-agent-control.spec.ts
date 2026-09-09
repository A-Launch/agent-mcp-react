import { Server, type Transport } from '@modelcontextprotocol/server';
import { type MockAgent, startMockAgent } from 'agent-mcp-mock-agent';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

// The control surface the CLI drives — `/tabs`, `/tools`, `/call` — end to end over a real socket.
//
// It is asserted here rather than in `unit` because the whole point of the surface is that it acts on
// a connection this process is holding: an MCP client, a real socket and a page answering on the other
// end. Stubbing any of the three would test the stub.
//
// The page side is a stand-in for the library that does not exist yet, exactly as in the round-trip
// suite. What is under test is the runtime, the client and the routing.

let agent: MockAgent | undefined;
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.terminate();
  await agent?.close();
  agent = undefined;
});

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

/**
 * Opens a page socket and attaches an MCP server serving one named tool.
 *
 * The server is connected BEFORE the socket finishes opening, on purpose. The mock agent sends
 * `initialize` the instant the gateway accepts the connection, so a page that attaches its message
 * listener after `open` misses it — and the real library has no such gap, because its transport
 * creates the socket inside `start()`. A helper that opened first and served second would be testing
 * an ordering the library never produces.
 */
async function servePage(tabId: string | undefined, toolName: string): Promise<WebSocket> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const socket = new WebSocket(agent.gateway.mintUrl(tabId));
  openSockets.push(socket);

  const server = new Server(
    { name: 'page-under-test', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: toolName,
        description: 'A tool the page exposes.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler('tools/call', (request) => ({
    content: [{ type: 'text' as const, text: `called ${request.params.name}` }],
    structuredContent: { called: request.params.name, arguments: request.params.arguments ?? {} },
  }));
  await server.connect(pageTransport(socket));

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** Opens a page socket that answers nothing — a page with no MCP server on it. */
async function openSilentPage(tabId?: string): Promise<WebSocket> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const socket = new WebSocket(agent.gateway.mintUrl(tabId));
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** The shapes the control surface answers with. Named so no case reaches for `any`. */
interface ToolsBody {
  readonly tools?: ReadonlyArray<{ readonly name: string }>;
  readonly error?: string;
}
interface TabsBody {
  readonly tabs: ReadonlyArray<{ readonly tabId: string | null; readonly state: string }>;
}
interface CallBody {
  readonly structuredContent?: unknown;
  readonly error?: string;
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const response = await fetch(`${agent.gateway.httpUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const response = await fetch(`${agent.gateway.httpUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/**
 * Serves a page whose tool blocks until released, and reports whether its call was cancelled.
 *
 * Separate from `servePage` because the interesting behaviour is what happens to a call that is still
 * running, which a tool answering instantly can never show.
 */
async function serveSlowPage(
  tabId: string,
  toolName: string,
): Promise<{ cancelled: () => boolean; release: () => void }> {
  if (agent === undefined) throw new Error('the agent was not started by this case');
  const socket = new WebSocket(agent.gateway.mintUrl(tabId));
  openSockets.push(socket);

  let sawCancellation = false;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = new Server(
    { name: 'slow-page', version: '0.0.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: toolName,
        description: 'A tool that takes its time.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler('tools/call', async (_request, extra) => {
    const signal = (extra as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal;
    signal?.addEventListener('abort', () => {
      sawCancellation = true;
    });
    await blocked;
    return { content: [{ type: 'text' as const, text: 'finished' }] };
  });
  await server.connect(pageTransport(socket));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return { cancelled: () => sawCancellation, release: () => release?.() };
}

describe('a caller that hangs up on POST /call', () => {
  // **Found by a live run, not by this suite, which is why the case exists.** The first version
  // listened for `request.on('aborted')` — deprecated, and silent on Node 24. A demonstrator tool ran
  // to completion after its caller had gone, and from the operator's side that is indistinguishable
  // from cancellation not being implemented at all.
  //
  // It matters beyond the mock agent: this route is the only way an operator can exercise cancellation
  // (docs/design.md#cancellation) against
  // a running page, so a route that cannot cancel makes the guarantee undemonstrable.

  it('cancels the tool call on the page', async () => {
    agent = await startMockAgent({ handshakeTimeoutMs: 2_000 });
    const page = await serveSlowPage('tab-slow', 'slow.work');

    const hangUp = new AbortController();
    const call = fetch(`${agent.gateway.httpUrl}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'tab-slow', name: 'slow.work', arguments: {} }),
      signal: hangUp.signal,
    }).catch(() => 'hung up');

    // Long enough for the request to reach the page and the handler to be entered.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(page.cancelled()).toBe(false);

    hangUp.abort();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(page.cancelled()).toBe(true);
    page.release();
  });

  it('does not cancel a call whose caller is still waiting', async () => {
    // The pairing. A route that cancelled every call the moment it was made would pass the case above,
    // and every slow tool in the demonstrator would stop the instant it started.
    agent = await startMockAgent({ handshakeTimeoutMs: 2_000 });
    const page = await serveSlowPage('tab-slow', 'slow.work');

    const call = post<CallBody>('/call', { tab: 'tab-slow', name: 'slow.work', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(page.cancelled()).toBe(false);

    page.release();
    const { status } = await call;
    expect(status).toBe(200);
  });
});

describe('the mock agent control surface', () => {
  it('reports a connected page as ready, lists its tools and calls one', async () => {
    agent = await startMockAgent({ handshakeTimeoutMs: 2_000 });
    await servePage('tab-a', 'customers.set_filters');

    await expect.poll(() => agent?.tabs()[0]?.state).toBe('ready');

    const tabs = await get<TabsBody>('/tabs');
    expect(tabs.body.tabs).toEqual([{ tabId: 'tab-a', state: 'ready' }]);

    const tools = await get<ToolsBody>('/tools');
    expect(tools.status).toBe(200);
    expect(tools.body.tools?.map((tool) => tool.name)).toEqual(['customers.set_filters']);

    const called = await post<CallBody>('/call', {
      name: 'customers.set_filters',
      arguments: { a: 1 },
    });
    expect(called.status).toBe(200);
    expect(called.body.structuredContent).toEqual({
      called: 'customers.set_filters',
      arguments: { a: 1 },
    });
  });

  it('reports a page that serves no MCP, with the cause, instead of waiting on it', async () => {
    const events: string[] = [];
    agent = await startMockAgent({ handshakeTimeoutMs: 300, onEvent: (line) => events.push(line) });
    await openSilentPage('silent-tab');

    // The socket opens and nothing answers `initialize`. Two things must be true about that, and both
    // are asserted here: it must not be waited on indefinitely — `connecting` forever is a state an
    // operator cannot distinguish from "still starting" — and the cause must be stated rather than
    // inferred from a tab that quietly vanished: an unexpected state fails loud, and the state an
    // operator is left with is explainable from what was actually observed.
    await expect
      .poll(() => events.find((line) => line.startsWith('mcp absent')), { timeout: 3_000 })
      .toBeTypeOf('string');

    const reported = events.find((line) => line.startsWith('mcp absent')) ?? '';
    expect(reported).toContain('silent-tab');
    // The reason is carried, not just the fact. "MCP absent" without a cause sends an operator to
    // read the gateway's source.
    expect(reported.length).toBeGreaterThan('mcp absent  tabId=silent-tab — '.length);

    // The failed handshake takes the connection down with it, so the tab is gone rather than lingering
    // as a listable thing that cannot be listed.
    await expect.poll(() => agent?.tabs().length, { timeout: 3_000 }).toBe(0);

    const tools = await get<ToolsBody>('/tools');
    expect(tools.status).toBe(409);
    expect(tools.body.error).toContain('no browser is connected');
  });

  it('refuses to guess when several tabs are connected and none was named', async () => {
    agent = await startMockAgent({ handshakeTimeoutMs: 2_000 });
    await servePage('tab-a', 'a.do');
    await servePage('tab-b', 'b.do');

    await expect.poll(() => agent?.tabs().filter((tab) => tab.state === 'ready').length).toBe(2);

    const ambiguous = await get<ToolsBody>('/tools');
    // Selecting among tabs belongs to the agent runtime rather than to the page
    // (docs/design.md#page-identity), and the only selection policy that
    // cannot be silently wrong is one that refuses when the request is ambiguous.
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain('tab-a');
    expect(ambiguous.body.error).toContain('tab-b');

    const named = await get<ToolsBody>('/tools?tab=tab-b');
    expect(named.status).toBe(200);
    expect(named.body.tools?.map((tool) => tool.name)).toEqual(['b.do']);
  });

  it('refuses when the NAMED tab is ambiguous, rather than acting on an arbitrary one', async () => {
    agent = await startMockAgent({ handshakeTimeoutMs: 2_000 });
    // Two pages claiming one id. Not a contrivance: `examples/customer-dashboard` hardcodes
    // `tabId=dashboard`, so a second copy of the demonstrator in any browser produces exactly this.
    await servePage('dashboard', 'first.do');
    await servePage('dashboard', 'second.do');

    await expect.poll(() => agent?.tabs().filter((tab) => tab.state === 'ready').length).toBe(2);

    // Naming a tab must not be a way PAST the ambiguity guard. `find` returns the first match, so a
    // request naming a duplicated id used to be answered from whichever page connected first — the
    // silent-success shape the unnamed case above exists to prevent, reached by a different door.
    const ambiguous = await get<ToolsBody>('/tools?tab=dashboard');
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain('dashboard');
  });

  it('reports that nothing is connected rather than an empty tool list', async () => {
    agent = await startMockAgent();

    const tools = await get<ToolsBody>('/tools');

    expect(tools.status).toBe(409);
    expect(tools.body.error).toContain('no browser is connected');
  });

  it('drops a tab when its socket closes', async () => {
    agent = await startMockAgent({ handshakeTimeoutMs: 2_000 });
    const socket = await servePage('tab-a', 'a.do');
    await expect.poll(() => agent?.tabs().length).toBe(1);

    socket.close();

    await expect.poll(() => agent?.tabs().length).toBe(0);
  });
});
