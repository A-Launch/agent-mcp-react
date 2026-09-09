# Declaring a tool

> New here? [The tutorial](tutorial-first-tool.md) gets you to a working tool call in four steps.
> Looking for a name? [The API reference](reference-api.md) lists every export.

**Reference.** What `useMcpTool` does, what it exposes, and the one consequence you must not discover
by accident.

## The shape

```tsx
import { AgentMcpProvider, useMcpTool } from "@agent-mcp/react";

function StatusPanel() {
  const [status, setStatus] = useState("ready");

  useMcpTool({
    name: "panel.announce",
    description:
      "Change the status message the panel displays. The same action the buttons on the page perform.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    handler: (input) => {
      setStatus(String(input.message));
      return { announced: input.message };
    },
  });

  return <p>{status}</p>;
}
```

The tool exists from the moment `StatusPanel` commits until it unmounts. There is no registry to
manage, no cleanup to write, and no list to keep in step.

## Read this before you declare your first one

**A tool you declare is invokable by any script running in the page.**

The tool registry is shared platform infrastructure that belongs to the document, not to this library.
That is the point of adopting it — a browser's own agent can drive actions you instrumented, without
your application integrating with each one separately — and it is the trade you are making.

Three consequences follow, and none of them is a setting:

- **There is no per-tool switch that withholds a declared tool.** Not a prop, not a config key, not a
  build flag. A switch like that would add a fourth exposure concept beside capability, policy and
  control level, for a distinction the platform does not make: the entry is either in the document's
  registry or it is not.
- **This library's capability model governs its own bridge, not the page.** It decides what reaches an
  agent over the connection you configured. It cannot decide what a script already running in your
  page does with a registry the browser gave everyone.
- **It holds whether or not an agent is connected.** A tool is registered when its component commits.
  A page with no agent attached still has every tool in the shared registry.

So the rule is simple, and it is about what you declare rather than how you configure it:

> **An action you are unwilling to expose to any in-page caller must not be declared as a tool.**

If a third-party script on your page is untrusted, treat every declared tool as reachable by it, and
choose what you instrument accordingly.

## What a rerender costs, and what a change costs

Your component rerenders as often as any component does. That must cost nothing, and it does:

| What you do | What an agent sees |
|---|---|
| Rerender with the same declaration — inline schema, inline handler, anything | **Nothing.** The registry is not touched |
| Change the description, title or schema | **One** change, once |
| Change the `name` | The old name withdrawn and the new one registered — two changes, because two names changed |
| Give the handler a new function identity, as every render does | Nothing. A new function is not a change |

"The same declaration" means the same **content**. Two object literals written the same way are the
same declaration, however many times the render ran, so there is nothing to memoize and nothing to
hoist.

### A descriptor you compute changes on every render

```tsx
// Every render declares a different tool, and every one of those changes is real.
description: `Act on ${pending.length} pending items.`,
```

The library performs all of them — it cannot tell a change you meant from one you did not, and a tool
whose description no longer matches what it does is a worse failure than a noisy one. What it will do
is tell you: after an implausible number of cycles for one registration, it reports
`MCP_TOOL_REGISTRATION_CHURNING` **once**, through the provider's `onUnexpectedState`, naming the tool
and the count. You find out from your own telemetry rather than from an agent behaving oddly.

If the changing part is information rather than identity, put it in the handler's result instead of the
description.

## When two things want one name

| Build | What happens |
|---|---|
| Development | You are stopped, and told which tool and — where a stack is available — where the later declaration is |
| Production | The later registration is rejected, the original stays registered and callable, your application keeps running, and the conflict is reported to `onUnexpectedState` |

A name held by **another script on the page** is reported separately, because you cannot fix it by
changing your own code. Being told "duplicate" would send you looking for a second `useMcpTool` call
that does not exist.

## Where a tool belongs

> **A tool belongs to the component that implements its action.**
>
> Your application shell may own a tool only when that tool is correct on **every** route the
> application has — application metadata, a global preference, navigation itself. If a tool would fail,
> or mean something different, on some route, it belongs to that route.

The test is one you can run rather than one you assert: *is this correct on every route?* is a
property; *is this global?* is an intention.

The pressure runs one way, which is why the rule is written down. A screen that hits a lifecycle
problem is tempted to move its tool to the shell to make the problem go away — and a shell full of
screen-specific tools is an exposed tool set that no longer describes what is on screen, which is the
one thing an agent is entitled to rely on.

## What the handler receives

The arguments of the call, and a context carrying two things: a signal, and a way to wait for the page
to have rendered.

```tsx
handler: (input, context) => { ... }
```

Whatever the handler returns is what the caller receives.

### `context.signal` — when the call is over

It aborts when the agent cancels, when the connection ends, and when **your tool stops being
declared**: the component that declared it unmounted, or its `name` changed. Pass it to `fetch` and
your request stops with the call.

Changing a `description` or a schema does **not** abort it. The tool is still there, under the same
name, running the handler you have now — a rerender costs a call in flight nothing.

For a call from another script in the page there is no MCP request behind it, so there is no per-call
cancellation to give you; the standard's registry does not provide one. The signal you get is the
declaration lifetime, so an in-page call still stops when your component goes.

**Respecting it is worth doing, and how much it matters depends on who called you.**

For a call from an **agent**, ignoring the signal does not hang anything: the call is raced against its
cancellation, so an agent is never left waiting on a handler that will not stop. The cost is that your
handler keeps running, and may still change the application, after the agent has been told the call was
cancelled.

For a call from **another script in the page**, there is no such race. That route does not go through
this library's runtime at all — it is the registry's own callback, while the bridge invokes the handler
it registered (see [Tool results](design.md#tool-results)) — so a handler that ignores
the signal runs to completion and its value is returned to the caller as a success. On that route
respecting the signal is the only thing that stops the work.

### `context.afterRender()` — when the change is on screen

A tool must resolve only once the application has accepted the change it made. For state you set
yourself, that means waiting for React to commit:

```tsx
handler: async (input, context) => {
  setFilters(input);
  await context.afterRender();
  return { matched: rowsOnScreen() };
}
```

**What it promises:** a React commit that includes everything scheduled before you called it, and that
commit's passive effects.

**What it does not promise, and you should read this half as carefully:**

- Work you schedule *from inside* those effects — a fetch, a timer, an animation, another dispatch. No
  barrier can know when the last of it lands.
- An update you deliberately deferred with `startTransition`. You asked React to deliver that later,
  and it may commit after this resolves.
- An update to a **different** React root. This waits for the provider's root and has no ordering
  relationship with another one.

It settles rather than hanging when there is nothing to wait for, and it throws if the call is
cancelled while you are waiting, so your handler unwinds instead of waiting for a render nobody needs.

**If your store is synchronous and you are not rendering from it**, resolving after the dispatch is
enough — you already know the mutation was accepted. The barrier is for the case where "accepted" means
"on screen", which is what an agent reading your success will assume.

## Schemas are binding

`inputSchema` is checked in the runtime, before your handler runs. A call that does not match it never
reaches your code, and the agent is told which field was wrong, what it sent and what it could have
sent. You do not write those checks.

`outputSchema` is optional. Declare one and the agent receives your result as structured data as well
as text; a result that does not match becomes an error rather than data, because a tool that lies
about its own output is worse than one that fails.

**Declaring either requires a validator on the provider**, and a tool that declares one without it is
**not registered at all** — absent from `tools/list`, refused at invocation. That is deliberate:
advertising a contract nothing enforces is how a schema goes back to being documentation.

```ts
import { createAjvValidator } from '@agent-mcp/react/validation';

const validator = createAjvValidator();

<AgentMcpProvider validation={{ validator }} ... />
```

It is a separate import because it is large, and an application whose tools declare no schemas should
not carry it. Measured 2026-09-09: bundling `@modelcontextprotocol/server/validators/ajv` alone with
esbuild 0.28.2, minified for the browser, is 143.8 KB raw and **40.3 KB gzipped** at level 9. Take the
number again rather than trusting this one — the command is three lines and the dependency moves. One is enough for the whole application; build it once, at
module scope, since compiling a schema is the expensive half.

Values are never coerced and defaults are never inserted: your handler receives exactly what the agent
sent. A schema using a keyword the dialect does not define is refused when you declare it, not when
somebody calls it — a misspelled `requird` would otherwise be an ignored annotation and the field
silently optional.

**The dialect is JSON Schema draft-07**, because that is the validator the MCP SDK re-exports. `format`
works (`email`, `uri`, `date-time` and the rest). Keywords that exist only in 2020-12 — `prefixItems`,
`$dynamicRef` — are refused when you declare them. If you need 2020-12, supply your own validator: the
provider takes any object with a `compile` method, which is what that interface is for.

> **`createAjvValidator` requires CSP `unsafe-eval`.** Ajv compiles schemas into JavaScript with
> `new Function`, so under a `script-src` that omits `unsafe-eval` it throws while compiling — and a
> tool whose declared schema has no working validator is **not registered at all**, so a strict-CSP
> page exposes nothing. Supply your own `SchemaValidator` instead; see
> [the defect record](issues/validator-requires-unsafe-eval.md) and the worked example in
> `examples/customer-dashboard/src/csp-safe-validator.ts`.

## Declaring when a tool may be reached

A tool may declare `permissions`. Both fields are optional.

```tsx
useMcpTool({
  name: 'invoice.mark_paid',
  description: 'Mark the open invoice as paid.',
  inputSchema: { type: 'object', properties: {} },
  permissions: {
    available: invoice.status === 'open',
    confirmation: 'required',
  },
  handler: () => markPaid(invoice.id),
});
```

**`available`** — whether your application is currently offering the tool. An absent `available` means
available: the library will not read silence as "closed", or every tool written before this existed
would stop working. A tool you declare unavailable is refused at invocation with `MCP_TOOL_DISABLED`
and left out of the agent's listing — but the refusal is the control, not the listing. An agent holding
a list from a moment ago is still refused.

**`confirmation: 'required'`** — a person must approve before your handler runs. Give the provider a
`confirmation={{ resolver }}`; without one the call is refused rather than admitted. The resolver is
handed the tool name, its description and a frozen copy of the already-validated arguments, plus a
signal that fires if the call is cancelled. Anything it returns that is not `'approved'` denies —
including `true`, `undefined`, and a throw.

> ### These govern the agent's bridge, not your page
>
> **This is the thing to get right, and it is easy to get wrong in the direction that matters.** A
> capability and a per-tool permission gate calls arriving over *this library's connection to the
> agent*. They do not gate the tool itself.
>
> The tool you declare goes into `document.modelContext`, a registry shared with every script on the
> page — that is what adopting the browser standard means, and it is the point: a browser's own agent
> can drive actions you instrumented. **A tool you mark `available: false` is still registered, and any
> script on the page still runs it.** The same is true of `confirmation: 'required'`, and of an
> operator setting `application: false`.
>
> So: if you move a domain rule out of your handler and into `available`, you have stopped enforcing it
> for every caller that is not this agent. Keep the rule in the handler, where it applies to everyone.
> Use `available` for what your application is *offering* — a step not reachable yet, an invoice
> already paid — not for who is allowed to do it.

## What is not here yet

Stated so their absence reads as a boundary rather than an omission:

- **`risk` is not accepted.** The vocabulary exists — `read`, `write`, `destructive`, `privileged` —
  and the field does not, because nothing reads it and it cannot currently be transmitted: the MCP
  annotations schema admits five named hints and strips anything else. A field nothing reads is a
  promise that an action is governed when it is not. It arrives with the surface that reads it.
- **A dynamic policy function.** `available` is a declared value, not a callback consulted at call
  time. A callback would be your code running inside a gate, could not be prevented from widening by
  side effect, and would emit no change signal — so an agent would list a tool, the value would flip,
  and the next call would be refused against a list nothing could have told it was stale.
- **A call resolving before your store accepted the change.** A tool resolves when the handler returns,
  unless you await `context.afterRender()`.

## Reading state is a separate surface

A tool CHANGES something. To let an agent READ what your page is currently showing — so it can check
that its change landed, or decide what to do next — declare a state surface instead:

```tsx
useMcpState({
  name: 'customers',
  description: 'The current customer list state.',
  schema: CustomerStateSchema,
  getState: () => ({ filters, resultCount }),
});
```

That publishes `customers.get_state`. It is an ordinary Level 1 tool with everything on this page
applying to it — and it has three limits worth knowing before you write one, including that the schema
is a contract rather than a redactor. See [Exposing state for inspection](exposing-state.md).

## Related

- [Exposing state for inspection](exposing-state.md) — the read half, and what it does not protect
- [The documentation index](README.md)
- [What this library depends on, and what has not been verified](adopted-dependencies.md)
