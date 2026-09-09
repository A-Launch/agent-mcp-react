import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import {
  closeAll,
  recordConsole,
  refusingPeer,
  silentPeer,
  TICKET,
  UNREACHABLE_URL,
  withTicket,
} from './harness.ts';

// The one secret this layer handles, asserted as an absence.
//
// The connection URL carries a single-use ticket, and a failed connection is exactly the moment a URL
// gets printed — into a console, into an error message, and from there potentially to the agent itself.
// The platform makes this easy to get wrong in a way nothing warns about: the socket keeps the full
// dialed URL on `ws.url`, so the most natural thing to put in a connection failure is the credential.
//
// Every case here drives a real failure path with a real credential in the URL and asserts it appears
// nowhere. `everythingReported` collects both channels, because an assertion about only one of them
// is the assertion that passes while the ticket is on screen.

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
});

/** Everything a failed attempt produced: the thrown failure, anything reported, and the console. */
async function everythingReported(url: string | (() => never)): Promise<string> {
  const console = recordConsole();
  const produced: string[] = [];

  try {
    const transport = createBrowserWebSocketTransport({
      getUrl: typeof url === 'string' ? () => url : url,
    });
    transport.onerror = (error) => produced.push(`${error.name} ${error.message} ${error.stack}`);
    transport.onclose = () => produced.push('closed');

    try {
      await transport.start();
    } catch (error) {
      const failure = error as Error & { code?: string; cause?: unknown };
      // Serialized broadly on purpose: the message, the stack, the code, and anything attached as a
      // cause. A credential smuggled in on a `cause` is still published by any console that prints
      // the error.
      produced.push(
        [
          failure.name,
          failure.message,
          failure.stack,
          failure.code,
          JSON.stringify(failure.cause ?? null),
          String(failure.cause ?? ''),
        ].join(' '),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    return [...produced, ...console.written].join('\n');
  } finally {
    console.restore();
  }
}

describe('the credential in the connection URL', () => {
  it('appears in nothing reported when the endpoint is unreachable', async () => {
    const output = await everythingReported(withTicket(UNREACHABLE_URL));

    expect(output).not.toContain(TICKET);
  });

  it('appears in nothing reported when the handshake is refused', async () => {
    const refusing = await refusingPeer();

    const output = await everythingReported(withTicket(refusing.url));

    expect(output).not.toContain(TICKET);
  });

  it('appears in nothing reported when the URL supplier fails carrying it', async () => {
    // A supplier that fails mid-fetch is holding the credential, and its error may well name it.
    // This is why the supplier's error is not attached to the reported failure.
    const output = await everythingReported((): never => {
      throw new Error(`failed to redeem ${TICKET} at the ticket endpoint`);
    });

    expect(output).not.toContain(TICKET);
  });

  it('appears in nothing reported when the attempt times out', async () => {
    const silent = await silentPeer();
    const console = recordConsole();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const transport = createBrowserWebSocketTransport({ getUrl: () => withTicket(silent.url) });
      const outcome = transport.start().then(
        () => '',
        (error: Error) => `${error.message} ${error.stack}`,
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect([await outcome, ...console.written].join('\n')).not.toContain(TICKET);
    } finally {
      console.restore();
    }
  });
});

describe('the console', () => {
  it('stays silent across every failure path', async () => {
    const refusing = await refusingPeer();
    const console = recordConsole();

    try {
      for (const url of [withTicket(UNREACHABLE_URL), withTicket(refusing.url)]) {
        const transport = createBrowserWebSocketTransport({ getUrl: () => url });
        await transport.start().catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      // This is the assertion the reported-failure cases above cannot make. A `console.error` carrying
      // the full URL never touches the reported error, so every error-shaped check passes while the
      // ticket is on screen. It is also the requirement that this module reports through the protocol
      // layer's callbacks and through nothing else.
      expect(console.written).toEqual([]);
    } finally {
      console.restore();
    }
  });
});

describe('naming the endpoint', () => {
  it('keeps the origin and path, and drops everything that could carry a credential', async () => {
    const refusing = await refusingPeer();
    const origin = new URL(refusing.url).origin;

    const output = await everythingReported(withTicket(refusing.url));

    // A failure that cannot say which endpoint it dialed is not actionable, so the origin stays.
    expect(output).toContain(origin);
    expect(output).not.toContain(TICKET);
    expect(output).not.toContain('?');
  });

  it('reports a URL that cannot be parsed without echoing any of it', async () => {
    // A string that failed to parse is one we cannot reason about, so no part of it is repeated —
    // this is precisely the case where a "just include the URL" fallback would leak.
    const output = await everythingReported(`not a url at all ${TICKET}`);

    expect(output).not.toContain(TICKET);
    expect(output).toContain('could not be parsed');
  });
});
