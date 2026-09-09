import { Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TRANSPORT_FAILURE } from '../../../src/transport/errors.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import { closeAll, type Peer, speakingPeer } from './harness.ts';

// The lifecycle claims, asserted directly.
//
// Two of these are the load-bearing ones, and both fail quietly:
//
//   - **`start()` resolving means sendable.** A transport that resolved earlier lets a runtime report
//     itself connected while nothing is connected. Nothing throws; the agent simply talks to a socket
//     that is not there yet.
//   - **`onclose` fires exactly once, on every path.** The asymmetry is important: a second call is
//     harmless because the protocol layer has already cleared its pending work, but a MISSING call
//     leaves every in-flight request hanging forever with no error anywhere. So these cases are
//     written to catch the missing one.

let peer: Peer | undefined;

afterEach(async () => {
  await closeAll();
  peer = undefined;
});

describe('starting', () => {
  it('resolves only once a message can actually be sent', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });

    await transport.start();

    // The assertion is not that start() resolved — it is that the very next thing a caller does
    // works. A transport resolving before the channel is usable passes any "did it resolve" check.
    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    ).resolves.toBeUndefined();
  });

  it('is called by the protocol layer itself, not by us', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    const server = new Server({ name: 'p', version: '0' }, { capabilities: {} });

    // Nothing below calls start(). If connect() did not, the peer would never see a connection —
    // and anything arriving before the callbacks were installed would be dropped silently.
    await server.connect(transport);
    await peer.connected();

    await server.close();
  });

  it('does not open a second socket when started twice', async () => {
    peer = await speakingPeer();
    let urlRequests = 0;
    const transport = createBrowserWebSocketTransport({
      getUrl: () => {
        urlRequests += 1;
        return (peer as Peer).url;
      },
    });

    await transport.start();
    await transport.start();

    // The URL supplier is the observable proxy for "a connection was attempted". A second socket
    // means a second attempt, which means a second credential spent.
    expect(urlRequests).toBe(1);
  });
});

describe('the channel ending', () => {
  it('reports it exactly once when the peer closes', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();
    await peer.connected();

    peer.disconnect();

    const deadline = Date.now() + 1_000;
    while (closes === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Waited past the first report deliberately: a second one arriving late is the failure this
    // asserts against, and checking immediately would miss it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closes).toBe(1);
  });

  it('reports it exactly once when the page closes, by the same path', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();
    await peer.connected();

    await transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closes).toBe(1);
  });

  it('is harmless to close a second time', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();

    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();

    expect(closes).toBe(1);
  });
});

describe('a transport is single-use', () => {
  it('refuses to start again once its channel has ended', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    await transport.start();
    await transport.close();

    // Not a restart, and not a silent no-op. A restartable transport means a stale reference can
    // reattach, and a caller ends up holding a connection it did not open — reconnection is built by
    // constructing a NEW transport per attempt (docs/connection-lifecycle.md), which this refusal is
    // what enforces.
    await expect(transport.start()).rejects.toMatchObject({
      code: TRANSPORT_FAILURE.channelNotOpen,
    });
  });

  it('refuses a send once the channel has ended', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });
    await transport.start();
    await transport.close();

    // Not queued and not discarded. Either would mean a caller believing the message was sent.
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({
      code: TRANSPORT_FAILURE.channelNotOpen,
    });
  });

  it('refuses a send before it has been started', async () => {
    peer = await speakingPeer();
    const transport = createBrowserWebSocketTransport({ getUrl: () => (peer as Peer).url });

    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toMatchObject({
      code: TRANSPORT_FAILURE.channelNotOpen,
    });
  });
});

describe('creating a transport', () => {
  it('has no effect until it is started', async () => {
    peer = await speakingPeer();
    let urlRequests = 0;

    createBrowserWebSocketTransport({
      getUrl: () => {
        urlRequests += 1;
        return (peer as Peer).url;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    // No URL obtained means no credential spent and no socket opened. This is what lets the provider
    // construct a transport during a render that may never commit.
    expect(urlRequests).toBe(0);
  });
});
