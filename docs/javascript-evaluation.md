# Running JavaScript in the page — Level 3 (privileged)

> **Read this paragraph before enabling anything below.**
>
> In the design's own words, JavaScript evaluation *"effectively grants arbitrary same-origin
> application execution privileges"* — the DOM, application globals, `localStorage`, `sessionStorage`,
> same-origin APIs, authenticated requests, and any non-HttpOnly credential the page can reach. It
> *"MUST be treated as equivalent to privileged code execution within the application origin."*
>
> **It is never enabled to unblock a task.** If an agent needs to do something, instrument that
> something as a Level 1 tool. This is a debugging instrument, and reaching for it to make a flow work
> is the one change whose blast radius is the whole page.

## The four conditions

`runtime.evaluate` is reachable only when **all four** hold. None implies another, and every failure
direction is a refusal.

| # | Condition | If it is missing |
|---|---|---|
| 1 | The application **imported** `agent-mcp-react/evaluate` | `MCP_TOOL_NOT_FOUND` — and the code is not in your bundle at all |
| 2 | An operator **granted** `evaluate` | `MCP_TOOL_CAPABILITY_DENIED` |
| 3 | A confirmation **resolver** is wired | `MCP_TOOL_CONFIRMATION_UNAVAILABLE`, and the tool stays listed |
| 4 | A **person approved** this specific call | `MCP_TOOL_CONFIRMATION_REFUSED`, and the expression never ran |

Condition 1 is the only one nobody can switch on after the fact. Measured on this repository's own
demonstrator: a build that never imports the subpath is **1,982 bytes smaller** and contains no
occurrence of `runtime.evaluate`, the policy-refusal message, or the async-function constructor — with
the capability *granted*. Granting a capability puts nothing in a bundle.

```tsx
import { runtimeEvaluateTool } from 'agent-mcp-react/evaluate';

<AgentMcpProvider
  capabilities={{ application: true, dom: { inspect: false, interact: false }, evaluate: true }}
  builtInTools={runtimeEvaluateTool({ validator })}
  confirmation={{ resolver }}   // required in practice: without it every call is refused
  validation={{ validator }}
/>;
```

**It is never in `document.modelContext`, in any configuration, including this one.** Anything in that
registry is callable by every script on the page with none of the gates above in the path — for this
tool, that would be the whole origin, handed over silently while the capability model still looked
intact.

## The build mode is not a condition

A production build that satisfies all four **works**, deliberately.

Refusing in production looks safer and fails in the worse direction: an operator who imported the
subpath, granted the capability and wired a resolver would get a tool that silently does nothing in
the build they actually deployed. A knob that is documented and changes nothing is worse than an absent
one.

What a production build *does* change: the agent is never sent a stack trace.

## What an agent gets

```json
{ "expression": "return document.querySelectorAll('.row').length;" }
```

The body of an **async function**, so it may `await`. Return a value to receive it.

| Result | What comes back |
|---|---|
| A JSON-carriable value | `{ "value": … }`, untouched |
| `undefined` | `{ "value": null, "note": "the expression returned undefined" }` |
| A function, symbol or bigint | **Refused**, naming the kind — see below |
| A cyclic object | Refused as unserializable |
| A throw | A tool error with the message; no stack in production |

**Why a function is refused rather than returned empty.** Measured: a function and `undefined`
serialize identically to nothing. An agent that evaluated `() => doThing()` — forgetting to call it —
would otherwise receive an empty success and conclude the page returned nothing. The refusal names the
kind of value, never the value.

## What is NOT guaranteed

1. **The result is not sanitized.** It is whatever your expression produced. If your expression reads a
   token, the token comes back — the expression is the disclosure boundary, exactly as `getState` is
   for `useMcpState`. This library traverses nothing and removes nothing.
2. **There is no sandbox, deliberately.** A Worker or an iframe would stop the expression reaching the
   page, which is the entire purpose — it would advertise a capability it structurally cannot deliver.
3. **Nothing is retained between calls.** Each call constructs a fresh function. A persistent scope
   would be state held on the agent's behalf that your confirmation surface cannot see: a person
   approving the third call would be approving something whose meaning depends on the first two.
4. **There is no timeout.** An expression that never settles is cancellable, and cancellation always
   settles a call. A timeout would be a policy this library invented on your behalf.
5. **There is no argument channel.** The expression is a closed string; a parameters object would be a
   second way into the same evaluation with no separate protection.

## When your page forbids it

A `script-src` policy without `unsafe-eval` makes function construction throw, and the tool reports
`MCP_RUNTIME_EVALUATE_FORBIDDEN` rather than an execution failure.

**That is a correct configuration, not a malfunction** — and arguably the right answer. It is kept
distinct from `MCP_RUNTIME_EVALUATE_SYNTAX` so an operator is not sent looking for a typo in an
expression that is fine.
