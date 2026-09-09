import { Client, deserializeMessage, type Transport } from '@modelcontextprotocol/client';
import type { BrowserConnection } from './gateway.ts';

// The MCP client half of the mock agent, and the transport that carries it over one accepted browser
// connection.
//
// The direction is the thing to hold on to, because it is the reverse of every other MCP deployment:
// the **browser is the server** and this process is the client. Browser JavaScript cannot listen for
// inbound connections, so the server dials the client and the client answers on a socket it did not
// open.
//
// Two rules of the SDK's `Transport` contract that no type checker enforces, both honoured below:
//
//   - `client.connect()` calls `start()`. Nothing else may, or messages arriving before the callbacks
//     are installed are dropped on the floor with no error anywhere.
//   - `close()` must end by firing `onclose`, however the channel ended. A transport that returns
//     without it leaves the protocol layer waiting for a teardown that never comes.

/** Identifies this client to the browser server during `initialize`. */
const CLIENT_INFO = { name: 'agent-mcp-mock-agent', version: '0.0.0' } as const;

/**
 * A `Transport` over one accepted browser connection.
 *
 * One JSON-RPC message per text frame, with no envelope (docs/websocket-framing.md). A frame that
 * does not parse is reported
 * through `onerror` and dropped — never silently ignored, and never allowed to desynchronize the
 * stream, because the next frame is a complete message regardless of what the last one was.
 */
export function browserConnectionTransport(connection: BrowserConnection): Transport {
  let closed = false;

  const transport: Transport = {
    async start(): Promise<void> {
      connection.socket.on('message', (data) => {
        const frame = data.toString();

        // Parsing is a statement of its own, deliberately, and NOT `onmessage?.(parse(frame))`.
        // Optional-call short-circuiting means the argument is never evaluated when no handler is
        // installed — so that shorter form drops malformed frames without a word whenever `onmessage`
        // happens to be unset, and reports them only when it happens to be set. Validity of what
        // arrived on the socket cannot depend on whether anyone is listening: an unexpected state has
        // to fail loud, and a swallowed frame is a hidden unknown.
        //
        // `deserializeMessage` is the SDK's own frame reader: it parses the text AND validates that
        // what came out is a JSON-RPC message. A frame that is valid JSON but not a JSON-RPC message
        // is refused here too. Parsing with `JSON.parse` and casting the result onto the message type
        // would be exactly the cast this project forbids — asserting a shape for data that arrived
        // from outside without checking it. A received value is validated at the boundary it crosses,
        // never asserted onto a type it has not been proven to inhabit.
        let message: ReturnType<typeof deserializeMessage>;
        try {
          message = deserializeMessage(frame);
        } catch (cause) {
          // The offending frame is named in the error. Swallowing it would leave the client waiting
          // on a response id that was in the message it could not read.
          transport.onerror?.(
            new Error(`the browser sent a frame that is not JSON-RPC: ${frame.slice(0, 200)}`, {
              cause,
            }),
          );
          return;
        }

        transport.onmessage?.(message);
      });

      connection.socket.on('error', (error) => transport.onerror?.(error));

      connection.socket.on('close', () => {
        if (closed) return;
        closed = true;
        transport.onclose?.();
      });
    },

    async send(message): Promise<void> {
      connection.send(message);
    },

    async close(): Promise<void> {
      connection.close();
      // Fired here as well as from the socket's own close event, guarded by `closed`, because a
      // socket that is already gone never emits it again — and the contract is that `close()` ends
      // with `onclose`, not that the peer cooperates.
      if (closed) return;
      closed = true;
      transport.onclose?.();
    },
  };

  return transport;
}

/**
 * Connects an MCP client to a browser connection and completes the `initialize` handshake.
 *
 * Resolves once the browser's MCP server has answered. It does not resolve on the socket opening: an
 * open socket is a channel, and a channel with nothing answering on it is exactly the state that
 * looks connected and behaves as though the page has no tools.
 */
export async function connectClient(
  connection: BrowserConnection,
  options: { readonly timeoutMs?: number } = {},
): Promise<Client> {
  const client = new Client(CLIENT_INFO);
  await client.connect(browserConnectionTransport(connection), {
    // Bounded on purpose. An unbounded handshake against a page that serves no MCP leaves the tab in
    // `connecting` for as long as the socket lives, and "still connecting" is indistinguishable from
    // "nothing is there" exactly when an operator needs to tell them apart.
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  return client;
}
