import { type Gateway, startGateway } from '@agent-mcp/mock-agent';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

// The first assertion this repository makes about anything: a real local
// WebSocket server accepts an authenticated connection and refuses an unauthenticated one.
//
// The socket is never mocked, here or anywhere in this layer. Framing, closure, upgrade rejection and
// reconnection are exactly the behaviours a mock gets wrong in the direction that makes tests pass,
// so a mocked socket would be a test of the mock — this layer is asserted against a real socket
// (CONTRIBUTING.md#8-testing).
//
// The gateway under test is the one `pnpm dev:agent` runs. A suite that stood up its own server would
// leave the operator's gateway unexercised while reporting green.

let gateway: Gateway | undefined;
const dialled: WebSocket[] = [];

afterEach(async () => {
  for (const socket of dialled.splice(0)) socket.terminate();
  await gateway?.close();
  gateway = undefined;
});

interface DialOutcome {
  readonly opened: boolean;
  /** The cause the gateway named on a refused upgrade, or `null` if it refused without one. */
  readonly refusal: string | null;
}

/**
 * Dials the gateway and reports which side won: `opened` if the handshake completed, otherwise the
 * gateway's stated cause.
 *
 * The distinction is the whole point of these cases. A refusal that arrives as a close event after a
 * successful handshake is NOT the same outcome — the page would have seen `open`, and anything it
 * sent in that window reached an unauthenticated peer.
 *
 * Sockets that open are left open and torn down in `afterEach`, so a case can observe the connection
 * the gateway is holding. Closing here would race every assertion about connection state.
 */
function dial(url: string): Promise<DialOutcome> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    dialled.push(socket);
    let settled = false;
    const settle = (outcome: DialOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    socket.on('open', () => settle({ opened: true, refusal: null }));
    // `ws` surfaces a rejected upgrade as `unexpected-response` with the raw HTTP reply, which is
    // where the gateway states its cause.
    socket.on('unexpected-response', (_request, response) => {
      const refusal = response.headers['x-amr-refusal'];
      settle({ opened: false, refusal: typeof refusal === 'string' ? refusal : null });
    });
    socket.on('error', () => settle({ opened: false, refusal: null }));
  });
}

/** The started gateway, as a non-optional value, so a case reads without null handling. */
function running(): Gateway {
  if (gateway === undefined) throw new Error('the gateway was not started by this case');
  return gateway;
}

describe('the local agent gateway', () => {
  it('accepts a connection presenting a freshly minted ticket', async () => {
    gateway = await startGateway();

    const outcome = await dial(running().mintUrl());

    expect(outcome.opened).toBe(true);
  });

  it('refuses a connection carrying no ticket, before the handshake completes', async () => {
    gateway = await startGateway();

    const outcome = await dial(running().wsUrl);

    expect(outcome.opened).toBe(false);
    expect(outcome.refusal).toBe('absent');
  });

  it('refuses a ticket that was already spent', async () => {
    gateway = await startGateway();
    const url = running().mintUrl();

    const first = await dial(url);
    const replay = await dial(url);

    expect(first.opened).toBe(true);
    expect(replay.opened).toBe(false);
    // Single use is enforced in the cheap environment on purpose. A permissive dev gateway accepts
    // the replay, every local reconnection works, and the failure surfaces first in deployment. The
    // socket authenticates with a SINGLE-USE ticket (docs/connecting-to-an-agent.md).
    expect(replay.refusal).toBe('spent');
  });

  it('refuses a ticket it never issued', async () => {
    gateway = await startGateway();

    const outcome = await dial(`${running().wsUrl}/?ticket=not-a-ticket-this-gateway-minted`);

    expect(outcome.opened).toBe(false);
    // Distinct from `spent`: an unknown ticket points at a page dialling the wrong gateway, a spent
    // one at a page that reloaded. Collapsing them costs an operator the diagnosis.
    expect(outcome.refusal).toBe('unknown');
  });

  it('refuses a ticket past its expiry', async () => {
    // The clock is injected rather than waited out. A test that sleeps through a real TTL is slow AND
    // imprecise about the boundary it claims to assert.
    let clock = 1_000_000;
    gateway = await startGateway({ ticketTtlMs: 30_000, now: () => clock });
    const url = running().mintUrl();

    clock += 30_001;
    const outcome = await dial(url);

    expect(outcome.opened).toBe(false);
    expect(outcome.refusal).toBe('expired');
  });

  it('refuses a connection that presents a tab id and no ticket', async () => {
    gateway = await startGateway();

    const outcome = await dial(`${running().wsUrl}/?tabId=${crypto.randomUUID()}`);

    // A tab identifier is metadata for routing among tabs and confers no authority whatsoever. This
    // case exists because "the connection identifies itself, so it must be ours" is the shape the
    // mistake takes: a connection identity implies no authorization, and a tab id is metadata rather
    // than a credential (docs/explanation-reachability.md#why-identity-is-not-authorization).
    expect(outcome.opened).toBe(false);
    expect(outcome.refusal).toBe('absent');
  });

  it('mints a ticket over HTTP and carries the dial URL back', async () => {
    gateway = await startGateway();

    const response = await fetch(`${running().httpUrl}/ticket`);
    const body = (await response.json()) as { ticket: string; wsUrl: string; expiresAt: number };

    expect(response.status).toBe(200);
    expect(body.ticket).toMatch(/^[\w-]{20,}$/);
    expect(body.wsUrl).toContain(`ticket=${body.ticket}`);

    // The endpoint the page actually fetches is the one that must work, so the case dials what the
    // response handed back rather than re-deriving the URL.
    const outcome = await dial(body.wsUrl);
    expect(outcome.opened).toBe(true);
  });

  it('records an accepted connection and its tab id, and drops it on close', async () => {
    gateway = await startGateway();
    const tabId = crypto.randomUUID();

    const outcome = await dial(running().mintUrl(tabId));
    expect(outcome.opened).toBe(true);

    await expect.poll(() => running().connections.size).toBe(1);
    const [connection] = [...running().connections];
    expect(connection?.tabId).toBe(tabId);

    connection?.close();
    await expect.poll(() => running().connections.size).toBe(0);
  });

  it('carries one JSON-RPC message per text frame, with no envelope around it', async () => {
    const received: string[] = [];
    gateway = await startGateway({
      onConnection: (connection) => {
        connection.socket.on('message', (data) => received.push(data.toString()));
      },
    });

    const outcome = await dial(running().mintUrl());
    expect(outcome.opened).toBe(true);

    const page = dialled.at(-1);
    page?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    page?.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));

    await expect.poll(() => received.length).toBe(2);
    // Two messages, two frames, each parseable on its own. Batching or wrapping breaks framing
    // intermittently — small messages still fit — which is why the assertion is per frame
    // (docs/websocket-framing.md).
    expect(received.map((frame) => JSON.parse(frame))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
  });
});
