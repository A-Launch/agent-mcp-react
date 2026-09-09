import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSPORT_FAILURE } from '../../../src/transport/errors.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import { closeAll, refusingPeer, silentPeer, UNREACHABLE_URL } from './harness.ts';

// The failure story: every way an attempt can fail to produce a channel, and the proof that none of
// them produces something that looks like one.
//
// The most important case here is the one asserting SAMENESS. A gateway refusing a bad credential with
// 401 and a gateway that is not running are indistinguishable to a page: both give an error event with
// no status, no headers and an empty message, then a close with code 1006. A library reporting
// "authentication failed" here would be guessing, and would guess wrong every time the gateway was
// merely down. So the case asserts the two report the same cause — which looks like a weak assertion
// and is the opposite: it is the one that stops a future contributor from "improving" the diagnosis
// with an inference the platform does not support.

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
});

/** Runs an attempt and returns the failure, or fails the case if one did not happen. */
async function attemptFailure(
  start: () => Promise<void>,
): Promise<{ code: string; message: string }> {
  try {
    await start();
  } catch (error) {
    return { code: (error as { code: string }).code, message: (error as Error).message };
  }
  throw new Error('the connection attempt was expected to fail and did not');
}

describe('the URL could not be obtained', () => {
  it('reports its own cause and opens no socket', async () => {
    let socketsConstructed = 0;
    const RealWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        socketsConstructed += 1;
        super(url, protocols);
      }
    } as typeof WebSocket;

    try {
      const transport = createBrowserWebSocketTransport({
        getUrl: () => {
          throw new Error('the ticket endpoint returned 500');
        },
      });

      const failure = await attemptFailure(() => transport.start());

      expect(failure.code).toBe(TRANSPORT_FAILURE.urlUnavailable);
      // The second half is the one worth having. Reporting the right cause while having dialed anyway
      // would spend a credential on a connection nobody asked for.
      expect(socketsConstructed).toBe(0);
    } finally {
      globalThis.WebSocket = RealWebSocket;
    }
  });

  it('is distinguishable from a connection that could not be established', async () => {
    const supplierFailed = await attemptFailure(() =>
      createBrowserWebSocketTransport({
        getUrl: () => Promise.reject(new Error('no ticket')),
      }).start(),
    );
    const connectionFailed = await attemptFailure(() =>
      createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL }).start(),
    );

    // Different owners: one means the application's own code threw, the other means the gateway is
    // unreachable. Folding them together sends an operator to check a gateway that was never dialed.
    expect(supplierFailed.code).not.toBe(connectionFailed.code);
  });
});

describe('the connection could not be established', () => {
  it('fails against an endpoint nothing is listening on', async () => {
    const failure = await attemptFailure(() =>
      createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL }).start(),
    );

    expect(failure.code).toBe(TRANSPORT_FAILURE.connectionFailed);
  });

  it('reports a refused handshake as the SAME cause as an unreachable endpoint', async () => {
    const refusing = await refusingPeer();

    const refused = await attemptFailure(() =>
      createBrowserWebSocketTransport({ getUrl: () => refusing.url }).start(),
    );
    const unreachable = await attemptFailure(() =>
      createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL }).start(),
    );

    // The gateway sent 401 and an `x-amr-refusal` header. The page saw neither, and cannot. Asserting
    // sameness is asserting honesty: a distinct authentication cause here would pass against a mock
    // and be wrong in every browser.
    expect(refused.code).toBe(unreachable.code);
    expect(refused.code).toBe(TRANSPORT_FAILURE.connectionFailed);
    expect(refused.message).not.toMatch(/auth|401|unauthorized|ticket|credential/i);
  });

  it('produces no transport that can send', async () => {
    const transport = createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL });
    await attemptFailure(() => transport.start());

    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({
      code: TRANSPORT_FAILURE.channelNotOpen,
    });
  });

  it('wraps a URL the platform rejects outright, and still reports the channel ended', async () => {
    // Constructing a socket throws SYNCHRONOUSLY for a URL the platform will not accept — it does not
    // arrive as an error event like every other connection failure. Before this was guarded, the
    // platform's own exception escaped unwrapped: no code from the closed set, and no channel-ended
    // event, so a caller waited forever for a teardown that never came.
    const transport = createBrowserWebSocketTransport({ getUrl: () => 'not a url at all' });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };

    const failure = await attemptFailure(() => transport.start());

    expect(failure.code).toBe(TRANSPORT_FAILURE.connectionFailed);
    expect(closes).toBe(1);
  });

  it('reports the channel ended exactly once, though it never opened', async () => {
    const transport = createBrowserWebSocketTransport({ getUrl: () => UNREACHABLE_URL });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };

    await attemptFailure(() => transport.start());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A caller must not have to distinguish "failed before opening" from "opened and closed" by
    // whether the event arrived. The protocol layer's teardown is driven by this event, and a failure
    // path that skipped it would leave a caller waiting for a channel end that never comes.
    expect(closes).toBe(1);
  });
});

describe('an attempt that would never settle', () => {
  it('fails on the deadline against a peer that accepts and never answers', async () => {
    const silent = await silentPeer();

    // Only the timer functions are faked. Faking the clock as well would reach into the socket
    // implementation's own bookkeeping, and this case is about our deadline, not its.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const transport = createBrowserWebSocketTransport({ getUrl: () => silent.url });
    const started = transport.start();
    const outcome = started.then(
      () => undefined,
      (error: { code: string; message: string }) => error,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    const failure = await outcome;

    expect(failure?.code).toBe(TRANSPORT_FAILURE.connectionFailed);
    // Asserting on the message, because the alternative explanation for this case passing is that the
    // socket gave up on its own — a different mechanism reaching the same code. This distinguishes
    // them: only our deadline says "abandoned".
    expect(failure?.message).toMatch(/did not complete in time and was abandoned/);
  });

  it('leaves nothing usable behind after the deadline', async () => {
    const silent = await silentPeer();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const transport = createBrowserWebSocketTransport({ getUrl: () => silent.url });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    const outcome = transport.start().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;

    // The socket was abandoned with its listeners removed, so a handshake completing afterwards
    // cannot resurrect the attempt. What a caller can observe is that the transport is finished.
    expect(closes).toBe(1);
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({
      code: TRANSPORT_FAILURE.channelNotOpen,
    });
  });
});
