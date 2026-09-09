// The transport's failure vocabulary, and the only shape in which this module reports anything.
//
// Invariant this file enforces: **no raw platform value leaves this module.** Not a socket reference,
// not a close event, not an unparsed frame, not the platform's own error object. Everything crossing
// the boundary is one of the four named causes below.
//
// The reason is specific to this layer rather than general tidiness. A socket's failure event carries
// nothing a caller could act on — no status, no headers, no reason — and its `url` property carries the
// connection credential. So a platform value handed upward is simultaneously useless for diagnosis and
// dangerous to log, which is the worst combination a boundary can pass on.
//
// This vocabulary is deliberately parallel to `src/webmcp/errors.ts` rather than sharing a base with
// it. That module is specified as a leaf importing nothing of this library's own, and a case asserts
// it — the property that lets a revision of the tool-registry standard be absorbed in one directory.
// Sharing would trade a tested property for about fifteen lines. When a third module needs this shape,
// `src/runtime/` is the one that can host it, because it is not a leaf.

/**
 * Why a connection attempt failed, or why a frame or a send was refused.
 *
 * A closed set: membership is derived from this dictionary below, never re-listed as string literals
 * somewhere else.
 *
 * Four members, and the boundary between them is *what the page could observe*. It is not four because
 * four felt like the right number — it is four because a page can distinguish exactly these, and no
 * finer distinction exists to be reported honestly.
 */
export const TRANSPORT_FAILURE = {
  /**
   * The URL supplier failed or did not settle in time.
   *
   * Distinct from a connection failure because the owners differ: this one means the application's own
   * code threw, and no socket was ever opened. Folding it into the connection cause would send an
   * operator to check a gateway that was never dialed.
   */
  urlUnavailable: 'MCP_WS_URL_UNAVAILABLE',
  /**
   * The connection could not be established: the socket errored, closed before opening, or the attempt
   * deadline elapsed.
   *
   * **This is deliberately one cause covering several situations an operator would like told apart**,
   * and that is not a shortcut. A page cannot tell a refused handshake from a gateway that is not
   * running: both produce an error event with no status and no headers, then a close with code 1006.
   * Splitting this into "refused" and "unreachable" would mean guessing, and the guess would be wrong
   * every time the gateway was merely down.
   */
  connectionFailed: 'MCP_WS_CONNECTION_FAILED',
  /**
   * A message was handed to a transport whose channel is not open.
   *
   * Reported rather than queued or dropped. Queuing would mean a caller believing a message was sent
   * when it is sitting in memory awaiting a connection that may never come — the silent success this
   * project exists to prevent, at the lowest layer where it can occur.
   */
  channelNotOpen: 'MCP_WS_CHANNEL_NOT_OPEN',
  /**
   * An incoming frame was not one JSON-RPC message: not text at all, not valid JSON, or valid JSON that
   * is not a JSON-RPC message.
   *
   * One cause for all three because the caller's response is the same — the peer sent something this
   * channel cannot carry. The *message* distinguishes them, because a reader debugging a non-text frame
   * and a reader debugging malformed JSON are looking in different places.
   */
  frameNotAMessage: 'MCP_WS_FRAME_NOT_A_MESSAGE',
} as const;

export type TransportFailureCode = (typeof TRANSPORT_FAILURE)[keyof typeof TRANSPORT_FAILURE];

/** Membership derived from the dictionary, so a new cause cannot be half-added. */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set(Object.values(TRANSPORT_FAILURE));

export function isTransportFailureCode(value: string): value is TransportFailureCode {
  return TRANSPORT_FAILURE_CODES.has(value);
}

/**
 * Every failure this module raises.
 *
 * One class, because a caller distinguishes cases by `code` — a value from the closed set above —
 * rather than by `instanceof`, which is the test that breaks the moment two copies of this library are
 * bundled onto one page.
 *
 * **No `cause` is carried, and that is a departure from the registry boundary's error on purpose.**
 * There, the platform's exception is attached so a developer can read what the platform said. Here the
 * platform's value is a socket error event whose `target` is the socket, and the socket's `url` holds
 * the connection credential — so attaching it would put the ticket one property access away from every
 * console that prints the error. Invariant this class keeps: a connection credential never appears in
 * anything this module reports. There is nothing in the platform's event worth breaking that for — it
 * carries no status, no headers and an empty message.
 */
export class BrowserTransportError extends Error {
  readonly code: TransportFailureCode;

  constructor(code: TransportFailureCode, message: string) {
    super(message);
    this.name = 'BrowserTransportError';
    this.code = code;
  }
}
