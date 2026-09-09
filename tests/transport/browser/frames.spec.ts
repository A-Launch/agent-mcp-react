import type { JSONRPCMessage } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TRANSPORT_FAILURE } from '../../../src/transport/errors.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import { closeAll, type Peer, speakingPeer } from './harness.ts';

// What arrives on the socket is outside this library's control, and the failure mode is quiet: a frame
// dropped without a word leaves the peer waiting on a response to a request that was never delivered —
// a hang with no error anywhere, diagnosed as a slow agent.
//
// Every case here asserts two things, and the second is the one that matters. Refusing a frame is easy;
// refusing it WITHOUT desynchronizing the stream is the property. So each case sends a well-formed
// message immediately afterwards and asserts it still arrives.

let peer: Peer | undefined;

afterEach(async () => {
  await closeAll();
  peer = undefined;
});

interface Attached {
  peer: Peer;
  received: JSONRPCMessage[];
  errors: Array<Error & { code?: string }>;
}

async function attached(options?: { withMessageHandler?: boolean }): Promise<Attached> {
  peer = await speakingPeer();
  const received: JSONRPCMessage[] = [];
  const errors: Array<Error & { code?: string }> = [];

  const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
  transport.onerror = (error) => errors.push(error);
  if (options?.withMessageHandler !== false) {
    transport.onmessage = (message) => received.push(message);
  }
  await transport.start();
  await peer.connected();

  return { peer, received, errors };
}

/** Waits for a condition rather than for a duration — a fixed sleep would be a timing workaround. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition(), what).toBe(true);
}

const WELL_FORMED = { jsonrpc: '2.0', id: 99, result: { ok: true } } as const;

describe('a frame that is not one JSON-RPC message', () => {
  it('refuses a frame that is not text, before attempting to parse it', async () => {
    const { peer: server, received, errors } = await attached();

    server.send(new Uint8Array([0x01, 0x02, 0x03]));
    await until(() => errors.length > 0, 'the binary frame was not reported');

    expect(errors[0]?.code).toBe(TRANSPORT_FAILURE.frameNotAMessage);
    // The message must say the frame was not TEXT. Coercing a binary frame to a string yields
    // "[object Blob]", which then fails JSON parsing — so the obvious implementation reports "not
    // valid JSON" and sends the reader to debug the peer's serialization instead of its frame type.
    expect(errors[0]?.message).toMatch(/not text/);
    expect(errors[0]?.message).not.toMatch(/JSON-RPC message:/);
    expect(received).toEqual([]);
  });

  it('refuses text that is not JSON', async () => {
    const { peer: server, received, errors } = await attached();

    server.send('this is not JSON');
    await until(() => errors.length > 0, 'the malformed frame was not reported');

    expect(errors[0]?.code).toBe(TRANSPORT_FAILURE.frameNotAMessage);
    expect(received).toEqual([]);
  });

  it('refuses valid JSON that is not a JSON-RPC message, on the same path', async () => {
    const { peer: server, received, errors } = await attached();

    server.send(JSON.stringify({ hello: 'valid json, not jsonrpc' }));
    await until(() => errors.length > 0, 'the non-JSON-RPC frame was not reported');

    // Same cause as unparseable text: the caller's response is identical — the peer sent something
    // this channel cannot carry. Parsing and then casting the result onto the message type would be
    // exactly the forbidden cast: a received value is validated at the boundary, never asserted onto
    // a closed type that does not admit it.
    expect(errors[0]?.code).toBe(TRANSPORT_FAILURE.frameNotAMessage);
    expect(received).toEqual([]);
  });
});

describe('the stream survives what it refused', () => {
  it('delivers the next well-formed message after each malformed shape', async () => {
    for (const malformed of [
      new Uint8Array([0xff, 0x00]),
      'not JSON',
      JSON.stringify({ not: 'jsonrpc' }),
    ]) {
      const { peer: server, received, errors } = await attached();

      server.send(malformed);
      await until(() => errors.length > 0, 'the malformed frame was not reported');

      server.send(JSON.stringify(WELL_FORMED));
      await until(() => received.length > 0, 'the stream did not recover after a refused frame');

      // This is the property. Each frame is a complete message regardless of what the last one was, so
      // a refusal must not consume, offset or poison what follows.
      expect(received).toEqual([WELL_FORMED]);
      await closeAll();
    }
  });
});

describe('reporting does not depend on anyone listening', () => {
  it('refuses an invalid frame even with no message handler installed', async () => {
    const { peer: server, errors } = await attached({ withMessageHandler: false });

    server.send('this is not JSON');
    await until(() => errors.length > 0, 'the frame was not reported when nobody was listening');

    // The optional-call trap, which this repository shipped once already: writing
    // `onmessage?.(parse(frame))` means the argument is never evaluated when no handler is installed,
    // so malformed frames are dropped without a word whenever nobody happens to be listening — and
    // reported only when someone is. Whether what arrived was valid cannot depend on that.
    expect(errors[0]?.code).toBe(TRANSPORT_FAILURE.frameNotAMessage);
  });
});

describe('a frame arriving after the channel ended', () => {
  it('is not delivered', async () => {
    peer = await speakingPeer();
    const received: JSONRPCMessage[] = [];
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    await peer.connected();

    await transport.close();
    peer.send(JSON.stringify(WELL_FORMED));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([]);
  });
});
