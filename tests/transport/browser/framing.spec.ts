import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import { closeAll, type Peer, speakingPeer } from './harness.ts';

// The wire format, asserted on the exact bytes.
//
// Why bytes and not "the peer could parse it": the mistake this case exists to catch is using the
// SDK's `serializeMessage`, which appends a newline because it is the stdio framing helper. A frame
// with a trailing newline is still valid JSON and still parses on the other side — so a round-trip
// assertion passes, an integration test passes, and the only thing that ever notices is a peer with a
// stricter reader. Comparing the frame to the exact string is the assertion that fails.
//
// The same reasoning covers envelopes. `{"tab":"x","payload":{...}}` also round-trips fine between two
// implementations that agree on it, and is exactly what the framing rule forbids: one JSON-RPC
// message per text frame, with nothing wrapped around it (docs/websocket-framing.md).

let peer: Peer | undefined;

afterEach(async () => {
  await closeAll();
  peer = undefined;
});

async function connectedTransport(): Promise<{
  send: (message: JSONRPCMessage) => Promise<void>;
  frames: readonly string[];
}> {
  peer = await speakingPeer();
  const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
  await transport.start();
  await peer.connected();
  return { send: (message) => transport.send(message), frames: peer.framesReceived };
}

/** Waits until the peer has received `count` frames, or fails the case rather than hanging. */
async function framesSettle(frames: readonly string[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (frames.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(frames.length, 'the peer did not receive the expected number of frames').toBe(count);
}

describe('one JSON-RPC message per text frame', () => {
  it('sends exactly the message, with no envelope and no trailing newline', async () => {
    const { send, frames } = await connectedTransport();
    const message = {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'customers.set_filters', arguments: { country: 'RO' } },
    } as const satisfies JSONRPCMessage;

    await send(message);
    await framesSettle(frames, 1);

    // The whole assertion, and the reason it is written this way: an exact comparison. Anything the
    // transport added — a newline, a wrapper, a field of its own — changes this string.
    expect(frames[0]).toBe(JSON.stringify(message));
    expect(frames[0]?.endsWith('\n')).toBe(false);
  });

  it('sends one frame per message rather than batching', async () => {
    const { send, frames } = await connectedTransport();

    await send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await framesSettle(frames, 3);

    expect(frames.map((frame) => JSON.parse(frame).id)).toEqual([1, 2, 3]);
  });

  it('delivers a message the peer sent as one text frame, unchanged', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    await peer.connected();

    const inbound = { jsonrpc: '2.0', id: 7, result: { ok: true } };
    peer.send(JSON.stringify(inbound));

    const deadline = Date.now() + 1_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(received).toEqual([inbound]);
  });
});
