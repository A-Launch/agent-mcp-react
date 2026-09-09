import { type Gateway, startGateway } from '@agent-mcp/mock-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { isTransportFailureCode, TRANSPORT_FAILURE } from '../../../src/transport/errors.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import { recordConsole } from './harness.ts';

// What a PAGE observes when its credential has already been used.
//
// The gateway suite already proves the refusal happens, but it replays with a raw socket — so the
// library-side half of the claim, which is the half an application actually meets, was untested. It is
// also the half two of this project's own troubleshooting notes describe incorrectly, and those get
// corrected against what runs here rather than against what anyone remembers.
//
// A real gateway, a real single-use credential and the library's own transport. Nothing is stubbed:
// the whole point is what the real refusal looks like from the browser's side of it.

let gateway: Gateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

interface Attempt {
  readonly failed: boolean;
  readonly code: string | undefined;
  readonly everythingSeen: string;
}

/** Dials `url` with the library's transport and collects everything the application would be given. */
async function attempt(url: string): Promise<Attempt> {
  const console = recordConsole();
  const produced: string[] = [];
  try {
    const transport = createBrowserWebSocketTransport({ getUrl: () => url });
    transport.onerror = (error) => produced.push(`${error.name} ${error.message} ${error.stack}`);
    try {
      await transport.start();
      await transport.close();
      return { failed: false, code: undefined, everythingSeen: produced.join('\n') };
    } catch (error) {
      const failure = error as Error & { code?: string; cause?: unknown };
      produced.push(
        [
          failure.name,
          failure.message,
          failure.stack,
          failure.code,
          JSON.stringify(failure.cause ?? null),
        ].join(' '),
      );
      return {
        failed: true,
        code: failure.code,
        everythingSeen: [...produced, ...console.written].join('\n'),
      };
    }
  } finally {
    console.restore();
  }
}

describe('a page whose credential was already used', () => {
  it('is refused, where the same URL succeeded a moment earlier', async () => {
    gateway = await startGateway({ onConnection: () => {} });
    const url = gateway.mintUrl('page-one');

    // **The contrast is what makes this a test of single use** rather than of a bad URL. One URL, two
    // attempts, and the only thing that changed between them is that the credential was spent.
    const first = await attempt(url);
    expect(first.failed).toBe(false);

    const second = await attempt(url);
    expect(second.failed).toBe(true);
  });

  it('is told the connection failed, and NOT that authentication failed', async () => {
    gateway = await startGateway({ onConnection: () => {} });
    const url = gateway.mintUrl('page-one');
    await attempt(url);

    const spent = await attempt(url);

    // A refused handshake and a dead port are byte-identical to a page: an error event with no status,
    // no headers and an empty message, then close 1006. A library that guessed "authentication" would
    // be wrong every time the gateway is merely down, and an operator would go looking for a
    // credential problem instead of a stopped process.
    expect(spent.code).toBe(TRANSPORT_FAILURE.connectionFailed);
    expect(isTransportFailureCode(spent.code ?? '')).toBe(true);
    expect(spent.everythingSeen).not.toMatch(/auth|401|unauthorized|forbidden|credential|ticket/i);
  });

  it('never sends anything to a peer that refused it', async () => {
    const seen: string[] = [];
    gateway = await startGateway({
      onConnection: (connection) => seen.push(connection.tabId ?? ''),
    });
    const url = gateway.mintUrl('page-one');
    await attempt(url);
    expect(seen).toHaveLength(1);

    await attempt(url);

    // The refusal happens at the HTTP upgrade, before the handshake completes, so the gateway never
    // records a second connection at all — there was no `open`, and therefore nothing was transmitted
    // to an unauthenticated peer.
    expect(seen).toHaveLength(1);
  });

  it('keeps the spent credential out of everything it reports', async () => {
    gateway = await startGateway({ onConnection: () => {} });
    const url = gateway.mintUrl('page-one');
    const credential = new URL(url).searchParams.get('ticket') ?? '';
    expect(credential).toMatch(/\S/);

    await attempt(url);
    const spent = await attempt(url);

    // A real credential this time, not a synthetic one: the neighbouring redaction suite proves the
    // scrubbing against a URL it made up, and a case that only ever saw a made-up value could not
    // catch a path that echoed what the gateway actually issued.
    expect(spent.everythingSeen).not.toContain(credential);
    expect(spent.everythingSeen).not.toContain('?');
  });
});
