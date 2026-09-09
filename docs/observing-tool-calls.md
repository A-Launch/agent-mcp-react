# Observing tool calls

Every call this library admits or refuses can be explained after the fact: which tool, by which route,
and **which step of the gate chain decided it**. A refusal you cannot attribute to a step is an
unexplainable state, and an unexplainable state is indistinguishable from a wrong one.

## Five callbacks, all optional

```tsx
<AgentMcpProvider
  onToolCall={(event) => …}        // a call beginning, either route
  onToolResult={(event) => …}      // settled with a result
  onToolError={(event) => …}       // settled with a refusal, a throw or a cancellation
  onRegistryChange={(event) => …}  // the document's tool registry moved
  onRegistration={(event) => …}    // a declaration refused before it became a tool — every cause
  … />
```

**Optional, and optional in effect.** Supply none and the library builds no record at all — no id, no
timestamp, nothing copied. That is worth stating because the neighbouring `validation` prop is
optional to pass and not optional at all in what it decides.

Every call **that reaches this library** produces exactly **one** start event and **one** terminal
event, correlated by `callId`. The exception is real and is described under *What the guarantee does
NOT cover* — a page-script call the registry refuses before our callback runs never reaches us at all.

## Two routes, and only one of them is gated

| | `bridge` | `registry` |
|---|---|---|
| Who called | the agent, over the socket | any script on the page |
| Passes | all six built gates | the declared schema, and nothing else |
| A schema refusal is | reported to your observers | **invisible — see below** |

**A page-script call with bad arguments produces no event at all, and reading that silence as "nobody
called it" is the mistake to avoid.** The adopted registry validates arguments against the declared
schema itself and throws before it ever invokes our callback, so there is no signal for this library
to observe — not a decision it makes, a call it never receives. The refusal is real and the caller
sees it; your log does not. A bridged call with the same bad arguments *is* reported, with the gate
that refused it, which is what makes the asymmetry easy to miss.

`tests/react/registry-route-validation.spec.tsx` pins that silence as a case, so a registry that ever
stops pre-validating turns it red rather than changing what you see without saying so.

Both appear on the same callbacks, and every record carries `route` as a **required** field. A separate
hook for page calls would be one you wire while believing you have coverage.

A page-script record reports the gates that never ran as `notRun` — never as `passed`, and never by
leaving them out. This is where `permissions: { available: false }` becomes visible: it refuses the
agent and does nothing whatever to the page.

```
#12 invoice.mark_paid · bridge   · refused at policy — MCP_TOOL_DISABLED
#13 invoice.mark_paid · registry · ok
    page call — bridge gates were NOT applied: capability, policy, confirm
```

**A record says how a call arrived and never who made it.** A JavaScript call carries no trustworthy
caller identity — a widget, an extension and your own code are indistinguishable at the callback — so
naming one would present a guess as a fact.

## What events carry

`metadata` by default, **in every build including development**. A build flag is not consent to capture
sensitive data, and a default that differed by build would leave the shape you ship the one never
exercised.

```tsx
<AgentMcpProvider observability={{ payloads: 'values' }} … />
```

Under `metadata` an event carries the tool name, the route, timing, the gate outcomes, the failure
code, and schema-declared field paths — things the caller already holds. It carries **no value, and
nothing derived from one**: not a length, not a sample, not an element count. A password's length is a
side channel.

The reason the default is metadata even in development is worth knowing, because the obvious argument
against it is wrong. "Your handler already receives the arguments" holds only for calls that reach the
handler — **a call refused at resolve, capability, policy, validate or confirm never does.** A refused
call is exactly where a value-carrying event hands you data you would otherwise never have seen, and an
argument that failed validation is the likeliest of all to be malformed or secret.

Under `values` the payload is a bounded, detached snapshot, so a cycle, a getter, a live DOM node or an
enormous object cannot reach you and you cannot mutate what a handler is about to receive.

## What the guarantee does NOT cover

Delivery is deferred through one ordered queue. Your callback is never awaited by the call, cannot
change its outcome, and cannot make it fail.

It does **not** promise that a callback burning CPU leaves the call unaffected. JavaScript is single
threaded and no scheduling choice in a browser can promise that.

A callback that throws reaches `onUnexpectedState` under `MCP_REACT_OBSERVER_FAILED`, labelled a
consumer failure so nobody goes looking in this library for a bug in your logging.

Two more absences, measured rather than assumed:

- **A handler that never settles and is never cancelled produces a start and no terminal.** There is no
  outcome to report, and no timeout is invented here.
- **A page-script call refused by the REGISTRY produces no record at all.** A descriptor that declares
  an `inputSchema` is validated before the callback this library registered is ever invoked, so there
  is nothing for us to observe. That cannot be closed from inside this library.

## Reading the registry from your own code

**`document.modelContext` is not there when your component mounts, and a consumer that looks once
stays empty forever.** The provider adopts the registry inside an effect and the adoption is
asynchronous — it may install a portability shim first. React runs a child's effects before its
parent's, so a component that reads the registry in its own mount effect is asking before the
provider has answered. Nothing is wrong and nothing reports anything; the reader simply sees no
registry and, having looked once, never learns otherwise.

**Wire `onRegistryChange` and read it from there.** It fires when the registry's contents change,
which for an application that declares any tools means the first registration — by which point the
registry exists:

```tsx
<AgentMcpProvider
  …
  onRegistryChange={() => {
    const registry = document.modelContext;
    // Present from here on. Subscribe, enumerate, render — whatever your panel does.
  }}
>
```

That covers the ordinary case. **It does not cover an application that declares no tools at all**,
where nothing ever changes and the event never fires. There is no public API today that resolves when
the registry becomes available and nothing else; `ensureRegistry` exists internally and is deliberately
not exported, because acquiring a page's registry belongs to the provider's lifecycle rather than to
whoever imported a module. If you need readiness without a registration, poll for it on a short
interval and stop when it appears — the same thing this repository's own end-to-end helpers do.

**Do not read the registry at module scope.** It would run during server-side rendering, where there
is no document at all.

## The refused-declaration event

`onRegistration` fires when a declaration is refused before it ever becomes a tool, and it carries
every cause with the `code` that says which: a missing validator, a duplicate name, a name held by a
foreign script, a reserved prefix.

**A refused declaration does not unmount your application.** It used to: the refusal was re-thrown from
the provider's render, so an author who forgot to install a validator got a blank page with the
console message naming the fix underneath it. MCP is a second control interface onto one application,
and a misconfigured second interface must not take down the first. What has not changed is that the
tool is refused — absent from `tools/list`, uncallable by an agent and by any page script — and the
refusal is now scoped to the declaration that earned it, so the other tools on the page survive it.

The event is optional to wire, so a development build also writes the refusal to the console with the
declaration site. That is the channel for an author who wired nothing; `onRegistration` is the one for
an operator who did.

## The registry-change event

The document's registry is shared with every script on the page, so "the registry moved" and "what the
agent can see moved" are different questions. `agentVisibleMoved` answers the second.

A widget registering its own tool reports `false` and sends the agent nothing. Without the event, the
first sign would be a call refused as `foreign`, after the fact and on a different channel.

## The inspector

```tsx
<AgentMcpProvider devtools={{ enabled: true }} … />
```

```ts
import { createInspector } from 'agent-mcp-react/devtools';
const inspector = createInspector({ host: element });
inspector.dispose();
```

It shows the connection status, the **bridged** tools — a tool your application has closed is declared
and not bridged, so it will not be listed — and the recent calls with the step that decided each. The
history belongs to the panel, so one opened after a denial has no record of it. It takes a host element and **nothing else** — no runtime, no registry, no handler — so it can
explain a denied call and can never make one. It imports no React and attaches nothing on import, and a
build that never imports the subpath never carries it.

`window.__AGENT_MCP__` exists only when the build is a development build **and** `devtools.enabled` is
true. Both, never either. It is **metadata-only in every configuration**, even when you opted the
callbacks into `values`: any script on the page can read a global, which is a far wider boundary than
your own callback.

It retains the most recent **20 calls**, and says so when it has dropped older ones. There is no knob.

## See also

- [Declaring a tool](declaring-a-tool.md)
- [Connecting to an agent](connecting-to-an-agent.md)
