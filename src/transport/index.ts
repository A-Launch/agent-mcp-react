// The transport module's front door: the browser side of the MCP connection, and the only code in
// this package that touches a socket.
//
// What it owns: one socket per instance, the framing of one JSON-RPC message per text frame, the
// deadline that guarantees a connection attempt settles, and the vocabulary it reports failures in.
//
// What it does NOT own, so that finding each absent reads as a decision rather than an omission: the
// connection state machine and reconnection (the provider's — docs/connection-lifecycle.md), anything
// about
// authentication (the URL arrives opaque and is never interpreted), any identity (the tool context's
// connection id is minted by the layer that builds that context), and cancellation (the MCP protocol
// layer already aborts in-flight work when the channel ends — a second path would be a second owner).
//
// There is deliberately **no subpath export** for this module in `package.json`. The transport is
// internal surface: an application reaches it through the provider, never directly, exactly as it
// reaches the tool-registry boundary.

export {
  BrowserTransportError,
  isTransportFailureCode,
  TRANSPORT_FAILURE,
  type TransportFailureCode,
} from './errors.ts';
export {
  type BrowserWebSocketTransportOptions,
  type ConnectionUrlSupplier,
  createBrowserWebSocketTransport,
} from './websocket.ts';
