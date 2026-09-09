import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { type WebSocket as PeerSocket, type RawData, WebSocketServer } from 'ws';

// The peers this feature is asserted against. Every one of them is a REAL server on an ephemeral port.
//
// Nothing here mocks a socket. The layered testing strategy asks for the transport to be asserted
// against a real socket (CONTRIBUTING.md#8-testing), and the reason is concrete rather
// than doctrinal: framing, closure, handshake refusal and the deadline are all properties of the
// platform's socket implementation, and a mocked socket is a test of the mock. This repository has
// already been bitten by that shape — a transport that dropped malformed frames silently passed every
// test it had.
//
// Three peers, and each exists because a real failure mode needs it:
//
//   - `speakingPeer` — answers frames, so the round trip is real.
//   - `refusingPeer` — refuses the WebSocket upgrade with 401 and a diagnostic header, exactly as
//     `tools/mock-agent`'s gateway does for a bad ticket. It exists to prove the page CANNOT see any
//     of that, which is what makes the single connection-failed cause honest.
//   - `silentPeer` — accepts the TCP connection and answers nothing, ever. It produces no socket event
//     at all, which is the unbounded hang the attempt deadline closes.

/** A peer under test, torn down by `closeAll()`. */
export interface Peer {
  /** `ws://127.0.0.1:<port>/` — dial this. */
  readonly url: string;
  /** Text frames received from the page, in arrival order. */
  readonly framesReceived: readonly string[];
  /** Sends one raw frame to the connected page, exactly as given — including malformed ones. */
  send(frame: string | Uint8Array): void;
  /** Resolves once a page has connected. */
  connected(): Promise<void>;
  /** Ends the connection from the peer's side. */
  disconnect(): void;
}

const toClose: Array<() => Promise<void> | void> = [];

/** Tears down every peer created since the last call. Call from `afterEach`. */
export async function closeAll(): Promise<void> {
  for (const close of toClose.splice(0)) await close();
}

function addressOf(server: { address(): AddressInfo | string | null }): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a TCP port');
  }
  return address.port;
}

/**
 * A peer that completes the handshake and relays frames verbatim.
 *
 * `send` writes exactly what it is given, with no serialization of its own — which is what lets a case
 * deliver a frame that is not JSON, or not text at all, and observe how the transport refuses it.
 */
export async function speakingPeer(): Promise<Peer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));

  const framesReceived: string[] = [];
  let socket: PeerSocket | undefined;
  let announceConnected: (() => void) | undefined;
  const connection = new Promise<void>((resolve) => {
    announceConnected = resolve;
  });

  server.on('connection', (peer) => {
    socket = peer;
    peer.on('message', (data: RawData, isBinary: boolean) => {
      framesReceived.push(isBinary ? '<binary>' : data.toString());
    });
    announceConnected?.();
  });

  toClose.push(
    () =>
      new Promise<void>((resolve) => {
        socket?.terminate();
        server.close(() => resolve());
      }),
  );

  return {
    url: `ws://127.0.0.1:${addressOf(server)}/`,
    framesReceived,
    send(frame) {
      if (socket === undefined) throw new Error('no page has connected to this peer yet');
      socket.send(frame);
    },
    connected: () => connection,
    disconnect() {
      socket?.close();
    },
  };
}

/**
 * A peer that refuses the WebSocket upgrade with `401` and a diagnostic header.
 *
 * This is the shape `tools/mock-agent` uses for a rejected ticket: refusal happens at the HTTP upgrade
 * so the page never gets an `open` event. The header is present precisely so a case can demonstrate the
 * page cannot read it.
 */
export async function refusingPeer(): Promise<{ url: string }> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (_request, socket) => {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\nx-amr-refusal: unknown\r\nConnection: close\r\n\r\n',
    );
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  toClose.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `ws://127.0.0.1:${addressOf(server)}/` };
}

/**
 * A peer that accepts the TCP connection and answers nothing, ever.
 *
 * The connection is held open deliberately — closing it would produce a socket event, and the point of
 * this peer is that NO event arrives. Without a deadline the attempt stays pending forever, which is a
 * hang with no error anywhere.
 */
export async function silentPeer(): Promise<{ url: string }> {
  const held: Array<{ destroy(): void }> = [];
  const server: TcpServer = createTcpServer((socket) => {
    socket.on('error', () => {}); // A reset while we hold it is expected, not a failure.
    held.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  toClose.push(() => {
    for (const socket of held.splice(0)) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${addressOf(server)}/` };
}

/** An address nothing is listening on. Port 1 is privileged and never bound by a test runner. */
export const UNREACHABLE_URL = 'ws://127.0.0.1:1/';

/** The credential a redaction case looks for. Distinctive so a substring search cannot match by luck. */
export const TICKET = 'AMR-TICKET-8f31c0e4-DO-NOT-LEAK';

/** Adds the credential to a URL the way a real gateway hands one out. */
export function withTicket(url: string): string {
  return `${url}?ticket=${TICKET}&tab=tab-0001`;
}

/**
 * Captures everything written to the console, and restores it.
 *
 * This exists for an assertion about an *absence*, which is the only kind the reported-error cases
 * cannot make: a `console.error` carrying the full connection URL never touches the reported error, so
 * every error-shaped assertion passes while the credential is on screen.
 */
export function recordConsole(): { written: readonly string[]; restore(): void } {
  const written: string[] = [];
  const methods = ['log', 'warn', 'error', 'debug', 'info'] as const;
  const originals = methods.map((name) => [name, console[name]] as const);

  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      written.push(args.map((value) => String(value)).join(' '));
    };
  }

  return {
    written,
    restore() {
      for (const [name, original] of originals) console[name] = original;
    },
  };
}
