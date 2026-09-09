import { afterEach, describe, expect, it, vi } from 'vitest';

// The server-render path, which is a normal path rather than a failure.
//
// The MCP runtime is browser-only. A server render must not create a connection and must not touch a
// socket implementation — and importing this module, or anything that imports it, must have no effect
// at all. Get this wrong and an application using the library crashes on the server with
// "WebSocket is not defined", from a module the application never knowingly loaded.
//
// The environment here is `node`, which has a global WebSocket. That is not the environment being
// simulated, so each case removes it: what is asserted is that the module can be loaded and a
// transport constructed where no socket implementation exists at all.

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.resetModules();
});

/** Removes the socket implementation, standing in for a server runtime that has none. */
function withoutSocketSupport(): void {
  Reflect.deleteProperty(globalThis as object, 'WebSocket');
  expect(globalThis.WebSocket).toBeUndefined();
}

describe('importing the transport', () => {
  it('has no effect and does not throw where no socket implementation exists', async () => {
    withoutSocketSupport();
    vi.resetModules();

    // A module-scope reference — even a harmless-looking one like a cached constructor — would throw
    // right here. That is the whole assertion.
    const module = await import('../../../src/transport/index.ts');

    expect(typeof module.createBrowserWebSocketTransport).toBe('function');
  });

  it('constructs a transport without touching the socket implementation', async () => {
    withoutSocketSupport();
    vi.resetModules();
    const { createBrowserWebSocketTransport } = await import('../../../src/transport/index.ts');

    // Constructing is what a provider does during a render that may never commit. Nothing may happen
    // until the effect phase starts it — no socket, no call to the supplier, no credential spent.
    let urlRequests = 0;
    const transport = createBrowserWebSocketTransport({
      getUrl: () => {
        urlRequests += 1;
        return 'ws://127.0.0.1:1/';
      },
    });

    expect(urlRequests).toBe(0);
    expect(transport.onmessage).toBeUndefined();
  });

  it('leaves the error vocabulary usable without a socket implementation', async () => {
    // The vocabulary is what a caller reads to explain a failure, and a server-rendered build may well
    // import it. It must not depend on the platform surface being present.
    withoutSocketSupport();
    vi.resetModules();
    const { TRANSPORT_FAILURE, isTransportFailureCode } = await import(
      '../../../src/transport/index.ts'
    );

    expect(isTransportFailureCode(TRANSPORT_FAILURE.connectionFailed)).toBe(true);
  });
});
