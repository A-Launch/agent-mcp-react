import {
  deserializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server';
import { BrowserTransportError, TRANSPORT_FAILURE } from './errors.ts';

// The browser side of the MCP connection: an MCP transport over the platform's WebSocket.
//
// The direction is the thing to hold on to, because it is the reverse of every other MCP deployment:
// the **browser is the server** and dials outward. Browser JavaScript cannot listen for inbound
// connections, so the server opens the connection and the client answers on a socket it did not open.
//
// This file is the ONLY place in the package that names a WebSocket, enforced by a case rather than by
// convention. That is what keeps the rest of the library testable without a network, and what makes
// "the transport is the one place a socket is exercised" a fact.
//
// Four things here are not what they look like, each established by running the platform rather than
// reading about it. They are commented where they occur; collected here because a reader skimming for
// the shape will otherwise reintroduce one:
//
//   1. Outbound frames use `JSON.stringify`, NOT the SDK's `serializeMessage` — that one appends a
//      newline, being the stdio helper.
//   2. A non-text frame is refused before any parse, because coercing it produces "[object Blob]",
//      which then fails JSON parsing and misreports the cause.
//   3. A refused handshake and a dead port are the SAME observation to a page, so no failure here
//      names authentication.
//   4. A peer that accepts and then says nothing produces NO socket event at all, so the attempt needs
//      a deadline this module owns.

/**
 * Supplies where to dial, once per connection attempt.
 *
 * Takes nothing: a supplier needing an argument from the transport would be a supplier the transport
 * had to understand. Its result is opaque — never parsed, never validated, never amended, and its
 * scheme is not read. This is the seam through which authentication reaches the socket without the
 * socket knowing what authentication is.
 */
export type ConnectionUrlSupplier = () => string | Promise<string>;

export interface BrowserWebSocketTransportOptions {
  readonly getUrl: ConnectionUrlSupplier;
}

/**
 * How long one connection attempt may take, covering obtaining the URL and opening the socket.
 *
 * Not an option, and deliberately not configurable: a knob here would be a caller's chance to set it to
 * something that never fires, which is the state this constant exists to make unreachable.
 *
 * The value is anchored rather than picked. A connection credential is recommended to live 30–120
 * seconds and this repository's minter defaults to the lower bound, so the deadline must be comfortably
 * inside it — an attempt has to stall, fail, and leave room to retry with a fresh credential while that
 * recommendation still holds. Ten seconds gives threefold headroom over any plausible handshake.
 */
const ATTEMPT_DEADLINE_MS = 10_000;

/** Where the transport is in its one and only lifecycle. `ended` is terminal. */
type Position = 'idle' | 'starting' | 'open' | 'ended';

/**
 * Reduces a connection URL to something safe to name in a failure.
 *
 * Invariant this function enforces: **the credential never appears in anything this module reports.**
 * A connection URL carries a single-use ticket in its query string, and a failed connection is exactly
 * the moment a URL gets printed — into a console, into an error, and from there potentially to the
 * agent itself.
 *
 * Origin and path are kept because a failure that cannot say which endpoint it dialed is not
 * actionable. Everything after them is dropped. A URL that cannot be parsed yields a fixed placeholder
 * rather than any part of the original: a string that failed to parse is a string we cannot reason
 * about, and echoing it back is exactly the case this function exists for.
 */
function reportableEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<the supplied connection URL could not be parsed>';
  }
}

/**
 * Creates one transport for one connection attempt.
 *
 * Creating it has no effect: no socket, no call to the supplier, no reference to a socket
 * implementation. That is what lets a server-side render import this module — and anything that
 * imports it — without touching a platform that is not there.
 *
 * The returned transport is **single-use**. Once its channel has ended it does not reconnect and does
 * not become usable again; a new attempt is a new transport. The alternative — a restartable transport
 * — means a stale reference can silently reattach, and a caller ends up holding a connection it did not
 * open.
 */
export function createBrowserWebSocketTransport(
  options: BrowserWebSocketTransportOptions,
): Transport {
  let position: Position = 'idle';
  let socket: WebSocket | undefined;
  let closeReported = false;

  /**
   * Reports the end of the channel, at most once.
   *
   * Invariant: **every path into `ended` arrives here, and `onclose` fires exactly once.** The
   * asymmetry matters — a second call is harmless, because the protocol layer has already cleared its
   * pending work, but a *missing* call leaves every in-flight request hanging forever with no error
   * anywhere. The protocol layer's teardown is what fails those requests, and this event is what
   * triggers it.
   */
  function reportChannelEnded(): void {
    position = 'ended';
    if (closeReported) return;
    closeReported = true;
    transport.onclose?.();
  }

  /**
   * Stops using a socket without waiting for it to agree.
   *
   * Used on every abandoning path — the deadline, an error before open, an explicit close. The
   * listeners are removed first so a late `open` or `message` cannot resurrect an attempt that has
   * already failed: a socket completing its handshake after the deadline must not produce a working
   * channel for a caller that was already told the attempt failed.
   */
  function abandon(target: WebSocket): void {
    target.onopen = null;
    target.onmessage = null;
    target.onerror = null;
    target.onclose = null;
    try {
      target.close();
    } catch {
      // A socket that never opened, or already closed, throws nothing worth reporting — and there is
      // no caller left to report it to. The attempt's own failure is the report.
    }
  }

  /**
   * Handles one inbound frame.
   *
   * Two invariants live here, and both are shapes that fail quietly:
   *
   * **The frame's type is checked before anything parses it.** Binary frames arrive as a Blob by
   * default, and coercing one to text yields the string "[object Blob]" — which then fails JSON
   * parsing. The obvious spelling therefore reports "this frame was not valid JSON" for a frame whose
   * actual problem is that it was never text, and sends the reader to debug the peer's serialization.
   *
   * **Validation is its own statement, never an argument to `onmessage?.(...)`.** Optional-call
   * short-circuiting means the argument is not evaluated when no handler is installed, so that shorter
   * form drops malformed frames without a word whenever nobody happens to be listening. Whether what
   * arrived on the socket was valid cannot depend on whether anyone was listening.
   */
  function receive(data: unknown): void {
    if (position === 'ended') return; // A frame after the channel ended is not delivered.

    if (position !== 'open') {
      // A frame before the channel is usable. The protocol forbids it — no frame precedes the
      // handshake — so reaching here means an assumption this module rests on has broken, and it is
      // reported rather than dropped. Silence here is what made the original defect invisible: the
      // usable flag was set one microtask after `open`, and a peer that spoke at accept time had its
      // first frame discarded with no error, no close and no trace on any platform that dispatched
      // the two events in one task.
      transport.onerror?.(
        new BrowserTransportError(
          TRANSPORT_FAILURE.frameNotAMessage,
          'a frame arrived before the channel was usable and was not delivered',
        ),
      );
      return;
    }

    if (typeof data !== 'string') {
      transport.onerror?.(
        new BrowserTransportError(
          TRANSPORT_FAILURE.frameNotAMessage,
          'the peer sent a frame that is not text; this channel carries one JSON-RPC message per text frame',
        ),
      );
      return;
    }

    // `deserializeMessage` parses AND validates that what came out is a JSON-RPC message, so a frame
    // that is valid JSON but not a JSON-RPC message is refused here too. Parsing with `JSON.parse` and
    // casting the result onto the message type would be exactly the cast this library forbids —
    // asserting a shape for data that arrived from outside without checking it.
    //
    // Nothing reads which error came out. The two failures are a SyntaxError and a schema error from
    // the SDK's validator; branching on either would break the next time the SDK changes validators.
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(data);
    } catch {
      transport.onerror?.(
        new BrowserTransportError(
          TRANSPORT_FAILURE.frameNotAMessage,
          `the peer sent a frame that is not a JSON-RPC message: ${data.slice(0, 200)}`,
        ),
      );
      return;
    }

    transport.onmessage?.(message);
  }

  const transport: Transport = {
    /**
     * Obtains the URL, opens the socket, and resolves only once the channel can carry a message.
     *
     * Invariant: **resolving means sendable.** A transport that resolved earlier would let a runtime
     * report itself connected while nothing is connected — the silent-success defect at the lowest
     * layer in the stack, where it is hardest to see.
     *
     * The socket is created HERE and never in the factory. The protocol layer installs its callbacks
     * before calling this, and a socket that exists earlier can deliver a message before `onmessage` is
     * set — a message dropped with no error anywhere.
     *
     * Called by the protocol layer's `connect()`, and by nothing else.
     */
    async start(): Promise<void> {
      if (position === 'ended') {
        throw new BrowserTransportError(
          TRANSPORT_FAILURE.channelNotOpen,
          'this transport has already been used; a new connection attempt needs a new transport',
        );
      }
      if (position !== 'idle') return; // Starting twice must not open a second socket.
      position = 'starting';

      let settle: ((outcome: Error | undefined) => void) | undefined;
      const attempt = new Promise<Error | undefined>((resolve) => {
        settle = resolve;
      });

      // The deadline covers the WHOLE attempt — obtaining the URL as well as opening the socket —
      // because a caller watching a stalled attempt cannot tell which half is stuck, and bounding only
      // one of them leaves the same hang reachable through the other. It is not defensive: a peer that
      // accepts the TCP connection and then says nothing produces no socket event at all, so without
      // this the attempt stays pending forever and any retry policy above never fires, because nothing
      // ever failed.
      const deadline = setTimeout(() => {
        settle?.(
          new BrowserTransportError(
            TRANSPORT_FAILURE.connectionFailed,
            'the connection attempt did not complete in time and was abandoned',
          ),
        );
      }, ATTEMPT_DEADLINE_MS);

      let url: string;
      try {
        url = await options.getUrl();
      } catch {
        clearTimeout(deadline);
        position = 'ended';
        reportChannelEnded();
        // Reported separately from a connection failure because the owners differ: the application's
        // own code threw, and no socket was ever opened. The supplier's error is not attached — it may
        // carry the credential it was in the middle of fetching.
        throw new BrowserTransportError(
          TRANSPORT_FAILURE.urlUnavailable,
          'the connection URL could not be obtained, so no connection was attempted',
        );
      }

      const endpoint = reportableEndpoint(url);

      // Constructing the socket can throw synchronously — a URL the platform will not accept is
      // rejected here rather than through an error event. Caught for three reasons, each of which was
      // a live defect before this guard existed: the platform's exception would otherwise cross the
      // boundary unwrapped and carry no code from the closed set; `onclose` would never fire, leaving
      // a caller waiting for a channel end that never comes; and the platform's message is free to
      // quote the URL it rejected, which would publish the credential in the one place we scrub.
      let pending: WebSocket;
      try {
        pending = new WebSocket(url);
      } catch {
        clearTimeout(deadline);
        reportChannelEnded();
        throw new BrowserTransportError(
          TRANSPORT_FAILURE.connectionFailed,
          `the connection to ${endpoint} could not be established: the platform rejected the supplied URL`,
        );
      }
      socket = pending;

      pending.onopen = () => {
        // Invariant: **the channel becomes usable in the same turn as the event that makes it
        // usable.** Marking it open after `await attempt` instead put a microtask between the two, and
        // whether an inbound frame survived that gap depended on whether the platform dispatched
        // `open` and `message` in one task — which jsdom does and Node's socket does not. The result
        // was a page that connected and then never answered, because the agent's first frame was
        // dropped: measured, not imagined.
        //
        // Guarded on `starting` so a handshake completing after the attempt already failed cannot
        // present as a working channel to a caller that was told otherwise.
        if (position === 'starting') position = 'open';
        settle?.(undefined);
      };

      // A failed handshake gives a page an error event carrying no status, no headers and an empty
      // message, followed by a close with code 1006 — byte for byte what a dead port gives. A gateway
      // refusing a bad credential is therefore indistinguishable here from a gateway that is not
      // running, and naming authentication would be a guess that is wrong every time the gateway was
      // merely down. One cause, stating what was observed.
      pending.onerror = () => {
        settle?.(
          new BrowserTransportError(
            TRANSPORT_FAILURE.connectionFailed,
            `the connection to ${endpoint} could not be established`,
          ),
        );
      };

      pending.onclose = () => {
        // Before open, this is the attempt failing. After open, it is the channel ending.
        settle?.(
          new BrowserTransportError(
            TRANSPORT_FAILURE.connectionFailed,
            `the connection to ${endpoint} closed before it was established`,
          ),
        );
        reportChannelEnded();
      };

      pending.onmessage = (event: MessageEvent) => receive(event.data);

      const failure = await attempt;
      clearTimeout(deadline);

      if (failure !== undefined) {
        abandon(pending);
        socket = undefined;
        // Forces `ended`, which is what makes the guard above safe: a socket that opened between the
        // deadline firing and this line is marked unusable again before anything can be delivered.
        reportChannelEnded();
        throw failure;
      }
    },

    /**
     * Transmits exactly one JSON-RPC message as exactly one text frame.
     *
     * `JSON.stringify`, and deliberately **not** the SDK's `serializeMessage` despite the symmetry with
     * `deserializeMessage` used above. That function appends a newline: it is the stdio framing helper,
     * where messages are newline-delimited. A WebSocket frame is already a message boundary, so using
     * it would put a trailing newline inside every frame — still parseable by the peer, which is
     * exactly why it would survive review and every round-trip test.
     *
     * No envelope, no batching, no field of this module's own.
     */
    async send(message: JSONRPCMessage): Promise<void> {
      if (position !== 'open' || socket === undefined) {
        // Not queued and not discarded. Holding it would mean a caller believing a message was sent
        // while it waits for a connection that may never come.
        throw new BrowserTransportError(
          TRANSPORT_FAILURE.channelNotOpen,
          'the channel is not open, so the message was not sent',
        );
      }
      socket.send(JSON.stringify(message));
    },

    /**
     * Ends the channel, and reports that it ended.
     *
     * Idempotent, and safe from any position — including one that never opened, which is how the
     * protocol layer tears down a failed connection.
     */
    async close(): Promise<void> {
      const target = socket;
      socket = undefined;
      if (target !== undefined) abandon(target);
      reportChannelEnded();
    },
  };

  // `hasPerRequestStream` is left undefined, and that absence is load-bearing. The protocol layer uses
  // it to choose a cancellation mechanism: set, it aborts a per-request stream; unset, it sends
  // `notifications/cancelled` as an ordinary JSON-RPC message. This is a shared channel, so the second
  // is correct — and it is what makes "this module introduces no cancellation of its own" true rather
  // than aspirational.
  //
  // `sessionId` is likewise left undefined. The SDK permits one, and it is precisely where an identity
  // would otherwise accumulate; the connection identity a tool context carries is minted and owned by
  // the layer that builds that context.

  return transport;
}
