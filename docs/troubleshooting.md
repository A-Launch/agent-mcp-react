# Troubleshooting

The failure modes worth knowing before you spend an hour on the wrong hypothesis: the class of bug
this library produces, what each one looks like from each test layer and from a browser, and the
order in which to read, reproduce, instrument and inspect. Entries are grouped by where the
**symptom** appears, not by where the cause lives — because that mismatch is the whole point of the
page.

Two things this page does not repeat. A page that will not connect at all, or a connection that
drops, is walked through in [local-development.md](local-development.md#when-nothing-connects) and
[local-development.md](local-development.md#when-a-connection-drops) respectively; this page starts
where a connection exists and something is wrong anyway. And the meaning of each error code is in
[reference-error-vocabulary.md](reference-error-vocabulary.md); here a code is named only where it
is the thing to look for.

## The class of bug this system produces

Almost every hard bug here is a **silent success**: the tool returns, the agent proceeds, and the
application is in a different state than the agent believes. There is no exception, no red test and
no error code. Three mechanisms produce nearly all of them:

1. **A stale closure** — the handler reads a previous render's state.
2. **Premature resolution** — the call returns after dispatch, before the store settled.
3. **A stale advertised list** — the agent's picture of what exists is older than the page.

When something is "working but wrong", start with those three before reading protocol traces.

## Symptoms by layer

The same defect shows a different face at each test layer, and several show none at all below the
browser. This is what each one looks like where — and, more usefully, where it stays invisible.
The layers themselves are described in [local-development.md](local-development.md#the-test-layers).

| Class of bug | Unit case | React case | Transport case | Integration case | A browser |
|---|---|---|---|---|---|
| Stale handler closure | Nothing — no renderer, no rerender | Green if it asserts the first call after mount; red only if it changes state and calls **again** | Nothing — it carries frames, not state | The tool reports success and the readback returns an older value | The screen shows a previous filter while the agent proceeds |
| Premature resolution | Nothing | Green if it waits for the change to land; red only if it asserts what the handler **read** on the line after the await | Nothing — a real socket's round trip gives React time to commit, which hides it | The tool's reported totals disagree with the screen's | The agent is told 48 while a person reads 7 |
| Stale advertised list | The derivation walks the wrong side and agrees in every ordinary case | A listing after unmount is empty; only a **call** after unmount catches the executing-once shape | A call names a tool no listing carried and is delivered anyway | `tools/list` still carries a tool of a route that unmounted | A call succeeds after navigation, once |
| StrictMode double registration | Nothing | A duplicate-name error in development; **nothing** outside StrictMode | Nothing | Two registrations, one of them orphaned | Two sockets, or every tool call happening twice |
| DOM reference table survives a rerender | Green in jsdom for the wrong reason — see [the empty snapshot](#the-dom-module) | A reference resolves to a node showing somebody else's data | Nothing | `dom.click` acts on the wrong row and reports success | The agent clicks "Zenith" believing it clicked "Acme" |
| Reconnect storm | The schedule is pure and clock-injectable, so a reset in the wrong place is a red case here | Nothing | Hundreds of attempts a second against the local gateway after it restarts | Nothing | The gateway is flooded by its own clients on every restart |
| SSR crash on `window` | The SSR-boundary case renders the provider in Node and is the one place this is caught early | Runs under jsdom, so `window` exists and nothing crashes | Nothing | Nothing | `window is not defined` on the server, before any effect |

The right-hand columns are where most of these become visible, which is why the integration layer
asserts **agreement** between what a tool reported and what the screen shows rather than either one
alone, and why a browser run is part of finishing a change and not a formality.

## Tools appear, then behave strangely

**Symptom: the agent sets a filter, the tool returns `{ success: true }`, and the UI shows the
previous filter — or an older one still.**
A handler captured at registration closes over the state of the render that registered it. Every
call then applies that render's values. The library's answer is a stable registered callback that
reads the latest handler through a ref, described in [design.md](design.md#stable-handlers). The
reason this is so easy to miss is that the FIRST call after mount is correct — the closure is fresh —
so it reproduces only after a state change the agent did not cause.

**Symptom: every rerender emits a `tools/list_changed` and the agent re-lists constantly.**
The tool is being withdrawn and re-registered because the handler identity changed. Same cause,
different face. Registration must not depend on the handler's identity: a rerender whose descriptor
is unchanged must not touch the registry at all. There is no update operation on the standard
registry, so a genuine descriptor change costs one withdraw-and-register cycle and must be driven by
an actual change in the descriptor, never by a new function reference. What a rerender costs and
what a change costs is in
[declaring-a-tool.md](declaring-a-tool.md#what-a-rerender-costs-and-what-a-change-costs).

**Symptom: a page that never mounts a provider still has `document.modelContext`, and `navigator`
grew a testing surface nobody asked for.**
The portability layer **initializes itself when its module evaluates**. A static import anywhere in
the build installs the registry, a deprecated host alias and a testing shim into every document —
before any effect runs, whether or not a provider ever mounts. Opting out means setting
`window.__webMCPPolyfillOptions = { autoInitialize: false }` *before* the import evaluates, which a
static ESM import makes impossible from inside the importing module, because imports are hoisted.
`src/webmcp/registry.ts` imports it dynamically for exactly this reason, and a case asserts that
importing the module installs nothing — convert it back to a static import and every other case
still passes.

**Symptom: a duplicate registration escapes as an uncaught exception even though there is a handler
on it.**
`registerTool` uses two failure channels. An already-aborted signal returns a **rejected promise**; a
duplicate name **throws synchronously**, before any promise exists to attach a handler to. So
`registerTool(...).catch(handle)` sees the first and lets the second past. `try { await ... }`
catches both. This is the same shape as the optional-call trap in the transport — the obvious
spelling silently drops an error — and being the second instance is why both have a case behind
them.

**Symptom: the page works over plain HTTP in development and behaves differently in production.**
The portability layer has **no secure-context check** — verified against its shipped source. Left
unguarded, a page on plain HTTP gets a working stand-in registry, looks instrumented, and then fails
somewhere unrelated; `crypto.randomUUID` being undefined is the usual second symptom. The boundary
performs the check itself and refuses with `MCP_REGISTRY_INSECURE_CONTEXT`. An environment that does
not report at all is treated as not secure — silence is not a secure context.

**Symptom: a tool exists twice, or a duplicate error fires in development but not production.**
StrictMode mounts, unmounts and mounts again. Cleanup that is not idempotent leaves the first
registration behind, and the second mount then collides with it. The registration is the leak; the
duplicate error is the alarm working. See [design.md](design.md#strict-mode-and-suspense).

**Symptom: the agent calls a tool with arguments the schema should reject, and the handler runs.**
The tool's `inputSchema` changed, but the registration was never refreshed. This is easy to build by
accident: if the schema is read from a ref at registration time while the registration effect
depends only on the name and the description, a schema change is invisible to the registry and the
agent keeps calling against the old contract. Observed in a published implementation of this same
binding, so it is a real shape rather than a hypothetical. A descriptor change — schema included — is
one withdraw-and-register cycle; the comparison MUST cover every field of the descriptor, not the two
that happen to be in a dependency array.

**Symptom: a tool is silently absent and nothing in the console explains it.**
A `registerTool` rejection was caught and logged instead of thrown. The same published
implementation turns a duplicate name into a `console.warn` and returns, leaving the tool
nonexistent and the application unaware. Here, development throws and names the source; production
preserves the original registration and refuses the later one. A rejection that becomes a log line
is the failure this library treats as a defect — an unknown is acceptable, a hidden unknown is not —
because the page keeps running and the agent's world model is quietly wrong.

**Do not detect a duplicate by the error it throws.** The standard specifies a promise rejected with
an `InvalidStateError` DOMException, and Chromium's native registry does that; the portability shim
throws synchronously with a plain `Error` whose message is `Tool already registered: <name>`.
Verified, not assumed. Decide the case from the ownership record instead: if this library holds the
name, another mounted component registered it; if it does not, the name is foreign. That test depends
on our own state and gives the same answer under any implementation. See
[design.md](design.md#duplicate-and-foreign-names).

**Symptom: every tool looks like it belongs to another script — nothing is bridged, and a name the
application clearly registered reports as held by a foreign owner.**
Two `AgentMcpProvider`s are mounted in one document. The registry belongs to the document, not to
the provider, so each provider keeps its own ownership record over one shared registry and
classifies the other's registrations as foreign. Every symptom is the rules working correctly, and
every one of them points at "some other script on the page." The provider makes this diagnose
itself: a document-scoped claim, taken at provider mount and released at unmount, so the second
provider fails with `MCP_REACT_PROVIDER_ALREADY_ACTIVE` naming the first — while a route change, a
hot reload and StrictMode's mount/unmount/mount still succeed. Suspect it when a micro-frontend, a
nested provider or a second copy of the library is on the page.

**Symptom: the tool is missing right after navigation, then appears.**
Registration happens in an effect, after commit — that is required, not a bug; see
[design.md](design.md#registration-follows-the-commit). What IS a bug is a tool that becomes callable
during render, or one that survives an aborted or suspended render. If you see a tool from a route
that never committed, look for a `registerTool` in a component body.

## The runtime, the listing and the call

**Symptom: an agent calls a tool nobody registered, and application code runs.**
Nothing resolved the name. **The MCP SDK validates nothing** — a call naming a tool that appeared in
no listing is delivered straight to the `tools/call` handler, which will happily do whatever it does.
This is measured, not theoretical. Name resolution is the second step of the gate chain for exactly
this reason (`src/runtime/resolution.ts`), and it decides from the registry and the ownership record
before anything else runs. The steps in order are in
[reference-capabilities.md](reference-capabilities.md#the-gate-chain).

**Symptom: an agent's call never completes, and the page looks slow.**
The handler returned something that cannot be serialized — a cycle, a live DOM node, a store
reference, a `BigInt`. Measured outcome: **zero frames, no error response, no unhandled rejection.**
The agent blocks until its own timeout. Nothing logs and no case fails, which makes it the quietest
failure in this codebase. The runtime proves a result serializable before handing it to the protocol
layer, and converts a failure into a tool error, `MCP_TOOL_RESULT_NOT_SERIALIZABLE`.

**Symptom: the agent receives a protocol error carrying the application's own exception message.**
A handler threw and the throw escaped. Two things are wrong at once: it is the wrong error kind — a
tool error says the tool ran and failed, which is what a model can react to, while a protocol error
says the request could not be processed — and the application's message is not this library's to
publish across a socket. The stack does NOT cross (the SDK serializes name, message and code only),
so the message is the whole exposure. Why a thrown message is replaced while a returned one is not is
in [reference-error-vocabulary.md](reference-error-vocabulary.md#throwing-loses-your-message).

**Symptom: cancellation never reaches a handler.**
The signal is not where you would first look. In the MCP SDK it is nested inside the request
handler's extras — `extra.mcpReq.signal` — rather than at their top level, and the path has already
moved between major versions. Two related traps: a signal this library created instead would never
learn the client cancelled; and a client's `callTool(params, options)` takes **two** arguments — a
signal passed in a third slot is silently ignored, so the cancellation never happens at all and the
failure looks like the server.

**Symptom: the agent's tool list is stale, or lists a tool that cannot run.**
Something cached it, or the derivation walks the wrong side. The listing is computed per request
from the registry intersected with the ownership record — walking the **record** instead and looking
each name up in the registry gives the same answer in every ordinary case and differs exactly where
it matters: it lists names the record holds that the registry does not. Both look correct until the
two sides disagree. See [design.md](design.md#the-tool-list-is-derived).

**Symptom: an alarm fires continuously on a page that is working fine.**
Divergence is being reported in both directions. A registry entry this library did not create is a
FOREIGN registration — the normal condition of a document shared with every script on the page — and
is excluded silently while still being refused at invocation. Only the other direction, a name in the
record that the registry does not have, is a broken invariant worth reporting, and that one is
`MCP_REGISTRY_OWNERSHIP_DIVERGED`.

## Calls refused when they should not be, or admitted when they should not be

**Symptom: a call is refused with `MCP_TOOL_CAPABILITY_DENIED` and the capability looks enabled.**
Check the shape, not the boolean. `dom: { inspect: true, interact: false }` denies `dom.click` by
design, and an omitted sub-capability is `false`, never inherited. There are exactly three members —
`application`, `dom`, `evaluate` — and an unknown one does not widen anything: it makes the whole set
unusable (`MCP_CAPABILITIES_UNUSABLE`), so the provider denies everything and registers nothing.
`dom: true` is not a grant either; it is refused, because admitting it would grant `interact` to an
author who believed they were granting a read. The shape is in
[reference-capabilities.md](reference-capabilities.md#the-shape).

**Symptom: the capability prop is right and the gate still denies, right after a change.**
A capability is in force when the render that granted it COMMITS, never when it renders. The ref the
gate reads is written from a layout effect, deliberately: React discards renders — an interrupted
concurrent render, a superseded transition, a subtree that throws — and a ref written during one that
never committed leaves the gate reading authority nobody granted. The dangerous direction is the
widening one, which is why the write is where it is.

**Symptom: an application "fixed" a denial by writing to the set `useMcpCapabilities` returned.**
It throws, and that is a gate rather than hygiene. The runtime reads the granted set live at every
check, so the object the hook publishes IS the object the gate consults — measured: with the freeze
removed, a component writing `capabilities.application = true` had its call admitted by a runtime
whose operator granted nothing. The set is frozen deeply at its source in `src/security/normalize.ts`;
`dom` is frozen too, because a shallow freeze leaves `dom.interact` writable and that is the half
that lets an agent act rather than read.

**Symptom: a tool is refused as unavailable a moment after the application opened it.**
Availability lands through the gateway's `refresh`, from a LAYOUT effect in `useMcpTool`, and that
choice is about a window rather than style. From a passive effect React commits `available: false`
while the ownership entry still says `true`, and a socket message is a macrotask — so a call arriving
in between reaches a tool the application has already closed. Every React test stays green there,
because `rerender` runs inside `act()` and flushes passive effects.

**Symptom: a tool that should be gated works.**
Two usual causes. The gate is inside the module it guards, so an import path reaches the handler
without passing it — the gate belongs in `src/runtime/invocation.ts`, on the path every call already
takes, never in `src/dom/`. Or the control is "absent from `tools/list`" rather than a refusal at
invocation, and the client called it anyway from a stale list. Absence from a listing is not access
control; the reasoning is in
[explanation-reachability.md](explanation-reachability.md#the-approach-refuse-at-invocation).

**Symptom: a refusal names the wrong problem, and the author fixes something that was never
broken.**
Gate order is a requirement, not an implementation detail, and `GATE_CHAIN` in
`src/runtime/gate-chain.ts` is what it is checked against — by DRIVING a call, not by reading the
constant. The two that bite: a reserved tool name must be reported before a schema is compiled
(`MCP_TOOL_NAME_RESERVED`, synchronously at declaration), or an author who renamed into `dom.*` and
changed a schema in one render is sent to fix the schema; and an unavailable tool must be refused
before validation, or an agent is sent off correcting arguments for a call that would have been
refused anyway.

**Symptom: `risk: 'destructive'` was declared and nothing gates on it.**
Correct, and it is not a bug. `risk` alone enforces nothing — it is not a declarable field at all.
What enforces is `available` and `confirmation`, described in
[reference-capabilities.md](reference-capabilities.md#per-tool-permissions). A risk level also never
softens a gate above it: a read-level tool under a denied capability is still refused, because the
capability step runs first and does not read the field.

**Symptom: a removed tool still executes once.**
A call already in flight against a stale list. The registry's removal must make the NAME
unresolvable at invocation, not merely stop advertising it. This is the last step of the acceptance
scenario in [design.md](design.md#the-acceptance-scenario), and it needs a case that calls after
unmount rather than one that lists after unmount.

**Symptom: the confirmation gate seems to work but the effect already happened.**
The gate ran after the handler, or inside it. Confirmation resolves before invocation; applying and
reverting is a mutation with an apology, and any non-idempotent action makes that visible.

## Transport and connection

A page that never connects, and a connection that drops, are walked through step by step in
[local-development.md](local-development.md#when-nothing-connects) and
[local-development.md](local-development.md#when-a-connection-drops). The entries below are the
transport bugs that happen while a channel exists, and the ones that look like something else.

**Symptom: every frame the page sends has a trailing newline, and the peer parses it fine anyway.**
`serializeMessage` was used to build the frame. It is the SDK's **stdio** framing helper and appends
a newline, because stdio messages are newline-delimited — but it sits right next to
`deserializeMessage` in the exports and reads like its symmetric partner. A WebSocket frame is
already a message boundary, so the newline is an addition the transport made. It survives review and
every round-trip test, because the trailing newline is still valid JSON. Outbound frames use
`JSON.stringify`; only the inbound direction uses the SDK. The case that catches this compares the
frame to the exact string — a "did the peer parse it" assertion cannot. See
[websocket-framing.md](websocket-framing.md#serialization).

**Symptom: a binary frame is reported as invalid JSON, and the peer's serialization looks broken.**
The frame was coerced to text before its type was checked. `binaryType` defaults to `'blob'`, and
`String(blob)` is `"[object Blob]"` — which then fails JSON parsing, so the reported cause names JSON
for a frame whose actual problem is that it was never text. `src/transport/websocket.ts` checks
`typeof data !== 'string'` **before** any parse, and reports the two conditions with different
messages under `MCP_WS_FRAME_NOT_A_MESSAGE`.

**Symptom: a connection attempt never settles, and reconnection never kicks in.**
A peer that accepts the TCP connection and then never completes the handshake produces **no socket
event at all** — no `open`, no `error`, no `close`. `readyState` stays `CONNECTING` indefinitely. The
retry schedule governs the interval *between* attempts, so a stalled attempt sits outside it
entirely: backoff never fires, because nothing failed. The transport owns a deadline covering the
whole attempt, including obtaining the URL; see
[websocket-framing.md](websocket-framing.md#one-attempt-always-settles). If a deadline case ever
passes suspiciously fast, check whether the socket gave up on its own rather than the deadline
firing — assert on the message.

**Symptom: the connection ticket turns up in a console or an error report.**
`ws.url` retains the full dialed URL, credential and all — and a connection failure is exactly when
a URL gets printed. Two related traps: attaching the platform's error event as a `cause`, whose
`target` is the socket, puts the ticket one property access away from anything printing the error;
and a URL that fails to parse must not be echoed back in the failure, which is the one case a "just
include the URL" fallback would leak. The transport reports origin and path only.

**Symptom: the library reports an authentication failure for a gateway that is simply not
running.**
The page cannot tell those apart, and something inferred it. A refused handshake and a dead port both
produce an error event with no status, no headers and an empty message, then close code 1006 —
identical. That is why the transport vocabulary has **no authentication code**: nothing in the
library produces one, and a case asserts its absence. A failed credential fetch is a different cause
with a different code — `MCP_WS_URL_UNAVAILABLE` — because that is an HTTP request and can read a
status; a failed dial is `MCP_WS_CONNECTION_FAILED` whatever the reason. A transport that names
authentication is guessing, and guesses wrong every time the gateway is merely down. What a refused
page can and cannot know is in
[connecting-to-an-agent.md](connecting-to-an-agent.md#what-a-refused-page-can-and-cannot-tell-you).

**Symptom: constructing a socket throws and nothing reports a channel end.**
`new WebSocket(url)` throws **synchronously** for a URL the platform will not accept — it does not
arrive as an error event like every other connection failure, so a `try` around it is easy to omit.
The consequences are three: the platform's exception crosses the boundary unwrapped, the failure
carries no code from the closed set, and `onclose` never fires, leaving the protocol layer waiting
for a teardown that never comes. The transport wraps the constructor, reports the channel ended, and
throws `MCP_WS_CONNECTION_FAILED`.

**Symptom: messages are dropped or the client reports a parse error under load.**
Each text frame must carry exactly one JSON-RPC message. Concatenating, batching or wrapping in an
application envelope breaks framing — and it breaks it intermittently, because small messages still
fit. See [websocket-framing.md](websocket-framing.md#one-message-per-frame-and-nothing-around-it).

**Symptom: reconnection appears to work and the gateway refuses every attempt at the cap.**
The credential is being obtained BEFORE the backoff wait rather than after. Both orderings satisfy "a
fresh credential per attempt", and they behave identically until the schedule reaches its maximum —
where the interval is 30 s and the recommended credential lifetime starts at 30 s, which is what the
mock agent's minter defaults to. Redemption refuses on `>=` and consumes the credential either way,
so at the cap it is refused every time and burned. The provider fetches AFTER the wait: a
credential's age is then bounded by one attempt deadline, which is threefold headroom at every step
forever. The failure is invisible from the page — expired, spent and "the gateway is down" are one
cause — so it presents as "reconnection never works and the gateway looks dead", diagnosable only
from the agent's log. See
[connection-lifecycle.md](connection-lifecycle.md#a-fresh-credential-per-attempt-structurally).

**Symptom: reconnection works locally and fails against the real gateway.**
The ticket was reused. Tickets are single-use; every reconnection attempt obtains a fresh one
through `getUrl()`. A permissive dev gateway accepts a replayed ticket and hides this until
deployment — which is why the mock agent's gateway is strict about it.

**Symptom: a reconnect storm — hundreds of attempts a second after the gateway restarts.**
The backoff is not being applied, or is reset on every attempt rather than on a successful
connection. The schedule in `src/transport/reconnect.ts` is 500 ms → 1 s → 2 s → 4 s → 8 s → 15 s →
30 s with jitter, capped at 30 s; see
[connection-lifecycle.md](connection-lifecycle.md#the-backoff-schedule). Jitter is not decoration:
without it, every open tab retries in lockstep and the gateway is DoSed by its own clients at each
restart.

**Symptom: two sockets from one page.**
The provider owns exactly one runtime and one connection. Under StrictMode, connection setup that is
not owned at the provider level and torn down idempotently opens a second. It usually presents as
duplicate tool calls, not as a connection error.

**Symptom: the agent's tool list is right but calls go nowhere after a reconnect.**
The new socket got a new transport but the registry was rebuilt, or the server was re-created
without re-advertising. After a reconnect the current registry state must be what the agent sees —
the tool set belongs to the page, not to the connection. What a reconnected agent knows is in
[connecting-to-an-agent.md](connecting-to-an-agent.md#reconnection).

## Results and state consistency

**Symptom: the agent reads state back immediately and gets the pre-call value.**
The call resolved after dispatch instead of after the store accepted the mutation. Synchronous
stores need read-after-dispatch; async operations need the request AND the store mutation to
complete before returning. See [design.md](design.md#a-call-settles-after-the-commit).

**Symptom: `afterRender()` resolves but the DOM has not updated.**
Check what the update was before suspecting the barrier. It promises a React commit including
everything scheduled **before** the call, plus that commit's passive effects — and three things are
outside it, by design and by documentation: work the application schedules from *inside* those
effects, an update deferred with `startTransition`, and an update to a **different React root**. If
it is one of those, the barrier is behaving as specified and the handler needs its own condition to
wait on. The promise and its limits are in
[explanation-commit-and-registration.md](explanation-commit-and-registration.md#what-afterrender-promises-and-what-it-does-not).

One animation frame is not proof that effects completed, and a frame is not the implementation.
Adding a second `requestAnimationFrame` to make something pass is the timing workaround this
repository forbids by name: establish the synchronization the mechanism actually needs.

**Symptom: `afterRender()` resolves instantly and every tool reports success before anything
renders.**
A flag guarding "the provider has torn down" was latched from a cleanup. **StrictMode runs mount
effects setup → cleanup → setup**, so any such cleanup fires once during a perfectly normal mount —
the provider resets the flag in the setup, not only on unmount. This is invisible to a suite that
asserts the change eventually landed; only asserting what the handler read at the line after the
await catches it. It also needs application state BELOW the provider to show up, which is the shape a
real page has and the shape a minimal test usually does not.

**Symptom: a handler awaiting `afterRender()` reads stale values after it resolves.**
The handler is reading the value its closure captured, which belongs to the render that created it —
and the commit it just waited for produced a different one. Read through a ref or an accessor that
returns the current value. The customer dashboard's `dashboard.current()` exists for exactly this.

**Symptom: an in-flight call is cancelled whenever the component rerenders with a new description.**
Something composed the **registration controller's** signal into the call instead of the tool's
declaration lifetime. The registry has no update operation, so a descriptor change is a
withdraw-and-register cycle and aborts that controller — while the tool is still declared, by the
same component, running the handler you have now. `OwnershipEntry.lifetime` in
`src/runtime/ownership.ts` is the signal that means "this tool stopped being declared", and it ends
on an unmount or a **name change**, never on a descriptor edit. This one is invisible in a suite that
only tests unmount and rename: both stay green.

**Symptom: an agent's `tools/call` never comes back and the page looks fine.**
A handler that ignores `context.signal` and never settles. The runtime races the handler against
cancellation, so the CALL settles — but only if something actually cancels it. Nothing times a call
out: the transport's deadline is the connection attempt, not a call budget. If the page is healthy
and the request is open, the handler is still running. What the handler receives and what the
signal means is in [declaring-a-tool.md](declaring-a-tool.md#what-the-handler-receives).

**Symptom: a cancelled call reports the wrong cause — an unmount when the agent cancelled, or vice
versa.**
Something read `signal.aborted` after the fact instead of the latched first cause. Both sources can
abort, in either order, and sticky state answers "did this ever happen?" rather than "what ended the
call?". `src/runtime/cancellation.ts` latches at the moment it happens; anything that re-derives it
later is reintroducing the bug. See [design.md](design.md#cancellation).

**Symptom: the agent cancelled and nothing came back at all — no error, no result.**
That is correct and is not a defect. Measured: the SDK's protocol layer discards the response to a
request its client cancelled, and that client rejected its own call the moment it cancelled. The
page's own record is where the outcome lives. The direction that MUST produce a frame is the other
one — a tool withdrawn under a call the agent is still waiting on.

**Symptom: cancellation "does not work" when driven through `POST /call` on the mock agent.**
Check the Node version and how the hang-up is detected. `request.on('aborted')` is deprecated and
silent on Node 24, and a route using it lets the tool run to completion after its caller has gone —
which from the operator's side is indistinguishable from cancellation not being implemented. The
mock agent's route uses `response.on('close')` guarded by `writableFinished`.

**Symptom: serialization hangs, blows the stack, or returns an enormous payload.**
A handler returned a live application object with cycles or a store reference. Output must go
through the declared schema; "whatever the handler returned" is not a contract. See
[design.md](design.md#tool-results).

## The DOM module

**Symptom: a ref works, then fails immediately after a rerender.**
Refs are temporary and governed by an epoch: node removal, a new snapshot, navigation, an explicit
invalidation, or a role or accessible name that no longer matches what the snapshot published all
invalidate them. This is correct behavior — `MCP_DOM_REF_STALE` tells the agent to re-snapshot.
A rerender alone does not invalidate a ref, and should not: a ref whose element is unchanged still
resolves. What a rerender CAN do is recycle a node into a different row, and the witness of the role
and name is what catches that. See [dom-inspection.md](dom-inspection.md#references-go-stale-and-that-is-the-feature).

**Symptom: the snapshot is EMPTY under jsdom and correct in a browser.**
The visibility test is reading layout. Measured: `checkVisibility()` does not exist in jsdom;
`offsetParent` is `null` and `getClientRects()` is empty for **every** element there, including a
plainly visible button. So all three obvious implementations report the visible control exactly as
they report the hidden one — and the cases above them go green against a serializer that returns
nothing. `src/dom/perceivable.ts` walks ancestors for `display:none`, `visibility:hidden`, `hidden`,
`aria-hidden` and `inert`, and reads no layout at all.

**Symptom: an element inside a `display:none` parent is reported as visible.**
`getComputedStyle` does not cascade `display` — the child reports its own `inline-block`. This is
NOT a jsdom deficiency and a real browser agrees, because the computed value is not the used value.
The ancestor walk is the correct implementation in both, and "fixing" it with a layout API
reintroduces the empty snapshot above.

**Symptom: a reference resolves to a node showing somebody else's data.**
The reference table trusted node identity. Measured here (React 19, index keys): after a filter
change the same `<button>` that said "Acme" says "Zenith" — same object, `isConnected` true, URL
unchanged. Every cheap condition passes. What refuses it is the WITNESS: the role and accessible name
the snapshot *published*, re-checked at use, in `src/dom/references.ts`. It cannot tell two
identically-named elements apart — a column of "Open" buttons — which is what `invalidateDomRefs()`
is for; see [dom-inspection.md](dom-inspection.md#when-to-call-invalidatedomrefs).

**Symptom: a stale-reference case is green with the guard deleted.**
Five conditions refuse a reference and four are cheap, so a case asserting only "it was refused"
passes for whichever fires first. Assert WHICH condition decided.

**Symptom: `dom.snapshot` returns a huge payload.**
It is returning page HTML. It must return semantic elements — role, accessible name, value — and
nothing else. See [dom-inspection.md](dom-inspection.md#what-an-agent-gets).

**Symptom: `dom.fill` reports success and the field is empty a moment later.**
The value was assigned rather than written through the element's native prototype setter. Measured:
`element.value = x` plus an `input` event leaves the DOM showing the value and React's state EMPTY —
React tracks the last value it wrote on the node, assigning updates that tracker as a side effect, so
React concludes nothing changed and never runs the handler. It then overwrites the DOM on its next
render, which is why the value appears and vanishes. `src/dom/interact.ts` walks the prototype chain
for the real setter and REFUSES when it finds none (`MCP_DOM_NOT_INTERACTABLE`, cause
`noNativeSetter`), because a fallback to assignment cannot be told from success. A case that asserts
`element.value` passes for the broken version — assert the APPLICATION's state, and assert survival
of the next render. See
[dom-inspection.md](dom-inspection.md#a-fill-reaches-your-handlers-and-that-took-work).

**Symptom: the agent clicked something a person cannot click.**
`element.click()` dispatches an event and skips hit-testing, so `inert` and `pointer-events: none`
do not stop it — measured in jsdom AND in Chrome, which behave identically here. The opposite
failure is `disabled`: the platform swallows that click silently, so an unchecked tool reports
success for nothing. Both are why `interactabilityOf` in `src/dom/interact.ts` decides before
anything is dispatched. Overlap and clipping are NOT covered, because that needs layout. See
[dom-inspection.md](dom-inspection.md#an-agent-cannot-do-what-a-person-cannot).

**Symptom: an interactability case is green with its condition deleted.**
Eight causes share one decision function. Assert WHICH cause decided. And check the ordering: the
specific causes run before `isPerceivable`, because perceivability already covers `inert` and would
otherwise make that cause unreachable.

**Symptom: a password value or a hidden field shows up in a snapshot.**
Redaction is unconditional and belongs to no capability. If it is implemented in the snapshot
serializer's "verbose" branch only, it will come back the first time someone adds a second
serializer. What never reaches the agent is listed in
[dom-inspection.md](dom-inspection.md#what-never-reaches-the-agent).

## SSR and bundling

**Symptom: the app crashes on the server with `window is not defined` or `WebSocket is not
defined`.**
The runtime is browser-only. The provider may render during SSR but defers all connection setup to
the effect phase. In Next.js and similar, the integration is marked client-side.

**Symptom: `crypto.randomUUID` is undefined.**
It is a required browser API and it is unavailable in insecure contexts — a page served over plain
HTTP from a LAN address, which is exactly how someone tests on a phone. The library fails loudly with
a named cause, `MCP_PAGE_IDENTITY_NO_UNIQUE_SOURCE`, rather than silently substituting a weak id. The
two platform preconditions are in
[browser-support.md](browser-support.md#two-platform-preconditions).

**Symptom: the DOM module ships in a build that disabled it.**
A static import from a shared entry point defeats tree-shaking. Level 2 has its own subpath export
(`agent-mcp-react/dom`) so that a build which never imports it never contains it. The provider
therefore does NOT import it: an application opts in by importing and an operator by granting, and
neither implies the other. Measured: the customer dashboard's bundle is 7,691 bytes smaller without
the import and contains no trace of the snapshot code. A seam row in
`tests/unit/module-seams.spec.ts` guards the mechanical half, matching both `./dom/` and `../dom/`
so that a sibling import from `src/index.ts` — the likeliest place, and the file the whole claim
rests on — is caught as well as a deeper one.

## Tests that lie

**Symptom: a React test passes while a real MCP client sees nothing.**
The test asserted against the library's own registry. Where the claim is about what an agent can
see, assert through `tools/list` and `tools/call`.

**Symptom: transport tests are green and the real socket misbehaves.**
The socket was mocked. Framing, closure, reconnect, auth rejection, concurrency and cancellation are
only meaningful against a real local WebSocket server, which is what `tests/transport/` runs
against.

**Symptom: an integration test passes while the UI never changed.**
It asserted the tool's return value. Assert the rendered consequence — that is the entire point of
the acceptance scenario's middle steps, and the return value is precisely the thing a silent success
gets right. And a DOM assertion alone cannot see "the UI updated LATE": assert **agreement** between
what the tool reported and what the screen shows, because a real socket's round trip gives React
enough time to commit that a premature resolution stays green. See
[design.md](design.md#testing-strategy).

## Diagnostic order

The order that usually works — what to read, reproduce, instrument or inspect first:

1. **Is it a silent success?** Compare what the agent believes to what the store actually holds. If
   they differ, it is a stale closure or premature resolution — not a protocol problem.
2. **Does the agent's tool list match the mounted page?** A mismatch explains "not found" and
   "executed after removal" both. `pnpm -C tools/mock-agent tools` prints what the page currently
   exposes; see [local-development.md](local-development.md#driving-a-call-by-hand).
3. **Which gate refused, and at which layer?** The error code distinguishes never-registered
   (`MCP_TOOL_NOT_FOUND`), disabled (`MCP_TOOL_DISABLED`) and denied (`MCP_TOOL_CAPABILITY_DENIED`).
   The in-page inspector shows the step that decided each call without instrumentation; see
   [observing-tool-calls.md](observing-tool-calls.md#the-inspector).
4. **Only then read frames.** Framing bugs are real but rare, and they look like parse errors, not
   like wrong behavior.
5. **Reproduce in `tests/react/` if it is lifecycle, `tests/transport/` if it is the socket.** If it
   only reproduces in the browser, it is bundling, SSR, or a real-socket semantic — which is what
   `tests/e2e/` is for.

When the cause is established, fix the cause. No retry, sleep or tolerance to mask a race, no
weakened assertion, no fallback branch, and never a disabled test to go green. When it is not
established, or the fix needs a decision the design does not settle, stop and escalate with the
evidence rather than guessing. The conventions behind that are in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## See also

- [README.md](README.md) — the documentation index
- [local-development.md](local-development.md) — the port block, the mock agent, the test layers
- [design.md](design.md) — the condensed design every entry above cites
- [reference-error-vocabulary.md](reference-error-vocabulary.md) — what each code means
- [observing-tool-calls.md](observing-tool-calls.md) — the callbacks and the in-page inspector
