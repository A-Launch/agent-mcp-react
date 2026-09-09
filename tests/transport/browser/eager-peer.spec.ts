// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

// A peer that speaks the instant it accepts, which is what a real agent gateway does.
//
// The other peers in this directory wait to be spoken to. That politeness hid a window: the socket
// opens, and the transport marks the channel usable one microtask later, after the promise that
// resolves the connection attempt settles. A frame arriving in between was dropped by the inbound
// guard with no error, no close and no trace — the agent's `initialize` among them, leaving the page
// connected and permanently unable to answer.
//
// It is its own file because it needs a peer that sends unprompted, and because what it holds is a
// timing window rather than a behaviour of the framing.

const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A peer that sends one frame immediately on accepting a connection, before being spoken to. */
async function eagerPeer(frame: string): Promise<string> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  server.on('connection', (socket) => socket.send(frame));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the peer did not bind a port');
  return `ws://127.0.0.1:${address.port}/`;
}

describe('a peer that speaks first', () => {
  it('is heard: a frame sent at accept time reaches the protocol layer', async () => {
    const { createBrowserWebSocketTransport } = await import('../../../src/transport/index.ts');
    const url = await eagerPeer(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));

    const received: unknown[] = [];
    const transport = createBrowserWebSocketTransport({ getUrl: async () => url });
    transport.onmessage = (message) => received.push(message);

    await transport.start();

    // The frame was already in flight before `start()` resolved. Nothing here waits for a duration:
    // it waits for the message the peer certainly sent, and fails saying so if it never arrives.
    for (let turn = 0; turn < 200 && received.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(received).toEqual([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    await transport.close?.();
  });
});
