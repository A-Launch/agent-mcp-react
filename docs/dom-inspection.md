# Reading and driving the page — Level 2 (experimental)

> **This is a fallback, and reaching for it is a signal.** A DOM tool for a flow that already has an
> application tool is a regression, not a convenience — that is a rule of the design, not a preference
> (see [Three levels of control](design.md#three-levels-of-control)). If you find yourself
> snapshotting the page to do something your own code could expose as a `useMcpTool`, the answer is to
> instrument that flow — not to give the agent more DOM.

Level 1 lets an agent call the actions your application already has. It says nothing about what is on
screen. An application that instrumented three flows and not the fourth gives an agent no way to even
**see** the fourth: it cannot tell you a dialog is open, that a save button is disabled, or that the
page is showing an error.

`dom.snapshot` and `dom.get_text` close that gap. `dom.click`, `dom.fill`, `dom.select`, `dom.press`
and `dom.scroll` act on what those found — behind the **other half** of the same capability, because
reading a page and acting on it are different powers. The read-only profile is
`inspect: true, interact: false`, and it is the one to reach for first.

## Enabling it

Two independent conditions, and **neither implies the other**.

```tsx
import { AgentMcpProvider } from 'agent-mcp-react';
import { domInspectTools, domInteractTools } from 'agent-mcp-react/dom';
import { createAjvValidator } from 'agent-mcp-react/validation';

const validator = createAjvValidator();
// Built once at module scope: it compiles a schema, and doing that per render recompiles a constant.
// Two factories, so an application can supply the read half alone — which is the recommended shape.
const domTools = domInspectTools({ validator });
// …or both, when the agent must be able to act:
// const domTools = [...domInspectTools({ validator }), ...domInteractTools({ validator })];

<AgentMcpProvider
  capabilities={{
    application: true,
    dom: { inspect: true, interact: false },
    evaluate: false,
  }}
  builtInTools={domTools}
  validation={{ validator }}
  /* … */
/>;
```

| Imported | `dom.inspect` granted | Result |
|---|---|---|
| yes | yes | the agent can read the page |
| yes | no | `MCP_TOOL_CAPABILITY_DENIED` at invocation, and absent from `tools/list` |
| no | yes | `MCP_TOOL_NOT_FOUND` — **a granted capability is not a tool** |
| no | no | your build contains none of this code |

The import is what puts the code in your bundle; the grant is what admits the call. Measured: a build
of this repository's demonstrator without the import is **7,691 bytes smaller** and contains no trace
of the snapshot code.

**These tools are never registered.** They do not enter `document.modelContext` in any configuration,
including the one that grants the capability — anything in that registry is callable by every script on
your page with none of this library's gates in the path.

## What an agent gets

> **`createAjvValidator` requires CSP `unsafe-eval`.** Ajv compiles schemas into JavaScript with
> `new Function`, so under a `script-src` that omits `unsafe-eval` it throws while compiling — and a
> tool whose declared schema has no working validator is **not registered at all**, so a strict-CSP
> page exposes nothing. Supply your own `SchemaValidator` instead; see
> [the defect record](issues/validator-requires-unsafe-eval.md) and the worked example in
> `examples/customer-dashboard/src/csp-safe-validator.ts`.

```json
{
  "url": "https://app.example.com/customers",
  "title": "Customers — Acme",
  "elements": [
    { "ref": "e12", "role": "textbox", "name": "Search", "value": "" },
    { "ref": "e13", "role": "button", "name": "Export", "disabled": true },
    { "ref": "e14", "role": "textbox", "name": "Password" },
    { "ref": "e15", "role": "status", "name": "3 customers match" }
  ],
  "truncated": 312
}
```

`dom.snapshot` takes **no arguments** — no root, no selector, no limit. `dom.get_text` takes exactly
one, a `ref` from the most recent snapshot.

`e14` is a password field. **It is present and its value is not**: an agent must be able to see that a
password is being asked for, and must never receive one.

`truncated` appears only when elements were omitted, and is a count rather than a flag — an agent told
"there is more" can do nothing with it.

## References go stale, and that is the feature

A reference is refused when any of these is true at the moment it is used:

1. a newer snapshot replaced the table;
2. its element left the document;
3. the page navigated — including a client-side route change;
4. the element no longer matches the role and name the snapshot reported for it;
5. you called `invalidateDomRefs()`.

The first three are the staleness conditions the design of the DOM fallback names. **The fourth is this
library's addition and it is the important one.** React
reuses a row's DOM node across a data change: filter a table and the same `<button>` that said "Acme"
now says "Zenith" — the same object, still in the document, at an unchanged URL. Measured in this
repository. A design that trusted node identity would hand that element back and let an agent act on a
record nobody chose, while the tool reported success.

Two codes, and an agent acts on them differently:

| Code | Meaning | The agent should |
|---|---|---|
| `MCP_DOM_REF_STALE` | issued, and no longer usable | **take another snapshot** |
| `MCP_DOM_REF_NOT_FOUND` | this page never issued that token | **not** re-snapshot — the token is wrong |

### When to call `invalidateDomRefs()`

```ts
import { invalidateDomRefs } from 'agent-mcp-react/dom';
```

Call it when the page changed in a way a snapshot cannot see: the URL is the same, the nodes are still
connected, no new snapshot has been taken, and a row now shows a different record because state
changed. **Only your application knows that**, which is why this exists.

Forgetting to call it is not catastrophic — condition 4 above catches the common case — but it is not
free either, and the next section says exactly where the gap is.

## What this does NOT guarantee

Read this list. Each item is a belief you could otherwise reasonably form.

1. **The accessible name is an approximation, not the accname algorithm.** It reads
   `aria-labelledby`, `aria-label`, an associated `<label>`, `alt`, `title`, then the element's own
   text. A name assembled by accname's recursive rules, or from CSS pseudo-content, is not reproduced.
2. **An element with no name is reported with no name.** Nothing is invented from surrounding text. An
   unnamed control is a real defect on a real page, and an agent given a plausible name for one will
   report success against something a screen-reader user cannot find.
3. **Visibility means the declarative kinds only.** `display:none` at any ancestor,
   `visibility:hidden`, `hidden`, `aria-hidden`, `inert`. An element that is zero-sized, clipped, or
   covered by an overlay **is in the snapshot** — no layout is read at all. Discovering that something
   cannot actually be reached is what the write tools do at the point of use (see
[An agent cannot do what a person cannot](#an-agent-cannot-do-what-a-person-cannot)).
4. **The staleness witness cannot tell identical elements apart.** Two elements with the same role and
   the same accessible name — a column of "Open" buttons — look the same to it. A recycled node that
   kept both resolves. This is the gap `invalidateDomRefs()` exists for, and the reason Level 2 is
   experimental.
5. **A snapshot is a moment, not a subscription.** Nothing tells the agent the page changed, and there
   is no `dom.*` change notification — that would be a standing observation of the document, which this
   library never runs (see [Cost](#cost)).
6. **Neither tool declares an output schema yet.** The shape above is what ships and is not yet a
   validated contract.

## What never reaches the agent

- A password field's value, from either tool, in every configuration. Unconditional, with no opt-out —
  not a capability, not a build flag, not an observability setting.
- A hidden input's value. Hidden inputs are not in the snapshot at all.
- **Any attribute.** Not filtered — *never traversed*. Your `data-session`, your `id`, your `class` and
  your `data-user-email` are not read, so nothing leaks because a deny-list missed it.
- Any markup. No tag names, no `innerHTML`, no page source in any field.
- Anything read from the page inside a failure message. A refusal names the token and the condition.

## Cost

Nothing happens until `dom.snapshot` is called. There is no `MutationObserver`, no navigation
listener, no timer, and no patched platform API — every staleness condition is re-derived by
comparison when a reference is used. A snapshot is one pass over the document, capped at 500 elements.


## Acting on the page

| Tool | Arguments |
|---|---|
| `dom.click` | `{ ref }` |
| `dom.fill` | `{ ref, value }` |
| `dom.select` | `{ ref, option }` — the label the snapshot reported, not the `value` attribute |
| `dom.press` | `{ ref, key }` — `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, or an arrow |
| `dom.scroll` | `{ ref, direction }` — `up`, `down`, `top`, `bottom` |

Each returns what it did, and **none returns a snapshot** — that would double every payload, mint a
reference table you did not ask for, and retire every reference the agent was holding.

Each resolves only **after your application has committed the change**, so a success means what an
agent will take it to mean.

### A fill reaches your handlers, and that took work

`dom.fill` writes through the element's native property setter and dispatches the events typing
produces. That is not ceremony. Measured on a controlled React input: assigning `element.value`
directly leaves the DOM showing the value and **React's state empty** — React tracks the last value it
wrote on the node, assignment updates that tracker as a side effect, so React concludes nothing changed
and never calls your `onChange`. It then overwrites the DOM on its next render. The value appears, and
vanishes.

### An agent cannot do what a person cannot

A write tool refuses with `MCP_DOM_NOT_INTERACTABLE` when its target is not visible, is `disabled`,
declares `aria-disabled="true"`, sits inside an `inert` region, or has `pointer-events: none` — and
`dom.fill` also refuses a read-only field.

This library decides that **before dispatching**, because the platform is unreliable in both
directions and both were measured, in Chrome as well as jsdom:

- a programmatic click on a `disabled` element is **swallowed silently**, so without the check the tool
  reports success for a call that did nothing;
- a programmatic click on an `inert` element, or one under `pointer-events: none`, **goes through**,
  because a synthetic click skips hit-testing.

**What is not covered:** an element that is zero-sized, clipped, or covered by an overlay. Deciding
that needs layout, and layout cannot be read in the environment most of this library's tests run in —
a check for it would report success while checking nothing.

### No write tool asks a person

There is no `confirmation` on any of these, deliberately. Confirming every click of a multi-step flow
is not a safety boundary; it is a rate limit that trains people to click through. **The capability is
the decision point**: withhold `dom.interact` and every one of these is refused.
