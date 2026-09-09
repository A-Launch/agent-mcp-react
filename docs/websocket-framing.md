# The WebSocket framing contract

What goes over the wire between a page and an agent runtime. **Reference for anyone writing the
gateway side** — this is the whole contract, and it is deliberately small.

## One message per frame, and nothing around it

Each WebSocket **text** frame contains exactly one MCP JSON-RPC message.

```json
{
  "jsonrpc": "2.0",
  "id": 41,
  "method": "tools/call",
  "params": {
    "name": "customers.set_filters",
    "arguments": { "health": ["churning"] }
  }
}
```

**No envelope is added.** Not this:

```json
{ "tab": "x", "messageType": "mcp", "payload": { "…": "…" } }
```

An envelope would make this a private protocol wearing MCP's name: a standard client could not speak
it, and every gateway would need this library's own unwrapping code.

**Tab identity does not travel in the frame.** It is in the connection URL, where the gateway reads it
once at the upgrade — after the ticket is redeemed, so it cannot enter the admission decision (see
[Page identity](design.md#page-identity)).

## Direction

The **browser is the MCP server** and dials outward. That is the architectural decision (see
[The core decision](design.md#the-core-decision)), not a transport detail: a page cannot be listened
to, so it connects to the runtime rather than the runtime connecting to it. So a gateway accepts
sockets and speaks the MCP **client** side.

## Serialization

Outbound frames use `JSON.stringify`, **deliberately not the SDK's `serializeMessage`**. That helper
appends a newline delimiter, which is correct for a stream transport where messages must be separated
and wrong here — a WebSocket frame already has a boundary, so the delimiter is a byte the peer must
strip and a subtle interop failure if it does not.

Inbound frames are parsed and **validated as MCP messages before being delivered**. A frame that is not
one produces `MCP_WS_FRAME_NOT_A_MESSAGE` rather than being handed upward as though it were.

## What a gateway must do

1. **Accept the upgrade only with a valid ticket.** Refuse at the HTTP upgrade, before the handshake
   completes — so no `open` fires and no MCP session exists. See
   [connecting-to-an-agent.md](connecting-to-an-agent.md).
2. **Speak the MCP client side.** `initialize`, then `tools/list` and `tools/call`.
3. **Deliver one message per frame**, in both directions.
4. **Expect unsolicited notifications.** This connection negotiates protocol era `2025-11-25`, where
   `notifications/tools/list_changed` dispatches straight to a registered handler — there is no stream
   to open and no subscription to make.

## Failure causes the page reports

| Code | Meaning |
|---|---|
| `MCP_WS_URL_UNAVAILABLE` | the application's URL supplier did not produce one |
| `MCP_WS_CONNECTION_FAILED` | the socket did not open, or closed before the attempt settled |
| `MCP_WS_CHANNEL_NOT_OPEN` | a send was attempted on a channel that is not open |
| `MCP_WS_FRAME_NOT_A_MESSAGE` | a frame arrived that is not an MCP message |

**There is no `MCP_WS_AUTH_FAILED`.** A refused ticket is refused at the upgrade, so the page sees a
socket that would not open — indistinguishable from a dead gateway, and honestly so. The four real
causes (`absent`, `unknown`, `spent`, `expired`) exist only in the gateway's own reporting.

## One attempt always settles

An attempt has a **10 second deadline**. It resolves or fails within it, whatever the socket does —
because a page waiting on a socket that neither opens nor errors would show "connecting" forever, and
the reconnection schedule would never advance.
