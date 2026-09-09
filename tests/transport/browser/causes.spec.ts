import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserTransportError,
  isTransportFailureCode,
  TRANSPORT_FAILURE,
} from '../../../src/transport/errors.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import {
  closeAll,
  type Peer,
  refusingPeer,
  silentPeer,
  speakingPeer,
  UNREACHABLE_URL,
} from './harness.ts';

// The vocabulary, asserted as a closed set rather than case by case.
//
// A closed set of literals is declared once as an exported dictionary: membership is derived from
// that dictionary and validated at every boundary the value crosses. The cases below are the
// boundary — they drive every path this module has and assert that what came out is a member, and
// that nothing raw escaped.
//
// The most valuable one is the last: an authentication-rejected cause is produced ZERO times. That is
// not a redundant restatement of the sameness case in `failure.spec.ts` — it is the assertion that
// survives someone adding a new failure path later and reaching for the obvious diagnosis.

let peer: Peer | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
  peer = undefined;
});

/** Collects everything every failure path produces, as thrown failures and reported errors. */
async function everyFailure(): Promise<Array<Error & { code?: string; cause?: unknown }>> {
  const collected: Array<Error & { code?: string; cause?: unknown }> = [];
  const record = (error: unknown) => collected.push(error as Error & { code?: string });

  // 1. The URL supplier fails.
  await createBrowserWebSocketTransport({
    getUrl: () => {
      throw new Error('no ticket');
    },
  })
    .start()
    .catch(record);

  // 2. The endpoint is unreachable.
  await createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL })
    .start()
    .catch(record);

  // 3. The handshake is refused.
  const refusing = await refusingPeer();
  await createBrowserWebSocketTransport({ getUrl: () => refusing.url })
    .start()
    .catch(record);

  // 4. The platform rejects the URL outright.
  await createBrowserWebSocketTransport({ getUrl: () => 'not a url' })
    .start()
    .catch(record);

  // 5. A send on a channel that is not open.
  await createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL })
    .send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    .catch(record);

  // 6. Every malformed inbound shape.
  peer = await speakingPeer();
  const live = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
  live.onerror = record;
  await live.start();
  await peer.connected();
  for (const frame of [new Uint8Array([1, 2]), 'not json', JSON.stringify({ a: 1 })]) {
    peer.send(frame);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await live.close();

  return collected;
}

describe('every cause this module produces', () => {
  it('is a member of the declared closed set', async () => {
    const failures = await everyFailure();

    expect(failures.length).toBeGreaterThanOrEqual(8);
    for (const failure of failures) {
      expect(
        failure.code !== undefined && isTransportFailureCode(failure.code),
        `"${failure.code}" is not a member of the closed set — ${failure.message}`,
      ).toBe(true);
    }
  });

  it('carries no raw platform value across the boundary', async () => {
    const failures = await everyFailure();

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(BrowserTransportError);
      // No `cause`, deliberately. A socket error event's `target` is the socket, and the socket's
      // `url` holds the connection credential — so attaching the platform's value would put the ticket
      // one property access away from every console that prints the error. There is nothing in it
      // worth that: the event carries no status, no headers and an empty message.
      expect(failure.cause).toBeUndefined();
    }
  });

  it('never names an authentication rejection', async () => {
    const failures = await everyFailure();
    const silent = await silentPeer();

    // Plus the deadline path, which the collector cannot drive without fake timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const deadlineOutcome = createBrowserWebSocketTransport({ getUrl: () => silent.url })
      .start()
      .then(
        () => undefined,
        (error: Error) => error,
      );
    await vi.advanceTimersByTimeAsync(10_000);
    const timedOut = await deadlineOutcome;
    vi.useRealTimers();

    const everything = [...failures, ...(timedOut ? [timedOut] : [])];

    // A page cannot observe an authentication rejection: a refused handshake and a dead port produce
    // identical events. This assertion is what stops a future contributor from "improving" the
    // diagnosis with an inference the platform does not support — the improvement would be wrong every
    // time the gateway was merely down.
    for (const failure of everything) {
      // **The URL is stripped before matching, and that is a fix rather than a loosening.** This case
      // failed once in six runs with the message "the connection to ws://127.0.0.1:54017/ could not be
      // established" — the assertion matched `401` inside the ephemeral PORT the operating system
      // happened to assign. The prose said nothing about authentication; the data did.
      //
      // Stripping the URL keeps the assertion at full strength on the part a contributor writes, and
      // removes a false positive from a part nobody chooses. Weakening the pattern instead — dropping
      // `401`, or adding word boundaries — would have left a real "HTTP 401" in a future message
      // matching a port and passing, which is the wrong half to give up.
      const prose = failure.message.replace(/wss?:\/\/\S+/g, '<url>');
      expect(prose, failure.message).not.toMatch(
        /auth|401|unauthorized|forbidden|credential|ticket/i,
      );
    }
    expect(Object.values(TRANSPORT_FAILURE)).not.toContain('MCP_WS_AUTH_FAILED');
  });
});

describe('the closed set itself', () => {
  it('derives membership from the dictionary rather than a second list', () => {
    for (const code of Object.values(TRANSPORT_FAILURE)) {
      expect(isTransportFailureCode(code)).toBe(true);
    }
    expect(isTransportFailureCode('MCP_WS_AUTH_FAILED')).toBe(false);
    expect(isTransportFailureCode('anything else')).toBe(false);
  });
});
