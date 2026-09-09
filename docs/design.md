# Design

This document describes the design of the library as it is. It is a condensed projection of a longer
specification that is maintained outside this repository; where the two disagree, this document is
corrected. Source comments and other pages link into its sections, so each heading below is a stable
target: it carries the claim, names the invariant the claim protects, and links the page that shows it
in use rather than restating that page.

## What this library is

`@agent-mcp/react` is a browser-side React library that exposes a running React application as an
MCP server. An external agent inspects and manipulates the application through typed MCP tools that
the application's own components declare, so the agent calls `customers.set_filters({country: "RO"})`
rather than finding a dropdown, clicking it, and finding "Romania". The application keeps owning its
state and its rendering; the library owns the control plane that reaches them.

It runs entirely inside a normal React application, connects outbound from the browser to an
agent-controlled WebSocket endpoint, registers and withdraws tools with component lifecycle, notifies
the connected agent when the tool set changes, and provides explicit controls over what an agent may
reach. Semantic DOM control and JavaScript evaluation exist as optional, separately gated fallbacks.

The invariant everything else follows from: MCP is a **second control interface** onto one
application, not browser automation and not a second store. Both the human UI and the agent act
through the same application state transitions. [The explanation page](explanation-second-control-interface.md)
develops this from the problem it solves.

## Non-goals

The library does not replace React state management, render React components remotely, expose React
internals, replace Playwright or any browser-testing system, manipulate cross-origin iframe contents,
bypass browser security boundaries, make arbitrary application functions callable, expose all page
JavaScript by default, provide a standard MCP Streamable HTTP server, or support third-party MCP
clients that lack a compatible WebSocket transport.

These are binding scope limits rather than preferences. A pull request that adds one is declined on
scope, not on quality, and the contributor guide's scope section lists them together with the things
deliberately deferred and what stands in for each.

WebSocket is a deliberate custom MCP transport. MCP permits custom transports that preserve its message
semantics and JSON-RPC framing, and [the framing page](websocket-framing.md) states exactly what this
one puts on the wire.

## The core decision

The library treats MCP as a second application control interface. The human reaches the domain API
through the React UI; the agent reaches the same domain API through MCP tools; both act on the
application's supported state transitions, and neither has a private path around them. DOM
manipulation exists only as a fallback for functionality nobody has instrumented yet.

The declaration surface this is expressed through is the browser's own per-document tool registry. A
tool an application instruments once is reachable by this library's external agent, through the gates
described under [Security invariants](#security-invariants), and by a browser's own agent through the
page. The separation above is what makes that safe: both paths act through the same transitions.

The consequence for a tool author is the one rule the whole design turns on: a tool calls the same
action the human UI calls. A tool that reaches a store directly is a second implementation of a state
transition; the library ships no generic mutation tool and its adapters bind one action rather than
a store, and the rest is the author's — see [Intent, not implementation](#intent-not-implementation).
[The second-control-interface explanation](explanation-second-control-interface.md#the-approach)
is the page this decision lives on.

## Architecture

The browser is the MCP server and the agent runtime is the MCP client. The browser initiates the
WebSocket connection, because browser JavaScript cannot listen for inbound connections, and that does
not change the protocol roles: `tools/list` and `tools/call` flow from the agent to the page, results
flow back.

```text
Agent runtime: LLM → MCP client → WebSocket transport
                                        │ WSS, one MCP JSON-RPC message per frame
Browser: @agent-mcp/react
    runtime (server lifecycle, ownership record, derived listing, capability gate)
    transport (the only code that touches a WebSocket)
    webmcp boundary (the only code that touches the document's tool registry)
    react binding (provider, hooks)
        ├── application tools → React state / Redux / Zustand / router → application state
        └── DOM tools (optional) → the rendered document
```

Tools are declared through the document's tool registry, reached at `document.modelContext`. That
registry is platform infrastructure shared with every script on the page, which is the fact behind
several rules below: the library keeps an ownership record of what *it* registered, bridges only that,
and never places a gated tool in the shared registry.
[Why the browser is the server and dials out](explanation-second-control-interface.md#the-browser-is-the-mcp-server-and-it-dials-out)
is the page for the direction of the connection.

## Three levels of control

The library distinguishes three levels, and the distinction is structural: a separate module, a
separate capability, and a separate subpath export each, never a naming convention.

- **Level 1, application control** — `customers.set_filters`, `invoice.mark_paid`. Calls the same
  actions the human UI calls. The preferred level, and the reason the library exists.
- **Level 2, semantic DOM control** — `dom.snapshot`, `dom.click`, `dom.fill`, roles and accessible
  names only. A fallback for flows that have not been instrumented. Experimental.
- **Level 3, JavaScript execution** — `runtime.evaluate`. Privileged, debug-only, disabled by
  default, and never enabled to unblock a task.

One level confers nothing on another. Granting `application` does not make a DOM tool callable,
`dom.inspect` does not imply `dom.interact`, and nothing short of `evaluate` reaches Level 3. The
capability shape and what each grant admits are in [the capability reference](reference-capabilities.md#the-three-levels);
[the reachability explanation](explanation-reachability.md) says what each level costs an application.

A DOM tool for a flow that already has an application tool is a regression, not a convenience.

## Package structure

One package, `@agent-mcp/react`, with subpath exports for the parts an application opts into:
`/actions`, `/validation`, `/dom`, `/evaluate`, `/devtools`, `/redux`, `/zustand` and `/router`.
[The API reference](reference-api.md) lists what each entry point exports.

Inside it, one concern per directory, and most of these boundaries are enforced by cases in
`tests/unit/module-seams.spec.ts` rather than by convention:

| Directory | Owns | Never |
|---|---|---|
| `src/webmcp/` | The document's tool registry: locate it, initialize the portability shim when no native implementation exists, register, withdraw, enumerate, translate its failures | React, a socket, policy. The only code that names `document.modelContext` |
| `src/runtime/` | Server lifecycle on the SDK's low-level server, the ownership record, the derived tool list, the gate chain, the error vocabulary | React, a socket |
| `src/transport/` | The WebSocket transport and the reconnection schedule | Anything else; the only code that names `WebSocket` |
| `src/react/` | Provider, hooks, context | Policy, protocol; the only code that imports React |
| `src/security/` | Capability resolution, per-tool policy, redaction rules | I/O, a store, React |
| `src/dom/`, `src/evaluate/` | Level 2 and Level 3, supplied by the application through their subpaths | Registration into the shared registry, in any configuration |
| `src/actions/`, `src/adapters/` | Declaring a tool from outside React; thin store bindings on top | A store, a generic mutation interface |
| `src/devtools/` | The in-page inspector, observational only | A callable; it can explain a refused call and never make one |

The invariant: the standard the registry follows is a moving draft and the socket is the one place a
credential travels, so each must be absorbable in one directory. Every other module goes through the
boundary.

## The provider

An application mounts one `AgentMcpProvider` at or near its root, wrapping the tree it serves and
supplying four required props: how
to obtain a connection URL, the server's name and version, a `capabilities` object, and
`onUnexpectedState` — the destination a registry-integrity alarm travels to, which has nowhere to go if
it is absent. There is no default capability profile: an absent member denies. [The API reference](reference-api.md#the-provider)
lists the props; [the tutorial](tutorial-first-tool.md) shows the minimal wiring.

**A document hosts at most one provider.** A second — nested, a second bundled copy, a micro-frontend
bringing its own — fails loudly with `MCP_REACT_PROVIDER_ALREADY_ACTIVE`. The registry belongs to the
document, not to the provider; two providers would keep two ownership records over one registry and
classify each other's tools as foreign, which would be every rule below working correctly while the
diagnosis pointed at "some other script". A document-scoped marker claimed on mount and released on
unmount is what detects it, so a remount succeeds.

**The provider makes the registry exist before any tool registers**, in an effect and never at module
scope, which is what keeps server rendering safe. A native registry is used unchanged; otherwise the
portability shim is initialized. The shim itself declines to install over a native implementation,
and the library does not re-implement that precedence: it asserts the postcondition that exactly one
registry exists at the canonical location and fails loudly if not. The registry attribute requires a
secure context, so on an insecure origin the provider refuses rather than manufacturing an
environment that exists nowhere else; an environment that cannot say whether it is secure is treated
as not being so.

There is no degraded mode. If the registry is neither present nor installable, the provider does not
start, does not report ready, and does not present an empty tool set as a working state.

## Declaring a tool

`useMcpTool` is the principal abstraction: a lifecycle-correct binding onto the browser's tool
registry, not a registry of its own. A definition is the registry's own descriptor — `name`, `title`,
`description`, `inputSchema`, the handler — plus the fields this library's gates need and the
standard does not carry: `outputSchema` and `permissions: { available?, confirmation? }`. Every field
the standard defines keeps the standard's name and meaning. The standard's `annotations` are the one
descriptor field the declaration does not accept: they are hints to a caller and never enforcement,
and this library derives no gate from a hint. [Declaring a tool](declaring-a-tool.md#the-shape) is
the author's page.

Two things an author is told before the first declaration. **A declared tool is invokable by any
script in the page**: the registry is shared, and the capability model governs this library's bridge,
not who else on the page may call. There is deliberately no per-tool switch to withhold a declared
tool from the registry, so an action an author is unwilling to expose to any in-page caller is not
declared as a Level 1 tool at all. And **nothing an author writes softens a gate**: a description
that says "read-only" makes nothing safer, and every refusal below is decided from the declared
`permissions` and the granted capabilities, never from prose.

There is no `enabled` field. The registry offers no enable or disable, and availability is per-tool
policy refused at invocation, never absence from a list — see [Security invariants](#security-invariants).

Tools can also be declared from code that is not a component — a router, a singleton service, an
import-time module — through `registerMcpTool` from the `/actions` subpath.
[Tools outside React](tools-outside-react.md) explains what that is and what it is not.

## Tool names

Names are namespaced, lowercase, dot-separated and verb-last: `customers.set_filters`,
`dashboard.set_period`, `invoice.mark_paid`. They describe domain intent rather than implementation,
are unique within the page, and stay stable across releases where practical.

The registry permits 1 to 128 characters from letters, digits, underscores, hyphens and dots, and MCP
permits the same set. This convention is a subset of both, so a conforming name is always a legal
registry name and a legal MCP name, and no translation happens at any boundary.

Two prefixes are reserved and refused at declaration time, synchronously, with
`MCP_TOOL_NAME_RESERVED`: `dom.` for Level 2 and `runtime.` for Level 3. The tool list an agent
receives has two sources — the registry entries this library owns, and the built-in control tools,
which are never registered — and reserved prefixes keep the two disjoint by construction, so no
application tool can shadow a gated built-in. [Where a tool belongs](declaring-a-tool.md#where-a-tool-belongs)
shows the naming in use.

## Registration follows the commit

A tool becomes callable only after the owning component has committed, and stops being callable at
unmount. Registration happens in an effect, after commit, never during render; an aborted, suspended
or discarded render exposes nothing. The tool set therefore always describes the mounted application:
navigate from the customers screen to the dashboard and the customers tools are gone, the dashboard
tools present. [The commit-and-registration explanation](explanation-commit-and-registration.md) says
why a render is not a commit.

Withdrawal is an abort. The library creates one abort controller per registration and hands its
signal to the registry; the owning effect's cleanup aborts it, and that is the entire mechanism,
because the registry offers no unregister, update, enable or disable operation. Cleanup is idempotent,
so a second abort is harmless.

**The registry is the sole authority over which application tools exist.** The library keeps no
parallel list and never mirrors the registry into the MCP SDK's high-level server. What it does keep
is an **ownership record**, one entry per tool it registered, holding what the registry cannot: the
abort controller, the handler reference read at invocation, the last registered descriptor, the output
schema, and the permission fields. The single invariant that makes this a record and not a second
registry is that it is never consulted to answer which tools exist, what their input schemas are,
or whether one is registered. It is consulted for what the registry cannot hold — the output schema,
the permissions, the handler — and the listing an agent receives reads those from it. It is cleared by the same cleanup that aborts the controller, so the two cannot
drift apart.

Divergence between the two is handled in one direction only. A name in the ownership record that the
registry does not hold is a broken invariant: refused with `MCP_REGISTRY_OWNERSHIP_DIVERGED`, excluded
from the listing, and reported. A name in the registry that the record does not hold is another
script's tool — what a shared registry is — refused at invocation as foreign and excluded silently,
because an alarm that fires whenever any other library registers a tool is one nobody reads.

## Stable handlers

A rerender never touches the registry. The registry has no update operation, so a mistake here costs
a withdraw-and-register cycle: the agent observes a change-notification storm and, worse, a window in
which the tool does not exist and a call is refused. The library holds a callback that is stable for
the tool's whole lifetime and reads the latest handler through a ref in the ownership record.

The failure this prevents is silent. A handler captured at registration reads a previous render's
closure, so the value it applies is stale while the return value looks correct: the agent sets a
filter, the call reports success, and the application applied the value from three renders ago. No
type and no error surfaces it.

A genuine descriptor change — name, title, description, input schema, output schema — is recognized by
comparison against the last registered descriptor and costs exactly one withdraw-and-register cycle,
producing one change event. That one event is a property of sequencing: the registry coalesces
mutations onto a microtask, so an abort followed by an awaited registration produces two events, while
the same pair with nothing awaited between them produces one. The library resolves the registry before
aborting and performs abort and registration in one turn. A name change necessarily costs two events,
because two names changed. A new function identity for the handler is not a descriptor change.
[What a rerender costs, and what a change costs](declaring-a-tool.md#what-a-rerender-costs-and-what-a-change-costs)
shows the author's view; [why the handler is read at invocation](explanation-commit-and-registration.md#why-the-handler-is-read-at-invocation)
explains the ref.

## Duplicate and foreign names

The registry rejects a name it already holds, and because it is shared, the rejection has two
distinct causes that the library tells apart with the ownership record. Silent replacement is
prohibited in both, and neither is recovered from by renaming or retrying.

**Another mounted component of this application** registered the name: an application error,
`MCP_TOOL_NAME_DUPLICATE`. Development throws and names the registration source where the
environment offers a stack; production rejects the later registration, preserves the original, and
reports through the provider's unexpected-state destination rather than tearing the page down. The
application fixes it by changing its own code, which is why naming the source matters.

**A script this library does not own** holds the name — another library, a widget, an extension:
`MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER`. Reported separately because the application cannot fix it by
finding a second `useMcpTool` call that does not exist. A foreign registration that does not collide
is left alone: never bridged, and not an error.

Whatever the provider's unexpected-state destination receives lets a receiver tell the kinds apart by
code alone; reading a message string to decide what happened is how a wording change becomes an
outage. [When two things want one name](declaring-a-tool.md#when-two-things-want-one-name) shows the
author's view.

## The tool list is derived

The runtime answers `tools/list` by deriving the list on every request: the registry entries
intersected with the ownership record, minus what policy currently withholds, plus the built-in
control tools whose capability is granted. It caches nothing and keeps no second list to invalidate,
because a cache is a second answer to a question the registry already answers, and its invalidation
bug is silent.

Three consequences. Foreign registrations are never listed. Built-in control tools are never in the
registry and reach the listing from their own module, admitted only by capability. The two sources
are disjoint by construction, because the prefixes are reserved.

**Absence from the listing is not the access control.** Every exclusion above is also refused at
invocation.

A change to the agent-visible set sends `notifications/tools/list_changed`; a change that does not
move it — a rerender, a handler-only edit, another script's registration — sends nothing. Both the
registry's change event and the ownership record's own change are watched, because registration
writes the registry first and records ownership after, and a listing derived in that window would
classify the new tool as foreign; measured, not argued. The notification is sent only when the derived
listing actually differs from what was last advertised. The connection negotiates protocol revision
`2025-11-25`, where notifications are unsolicited and no subscription is opened; a case asserts the
negotiated revision, because an SDK upgrade that moved it would stop every notification arriving and
the symptom would be a quietly stale agent rather than an error.
[Observing tool calls](observing-tool-calls.md) covers the registry-change event as an application
sees it.

## Tool results

A handler returns a value; the library serializes it under an explicit contract. Where the tool
declared an output schema, the result is validated against it and carried as MCP
`structuredContent`, with human-readable `content` as an addition and never the only channel. Where no
output schema was declared, the result is carried as text alone, and structure is never invented for
a tool that did not declare it. Serialization does not automatically traverse arbitrary cyclic
application objects; a result that cannot cross the wire is `MCP_TOOL_RESULT_NOT_SERIALIZABLE`, and
one that violates its schema is `MCP_TOOL_RESULT_VIOLATES_OUTPUT_SCHEMA`.

**The bridge invokes the handler it registered**, directly from the ownership record, never through
the registry's own execution entry point. Two independent reasons, either sufficient. Structure: the
registry serializes a result to a string, and a round trip through it cannot tell an object from a
JSON string returned as a value. Gates: the registry's entry point is callable by any script and runs
none of the checks below, so a bridge built on it would bypass every gate this library exists to
enforce. Holding the handler is not a second authority over which tools exist; it is the thing the
library handed to the registry in the first place.

Both routes into a handler — the bridge and a page script calling through the registry — enforce one
compiled contract for input and for output. A page script whose call returns an off-schema value
receives a throw. [Schemas are binding](declaring-a-tool.md) is the author's page.

## A call settles after the commit

A tool call resolves only after the application has accepted the mutation. Returning after a dispatch
but before the store reflects it is a false success: the agent is told the change happened while the
page has not yet caught up, and a handler that reads its result in that window reports the previous
render's totals.

When rendering completion matters, the handler awaits `context.afterRender()`. What it promises,
stated as an observable condition rather than in frames: a React commit that includes every update
scheduled before the call, and that commit's passive effects. What it does not promise is part of the
promise. Work the application schedules from inside those effects — a fetch, a timer, an animation,
another dispatch — is not covered and cannot be; nor is an update the application deliberately
deferred with a transition, nor an update to a different React root. These limits are documented where
a handler author reads them.

An animation frame is never the implementation. It is a wall-clock event with no relationship to a
commit: on a busy page it can elapse before one, and in a background tab it never elapses, so the call
would hang until the user came back. The barrier settles rather than hangs wherever there is nothing to
wait for — no pending update, no renderer bound, a provider that unmounted mid-call — and gives up when
the call is cancelled.
[What `afterRender` promises, and what it does not](explanation-commit-and-registration.md) develops this.

## Cancellation

Everything in this section describes a call that arrives over the bridge. A page script calling
through the shared registry reaches the handler with the declaration-lifetime signal only: the
registry offers no per-call cancellation, so such a caller cannot cancel a call it started, and the
settlement guarantee below is the bridge's, not the registry's.

A bridged handler receives `context.signal`, and it is the platform's own per-request signal from the
MCP protocol layer — one controller per request id, aborted when the client sends
`notifications/cancelled` and aborted for every in-flight request when the channel ends — composed
with the tool's declaration lifetime through the platform's own composition primitive. Composition is
permitted; substitution is not. A signal this library created on its own judgement would not learn
that the client cancelled, and would be a second owner of one truth.

A declaration lifetime is not a registration. A descriptor change is a withdraw-and-register cycle
that aborts the registration's signal, and that never cancels a running call: the tool is still
declared by the same component, and the handler executing is the current one. A name change and an
unmount are withdrawals, and they do cancel.

**A call settles whether or not its handler cooperates.** The runtime races the handler against the
cancellation, so an uncooperative handler cannot hang an agent — and the consequence is stated rather
than hidden: such a handler may still be running, and may still mutate the application, after its call
was reported cancelled. The outcome becomes irrevocable when the handler completes; an abort that lands
while the result is being serialized or checked does not turn a completed call into a cancelled one,
because reporting otherwise would invite the agent to perform the mutation a second time. Which
cancellation it was is latched when it happens, and the first cause is the one reported.

An agent's own cancellation needs no response frame: the protocol layer discards it and the client has
already rejected its call. A withdrawal's cancellation is a response that must be delivered, because
the agent's request is live and waiting. An aborted call never returns a stale success, and a call
arriving after withdrawal is refused rather than merely absent; the two are different events.
[What the handler receives](declaring-a-tool.md#what-the-handler-receives) shows the author's side.

## Authentication

The browser authenticates to the agent endpoint with a ticket that the application's own backend
mints over an authenticated HTTPS request. What the library supplies is the socket and the seam: it
calls the application's URL supplier once per attempt and never embeds a credential in source, in a
bundle, or in anything it reports. What the ticket IS — single-use, scoped to one application, user
and page, cryptographically random or signed, short-lived (thirty to one hundred twenty seconds
before first use is the recommendation), revocable — is the backend's and the gateway's to enforce;
the library cannot see inside an opaque URL and does not claim to. The gateway owns the verdict: a
rejected upgrade reaches the page as `MCP_WS_CONNECTION_FAILED`, indistinguishable from an
unreachable gateway, and [what a refused page can and cannot tell you](connecting-to-an-agent.md#what-a-refused-page-can-and-cannot-tell-you)
says why. [Minting a credential](connecting-to-an-agent.md#minting-a-credential-from-your-backend)
is the application's page.

The transport is single-use: one instance, one attempt. Each reconnection attempt constructs a new
transport, and obtains its credential **after** the backoff wait, never before it. Both orderings
satisfy "a fresh credential per attempt" and behave identically until the schedule's maximum, where
the interval is thirty seconds and the recommended ticket lifetime starts at thirty; the wrong order
fails at exactly the step a gateway restart drives you to, and invisibly, because expired, spent and
"the gateway is down" reach a page as one cause. The transport scrubs the credential from everything
it reports. [The connection lifecycle](connection-lifecycle.md#the-five-states) and the
[framing page](websocket-framing.md) carry the rest.

Authentication establishes who is calling. It never implies what may be called: a connection's
identity confers no tool authorization, and the capability gate reads the granted set at every call.

## Page identity

Each page instance has a unique, ephemeral identity, minted by the library once per document —
lazily on first read, held under a well-known symbol so that two bundled copies of the library agree
— and published through `useMcpTabId`. The application appends it to the URL it supplies, because the
transport may not amend a URL. It is metadata for the agent runtime's routing, never a credential:
the gateway reads it strictly after redeeming the ticket, so it cannot enter the admission decision.

Never write one by hand. A hand-written identity is unique only by luck, and two copies of one page
then claim one identity; an agent's request is answered by whichever connected first, which is a
wrong answer that looks entirely normal. It happened in this repository's own demonstrator.

Every tab is an independent MCP server: its own React state, registry, DOM references, route,
connection and capability policy. Independence is per document, which is also why a document hosts at
most one provider. One measured qualification: registration is per document, but the registry's
enumeration walks same-origin frames under one top-level page, so a page and a same-origin iframe
within it are not independent for enumeration. Tabs are.
[Multiple tabs](connecting-to-an-agent.md#multiple-tabs) is the application's page.

## Strict mode and Suspense

React's development Strict Mode mounts, unmounts and mounts effects again. Registration tolerates it:
cleanup is idempotent, nothing leaks, and a temporary double mount never permanently creates a
duplicate tool. Repeated mount, unmount, mount leaves exactly one registration and no leaked
subscription. Connection ownership stays at the provider, so child registrations are safe under
repeated effect execution.

Under Suspense and concurrent rendering, a tool becomes callable only after its component committed.
Registration is an effect, never a call made during render, and an aborted render exposes nothing.
The React-layer cases assert both against the registry and the provider's refusal channel; the
acceptance scenario asserts the same tool set through an MCP client.
[A render is not a commit](explanation-commit-and-registration.md#the-problem-a-render-is-not-a-commit)
is the page.

## Server metadata

The page advertises itself to the agent as an MCP server named and versioned by the application: the
provider's `server` prop carries `name` and `version`, and those two fields are what the MCP
`initialize` handshake reports. Nothing else ships: no description field, and the library's own
version is not advertised separately. Both are recommendations in the requirement of record that
have not been built, stated here so a reader does not look for them.
[The provider](reference-api.md#the-provider) lists the props.

## Intent, not implementation

Tools express user or business intent — `invoice.mark_paid`, `customer.set_status`,
`dashboard.set_period` — never an implementation operation. A generic mutation tool such as
`redux.dispatch`, `react.set_state` or `zustand.set` widens the agent's reachable state space past
every schema the application declared and removes schema-level safety, so the library ships none and
its adapters cannot spell one.

The adapters make the intended shape the easy one rather than the only one. The Redux adapter binds
one action creator and a store is not one, so `redux.dispatch` is not spellable through it, though an
action creator that forwards whatever it is given would be. A bound Zustand action and
`store.setState` have the same structural type, so no signature tells them apart. What bounds a tool
in every case is the schema the author declared and the action they chose to bind, and
[one action, never a store](store-adapters.md#one-action-never-a-store) shows both spellings side by
side so the difference is stated rather than smoothed over.

Navigation is Level 1. A route change does change which tools exist — it unmounts the components that
declared them — and that is a reason to prefer a domain intent over a path, not a reason for a
navigation capability.

## No React internals

The library never reads or writes `__reactFiber`, `__reactInternalInstance`,
`ReactCurrentDispatcher` or the DevTools' private APIs, to read or to write application state.
Integration is exclusively through application-provided hooks, actions and stores.

The invariant this protects is the same one the core decision states: the library reaches state
through the application's own transitions or not at all. It is also what makes the runtime, the
registry boundary, the transport and the security module testable without a renderer, keeps a future
non-React binding a sibling directory rather than a rewrite, and keeps the library working across
React versions and production builds. [You do not need an adapter](store-adapters.md#you-do-not-need-an-adapter)
shows what "application-provided" means in practice.

## Security invariants

The library maintains the following, and every one has a case asserting the **refusal** rather than
merely the absence, because a tool that is hidden and still callable is the leak with a lucky ending:

1. No tool is exposed unless explicitly registered. No scanning, no convention, no inference from a
   store or a route table.
2. DOM control is disabled unless enabled.
3. JavaScript evaluation is disabled by default.
4. Tool inputs are schema-validated before the handler runs.
5. Disabled tools cannot execute.
6. Removed tools cannot execute.
7. Authentication is required for non-development connections.
8. Connection identity does not imply tool authorization.
9. Agent-provided data is untrusted.
10. Output serialization does not automatically traverse arbitrary cyclic application objects.
11. Sensitive values are not automatically included in snapshots.
12. Password field values are redacted from DOM snapshots.
13. Hidden input values are not exposed by default.
14. Authentication tokens are never included automatically — in a snapshot, a state read, or an error.
15. A tool this library did not register is neither listed to nor invokable by the agent.
16. No Level 2 or Level 3 tool appears in the document's shared registry, in any configuration,
    including the one that grants both to the bridge. Anything in the registry is callable by any page
    script without passing a single gate.

Invariants 15 and 16 exist because the registry is shared. The ownership record makes "did we register
this?" decidable, and reserved prefixes keep an application from registering into the built-ins'
namespace.

**Every call over the bridge passes a fixed gate chain, in order, and all of it runs before the
handler.** Authentication is settled at the socket upgrade, by the gateway, before any call exists;
then, per call: resolve the name, check the capability against the granted set read live at that
moment, check the tool's declared availability, validate the arguments against the declared schema,
resolve a required confirmation, and only then invoke the handler through its ref, raced against
cancellation. Each step assumes the ones before it passed. The confirmation step runs application
code by design, and its guarantee is bounded: the resolver cannot override a gate that already passed
and cannot reach one it has not.

A page script calling through the shared registry passes validation and invocation only; the ungated
steps are reported as not run, never as passed. A refusal names the field, the expected type and the
permitted set, and never the received value.

The chain lives in the runtime and is never re-implemented inside a handler, where each application
would write it again and one would get it wrong. [The gate chain](reference-capabilities.md#the-gate-chain)
is the reference for each step and its refusal code; [what the library redacts](reference-capabilities.md#what-the-library-redacts-and-what-it-does-not)
covers invariants 11 to 14; [the error vocabulary](reference-error-vocabulary.md) lists every code.

## Testing strategy

**A documented claim is not a verified one.** Every behaviour the library relies on in an adopted
package or in the browser's registry is owed a case in this repository, and no requirement is claimed
against such a behaviour before its case passes — because a dependency's documentation describes what
its authors intended, not what the resolved version does, and the failure surfaces in a browser channel
nobody ran. The obligation is not the same as full coverage: [the conformance page](conformance.md#the-rows)
lists each row with its case, and it lists the two rows that are still open by the same rule — the
React version range below the one installed, and whether a native registry agrees with the shim on
abort-driven withdrawal under a double-invoked effect — rather than letting an owed case read as a
passed one.

Five layers, each owning the mechanism it tests. Unit cases cover registration, withdrawal by abort,
duplicates of both kinds, availability refused by policy, reserved-prefix refusal, divergence, the
derived listing, handler updates without touching the registry, validation of input and output,
permission denial, connection state, reconnection and serialization. React cases assert the lifecycle
claims directly: mount, tool exists; rerender, no duplicate and no re-registration; the handler sees
current state; unmount, tool gone; Strict Mode, nothing leaked; route change, the set changes — read
from the registry and the provider's refusal channel, with the integration layer asserting the same
set through an MCP client so a registry that agrees with a broken listing is caught. Transport cases run against a real
local WebSocket server and never mock the socket. Integration cases drive the example application
through the mock agent with a real provider, transport and store. End-to-end cases run three browser
engines over one suite for what only a browser can catch.

Two rules cut across the layers. Every silence is paired with a delivery on the same connection: a
count of zero notifications is exactly what a delivery path that was never wired produces, so "nothing
arrived" proves nothing by itself. And a case asserts **agreement** between what the tool reported and
what the screen shows, never the outcome alone: deleting every `afterRender` from the demonstrator
once left every case green, because a real socket's round trip gives React time to commit. A DOM
assertion can see "never updated"; it cannot see "updated late", and late is the defect.

Every capability gate, policy branch, redaction rule and lifecycle guarantee is verified by deleting
the check and confirming its case goes red before restoring it. A suite that stays green without the
check was never testing it. [Local development](local-development.md) says how to run each layer.

## The acceptance scenario

The library is accepted when this sequence works reliably. It is the requirement's illustrative
sequence; the executed suite runs it as ordered cases over one application that is built once and
advanced, so that the first failure names where the narrative broke, with one substitution stated in
the suite itself: the demonstrator's accounts carry a `health` field rather than a `status`, so the
executed call is `customers.set_filters({ health: ["at_risk"] })` and the state read back is the
`health` filter.

1. A developer wraps a React application in the provider.
2. The browser establishes a WebSocket connection to an agent runtime.
3. A customers screen mounts.
4. `customers.set_filters` becomes visible to the MCP client.
5. The agent calls it with `status: ["active"]`.
6. The application's real state changes.
7. React rerenders.
8. The UI displays only active customers.
9. The agent calls `customers.get_state`.
10. The returned state contains `status = ["active"]`.
11. The user navigates away from the customers screen.
12. `customers.set_filters` leaves MCP discovery.
13. A subsequent invocation of that tool is refused.
14. No React internals and no DOM simulation were required.

No library change was needed to make the scenario pass against the example application, which is
what keeps the claim non-circular. The demonstrator it runs against is the customer dashboard under
`examples/`; [the tutorial](tutorial-first-tool.md) builds a much smaller example — a counter — with
the same wiring, and [step 4](tutorial-first-tool.md#step-4-call-it-and-watch-the-page-change) is the
scenario's steps 5 to 8 at that scale.
