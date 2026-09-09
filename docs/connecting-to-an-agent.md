# Connecting to an agent runtime

The browser is the MCP **server** and it dials **outward**. That direction surprises people every
time, and it is not a design preference: browser JavaScript cannot listen for inbound connections, so
the server has to reach the client.

Everything below follows from that one fact.

## What you supply, and what the library supplies

The provider takes a **function**, never a credential:

```tsx
<AgentMcpProvider connection={{ getUrl: () => buildDialUrl() }} … />
```

`getUrl` is called **once per connection attempt**. Its result is opaque to the library: never parsed,
never validated, never amended, and its scheme is not read. That is the seam through which
authentication reaches the socket without the socket knowing what authentication is — and it is why
nothing the library holds can leak a credential. It holds none.

| | Who owns it |
|---|---|
| The credential in the URL | **You.** Minted by your backend, per attempt |
| The page instance's identity | **The library.** Read it with `useMcpTabId()` |
| Appending the identity to the URL | **You**, inside `getUrl` |
| The socket | The library, in `src/transport/` and nowhere else |

## Minting a credential from your backend

The design asks for a short-lived, single-use ticket, scoped to one application, user and tab (see
[Authentication](design.md#authentication)). The library
neither mints nor verifies it — it cannot, because the URL is opaque to it — so this is an obligation
on your deployment that this document states and no code here can enforce.

```ts
async function buildDialUrl(tabId: string): Promise<string> {
  const response = await fetch('/api/agent-ticket');           // your backend
  if (!response.ok) throw new Error('could not mint a ticket');
  const { wsUrl } = await response.json();

  const dial = new URL(wsUrl);
  dial.searchParams.set('tabId', tabId);                        // metadata, never a credential
  return dial.toString();
}
```

**Do not hold the ticket anywhere.** Fetch it at the moment it is needed and hand it straight over.
A ticket in a variable, a store or a log is a ticket in a screenshot.

**One ticket per attempt, never reused.** A transport instance is single-use: there is no way to
re-dial one, so every attempt necessarily runs `getUrl` again. Keep your gateway strict about single
use in development too — a permissive dev gateway hides exactly the bug that shows up first in
deployment.

## The page instance's identity

Each page instance gets one, and the library mints it:

```tsx
function App() {
  const tabId = useMcpTabId();
  return <AgentMcpProvider connection={{ getUrl: () => buildDialUrl(tabId) }} … />;
}
```

It is **metadata and never a credential**. Holding it grants nothing — no capability, no policy
decision and no tool admission consults it. It is safe to log, safe to render and safe to put in a URL,
which is the entire point: an agent runtime holding several connections uses it to say which page it
means.

Three things worth knowing:

- **It is readable during the first render**, and needs no provider above it. An identity is a fact
  about the page, not about a connection, so there is no absent case to handle and no placeholder for
  anyone to append by mistake.
- **It is stable for the document's lifetime** — across rerenders, route changes, provider remounts
  and StrictMode's double invocation. A reload is a different page instance and gets a different one.
- **Do not write your own.** A hand-written id is unique only by luck. Two copies of one page then
  claim one identity and the agent's request is answered by whichever connected first — a wrong answer
  that looks completely normal. This happened in this repository's own demonstrator.

It throws rather than returning a substitute where there is no page instance to name (a server render)
or no cryptographic source to mint from (a page served over plain HTTP from something other than
localhost). Catch `PageIdentityError` and branch on `IDENTITY_UNAVAILABLE` if you need to tolerate
either.

## Rejecting an unauthenticated socket

Refuse at the **HTTP upgrade**, before the handshake completes. Then a rejected page never sees an
`open` event and never sends anything to an unauthenticated peer.

## What a refused page can and cannot tell you

This is the part that most often surprises people, and getting it wrong sends an operator to the wrong
process.

| What happened | What the page is told |
|---|---|
| `getUrl` threw — your backend refused, or was unreachable | `MCP_WS_URL_UNAVAILABLE` |
| The gateway refused the upgrade — no ticket, unknown, spent or expired | `MCP_WS_CONNECTION_FAILED` |
| The gateway was not running at all | `MCP_WS_CONNECTION_FAILED` |

**The last two are the same code, and that is deliberate.** A refused handshake and a dead port are
byte-identical to a page: an error event with no status, no headers and an empty message, then close
code 1006. A library that reported "authentication failed" would be wrong every single time the
gateway was merely down — and would send you looking for a credential problem instead of a stopped
process.

**There is no `MCP_WS_AUTH_FAILED`.** Your gateway does distinguish `absent`, `unknown`, `spent` and
`expired`, and should log them — that is where you diagnose an authentication problem. The page cannot.

The first row is a different code on purpose: it points at a different process. If your backend never
minted a ticket, checking the gateway is a wasted trip.

## Multiple tabs

Each tab is an independent MCP server with its own state, its own tool set and its own connection.
Selecting among them belongs to your agent runtime, not to this library. Give each page instance a
distinct identity — which `useMcpTabId()` does for you — and refuse an ambiguous request rather than
picking one. Any policy that silently chooses makes a two-tab session succeed against an arbitrary tab.

## Reconnection

A connection that was **established and then dropped** comes back on its own. Your gateway restarting,
or a laptop waking from sleep, does not cost a reload.

```text
connected ──drop──► reconnecting ──► connected
```

The application observes `reconnecting`, carrying which attempt is in progress so a status surface can
say *"reconnecting — attempt 3"* rather than freezing on an error. It deliberately does not carry the
cause of the drop: a recovery rendered as a failure is the display this replaces.

**A first attempt that fails does not retry.** A channel that once opened proves your configuration
works; one that never did may be pointing somewhere that will never answer, and retrying that forever
would hide a misconfiguration behind a spinner. So a failed first attempt ends in `error` and stays
there — which is also what keeps that state meaningful, because recovery itself is unbounded and never
gives up.

The intervals are 500 ms, 1 s, 2 s, 4 s, 8 s, 15 s, then 30 s held indefinitely, with **jitter**. The
jitter is not decoration: without it every open tab retries at the same instant, and a gateway coming
back up is taken down again by its own clients.

### What this means for your gateway

**Every attempt takes a fresh credential**, and it is obtained **after** the wait rather than before.
That ordering is worth knowing if you write your own client, because both spellings satisfy "a fresh
credential per attempt" and only one survives:

| | Credential's age when your gateway sees it |
|---|---|
| Wait, then fetch | One attempt at most — bounded by the 10 s attempt deadline |
| Fetch, then wait | The whole interval — which reaches **30 s** at the schedule's maximum |

The design recommends a credential live 30–120 s (see [Authentication](design.md#authentication)). At
the lower bound those two numbers are identical, so the second spelling fails at exactly the step a
real gateway restart drives you to — and invisibly, because expired, spent and "the gateway is down"
all reach the page as one cause.

**Keep your gateway strict about single use in development.** A permissive one accepts a replayed
credential, every local reconnection works, and the first deployment fails on the second connection.

### What a reconnected agent knows

Nothing is re-advertised on a schedule, because nothing polls. If the page's tools changed while the
connection was down — a route change, a drawer opening — the agent is **told** when it returns, through
the same change notification it would have received had it been connected. A set that did not change
produces no notification.

Registrations survive the drop untouched. A tool belongs to the mounted application, not to the network.

## See also

- [Declaring a tool](declaring-a-tool.md)
- [The capability model](reference-capabilities.md) — what an agent may reach
- [Running the stack locally](local-development.md) — ports, the mock agent, and
  what to check when nothing connects
