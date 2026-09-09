import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { createTicketMinter, type TicketMinter, type TicketRefusal } from './tickets.ts';

// The local agent gateway: an HTTP endpoint that mints connection tickets and a WebSocket endpoint
// that accepts authenticated browser connections. It is the peer the library dials — the browser is
// the MCP *server* and connects outbound, because browser JavaScript cannot listen for inbound
// connections.
//
// Invariant this file enforces, and the reason authentication lives at the upgrade rather than in the
// first message: a socket that fails ticket redemption MUST NOT complete the WebSocket handshake.
// Accepting it and closing it afterwards would give the page an `open` event, and anything the page
// sent in that window would have reached an unauthenticated peer. Refusal is an HTTP status on the
// upgrade, so `open` never fires
// (docs/connecting-to-an-agent.md#rejecting-an-unauthenticated-socket).
//
// Equally: a tab identifier is metadata and is never read as a credential. A connection presenting a
// tab id and no ticket is refused exactly as one presenting neither
// (docs/connecting-to-an-agent.md#the-page-instances-identity).

/**
 * One accepted browser connection. Held so a client can address a specific tab — selecting among
 * several is the agent runtime's job (docs/connecting-to-an-agent.md#multiple-tabs).
 */
export interface BrowserConnection {
  /**
   * The page's ephemeral tab identifier, when it supplied one. Metadata for routing among tabs and
   * nothing else — it grants no authority and is never checked to admit a connection
   * (docs/connecting-to-an-agent.md#the-page-instances-identity).
   */
  readonly tabId: string | null;
  /** The accepted socket. One MCP JSON-RPC message per text frame, no envelope (docs/websocket-framing.md). */
  readonly socket: WebSocket;
  /** Sends one JSON-RPC message as exactly one text frame. */
  send(message: unknown): void;
  close(): void;
}

export interface GatewayOptions {
  /** TCP port. `0` binds an ephemeral port, which is what every test should use. */
  readonly port?: number;
  readonly host?: string;
  /**
   * Passed through to the ticket minter. A credential this short-lived is the recommendation
   * docs/connecting-to-an-agent.md#minting-a-credential-from-your-backend makes: 30–120 s.
   */
  readonly ticketTtlMs?: number;
  /** Clock source, injected so expiry can be asserted without sleeping. */
  readonly now?: () => number;
  /** Called once per accepted connection, after the handshake completes. */
  readonly onConnection?: (connection: BrowserConnection) => void;
  /** Called when a connection is refused, with the cause. Diagnostics only. */
  readonly onRefusal?: (refusal: TicketRefusal) => void;
  /**
   * Extra HTTP routes, keyed by `METHOD /pathname`, consulted before the 404.
   *
   * The control surface an operator drives (`/tabs`, `/tools`, `/call`) has to live on this server
   * rather than a second one, because it acts on connections this process is holding. The gateway
   * does not know what those routes mean and never will — it owns the socket, not the agent.
   */
  readonly routes?: Record<string, (request: IncomingMessage, response: ServerResponse) => void>;
}

export interface Gateway {
  /** The port actually bound. Read this rather than assuming the requested one. */
  readonly port: number;
  /** `http://host:port` — where `GET /ticket` lives. */
  readonly httpUrl: string;
  /** `ws://host:port` — the endpoint a page dials, with its ticket in the query string. */
  readonly wsUrl: string;
  readonly minter: TicketMinter;
  readonly connections: ReadonlySet<BrowserConnection>;
  /** Mints a ticket and returns the complete URL a page would dial. This is the `getUrl()` seam. */
  mintUrl(tabId?: string): string;
  close(): Promise<void>;
}

/** The response body of `GET /ticket`. The page fetches this, then dials `wsUrl`. */
interface TicketResponse {
  readonly ticket: string;
  readonly wsUrl: string;
  readonly expiresAt: number;
}

// A refusal carries an HTTP status the page can distinguish. `absent` is 401 like the rest: the
// distinction between "you sent nothing" and "you sent something wrong" belongs in the log, not in a
// status code a caller could probe to learn which tickets exist.
const REFUSAL_STATUS = 401;

/**
 * Development CORS, applied to every HTTP response this gateway sends.
 *
 * The pages that talk to this process are served from other ports in the `:450xx` block, so every
 * request from them is cross-origin. Set with `setHeader` before any route runs, so a route cannot
 * forget it and produce an endpoint that works from curl and fails from a browser with a message
 * about CORS rather than about what it was doing.
 *
 * A wildcard origin, and credentials are deliberately NOT allowed: this gateway hands out connection
 * tickets, and a wildcard origin with credentials would let any page in the browser fetch one.
 */
function applyCors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
}

export function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const host = options.host ?? '127.0.0.1';
  const minter = createTicketMinter({
    ...(options.ticketTtlMs === undefined ? {} : { ttlMs: options.ticketTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const connections = new Set<BrowserConnection>();

  // `noServer` is not an optimization: it is what lets the upgrade be refused before the handshake.
  // A `WebSocketServer` bound to the HTTP server would complete the handshake and leave us closing an
  // already-open socket.
  const wss = new WebSocketServer({ noServer: true });

  let boundPort = 0;
  const httpUrl = (): string => `http://${host}:${boundPort}`;
  const wsUrl = (): string => `ws://${host}:${boundPort}`;

  const http: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', httpUrl());
    applyCors(response);

    // Answered before any route, because a preflight names a method the route may not implement and
    // a 404 to a preflight reads, in the browser, as a CORS failure of the real request.
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/ticket') {
      const ticket = minter.mint();
      const dialUrl = new URL(wsUrl());
      dialUrl.searchParams.set('ticket', ticket.value);
      const body: TicketResponse = {
        ticket: ticket.value,
        wsUrl: dialUrl.toString(),
        expiresAt: ticket.expiresAt,
      };
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, connections: connections.size }));
      return;
    }

    const route = options.routes?.[`${request.method ?? 'GET'} ${url.pathname}`];
    if (route !== undefined) {
      route(request, response);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
  });

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', httpUrl());
    const outcome = minter.redeem(url.searchParams.get('ticket'));

    if (!outcome.accepted) {
      options.onRefusal?.(outcome.refusal);
      // Naming the cause in a header is what makes a failed local connection diagnosable in one
      // look. It reveals nothing a caller did not already supply.
      socket.write(
        `HTTP/1.1 ${REFUSAL_STATUS} Unauthorized\r\n` +
          `x-amr-refusal: ${outcome.refusal}\r\n` +
          'connection: close\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection: BrowserConnection = {
        // Read as metadata AFTER the ticket was accepted. Reading it earlier would invite treating
        // it as part of the admission decision — a tab id is metadata and never a credential
        // (docs/connecting-to-an-agent.md#the-page-instances-identity).
        tabId: url.searchParams.get('tabId'),
        socket: ws,
        send(message: unknown): void {
          ws.send(JSON.stringify(message));
        },
        close(): void {
          ws.close();
        },
      };
      connections.add(connection);
      ws.on('close', () => connections.delete(connection));
      options.onConnection?.(connection);
    });
  });

  return new Promise<Gateway>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, () => {
      const address = http.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`gateway bound to an unexpected address: ${String(address)}`));
        return;
      }
      boundPort = address.port;
      http.removeListener('error', reject);

      resolve({
        port: boundPort,
        httpUrl: httpUrl(),
        wsUrl: wsUrl(),
        minter,
        connections,
        mintUrl(tabId?: string): string {
          const dialUrl = new URL(wsUrl());
          dialUrl.searchParams.set('ticket', minter.mint().value);
          if (tabId !== undefined) dialUrl.searchParams.set('tabId', tabId);
          return dialUrl.toString();
        },
        close(): Promise<void> {
          return new Promise<void>((done, fail) => {
            for (const connection of connections) connection.socket.terminate();
            connections.clear();
            wss.close(() => {
              http.close((error) => (error ? fail(error) : done()));
            });
          });
        },
      });
    });
  });
}
