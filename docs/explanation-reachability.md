# What an agent can reach, and what a capability actually protects

Three claims that look similar and are not: a tool being absent from a listing, a tool being refused,
and a connection being authenticated. Getting them mixed up is how a capability model ends up
protecting nothing.

## The problem

"The agent can't see it" feels like security. It is the reasoning behind a very common design: hide the
dangerous tools from `tools/list`, show the safe ones, done.

It fails the moment anything calls a name it was not shown. An agent that remembers a name from an
earlier turn. A model that guesses `invoice.delete` because `invoice.mark_paid` exists. A replayed
transcript. A script on the page. None of these is exotic, and every one of them walks straight past a
listing.

So: **absence from `tools/list` is not access control.** The listing is the agent's *picture* of the
page. The control is what happens when the call arrives.

## The approach: refuse at invocation

Every gate in this library decides at the call, not at the listing.

- A tool the application declared `available: false` is **excluded from the listing and refused when
  called** (`MCP_TOOL_DISABLED`). Two separate things, and only the second is the control.
- A capability that is withheld refuses at the call (`MCP_TOOL_CAPABILITY_DENIED`), naming the
  capability an operator would have to grant.
- A removed component's tool is not there at all (`MCP_TOOL_NOT_FOUND`).

The negative cases in this repository's test suite assert the **refusal**, not the absence, for exactly
this reason. A tool that is hidden and still callable is the leak with a lucky ending.

### A tool that is gone is not a tool that says no

There is a design choice underneath that last row worth making explicit, because it shapes how you name
tools.

When a component unmounts, its tools are withdrawn. A call naming one gets `MCP_TOOL_NOT_FOUND` — *the
tool is not there*. Compare that with a fixed tool that takes an identifier:

```
panel.map-4.set_focus  { focus: 'emea' }     →  MCP_TOOL_NOT_FOUND      (panel gone)
board.set_focus        { panel: 'map-4' }    →  MCP_TOOL_ARGUMENTS_…    (bad argument)
```

Both refuse. The first is a stronger claim: the capability itself ceased to exist, and there is no
handler anywhere that could have run. The second says a particular argument failed a check, which is
only as true as that check. Putting the identifier in the **name** rather than in the arguments makes
the lifetime of a capability a fact about the tool table instead of a rule inside a handler.

## The three levels, and what each one costs you

A capability is per **level**, and the levels differ in blast radius by orders of magnitude.

| Level | Grant | What an agent gains | What it costs if wrong |
|---|---|---|---|
| 1 | `application: true` | The tools you declared, in your vocabulary, with your schemas | Exactly the actions you instrumented. Bounded by design. |
| 2 | `dom.inspect` | Reading the page: roles, accessible names, text | Anything a person can *see*. Passwords are structurally unreachable; everything else visible is fair game. |
| 2 | `dom.interact` | Clicking, filling, selecting, pressing | Anything a person can *do*, including flows you never instrumented and never thought about. |
| 3 | `evaluate: true` | Arbitrary JavaScript in your page's origin | The DOM, application globals, storage, same-origin requests, and any non-HttpOnly credential the page can reach. |

Level 3 is the one to be blunt about: it is equivalent to arbitrary code execution as your user.
It is disabled by default, needs four independent conditions to fire (the application imports the
subpath, an operator grants it, a resolver is wired, and a person approves the specific call), and it
is **never enabled to unblock a task**. That is the one change whose blast radius is the whole page.

**One level confers nothing on another.** `application: true` does not make a DOM tool callable.
`dom.inspect` does not imply `dom.interact` — reading a page and acting on it are different
authorities, which is why the DOM capability is a pair and not a boolean.

The separation is structural, not a naming convention: Levels 2 and 3 are a closed build-time set the
library ships and **never registers**. They are absent from the document's shared registry in every
configuration, including one that granted them, because anything in that registry is callable by any
script on the page without passing a single gate.

## A capability governs the bridge, not your page

The most misread property of the whole model, so here it is on its own:

> Your Level 1 tools live in `document.modelContext`, the page's **shared** tool registry. Every script
> on the page can enumerate and invoke them. Withholding a capability refuses *this library's bridge to
> the agent*. It unregisters nothing.

Withhold `application` entirely and an agent's calls are refused at the capability step — while the
same tools keep running for the page's own scripts. That is not a leak; it is what "a second control
interface onto one application" means. Your tools are part of your page.

Two things follow for you:

- **Do not move a domain rule out of a handler and into `available`.** You would stop enforcing it for
  every caller that is not this agent. Rules belong where they were: in the code that performs the
  action.
- **Do not put anything in the shared registry you would not let a page script call.** Which is exactly
  why Levels 2 and 3 are not in it, in any configuration.

Both call routes report on one surface. A page-script call reports its ungated steps as `notRun` —
never `passed`, never omitted — which is the shared-registry consequence made observable instead of
documented. See [Observing tool calls](observing-tool-calls.md).

## Why identity is not authorization

The connection is authenticated at the socket upgrade: the gateway redeems a single-use ticket before
the handshake completes. That establishes **who is connected**, and nothing else.

Two places where the distinction is load-bearing:

**The gate chain's first step is `authenticate`, and it is marked `elsewhere`.** It happens at the
upgrade, not in the runtime. It decides whether the connection may exist — never what it may call. That
is steps 3 through 6.

**A tab id is metadata, never a credential.** The library mints one identity per page instance, lazily
on first read, held under a well-known symbol so two bundled copies agree. `useMcpTabId()` publishes
it, and your application appends it to the URL it supplies. The gateway reads it **strictly after
redeeming the ticket**, so it cannot enter the admission decision. It is routing — which of several
open tabs this request is for — and nothing more.

Never write one by hand. Nothing makes a hand-written id unique, two copies of a page then claim one
identity, and an agent's request is answered by whichever connected first: a wrong answer that looks
entirely normal. It happened in this repository's own demonstrator.

## Trade-offs

**Refusing at invocation means the agent can discover names it may not call.** A refusal tells it the
tool exists. That is the correct trade: the alternative — pretending a tool does not exist while a call
to it succeeds — is the failure mode this whole page is about. If a name itself is sensitive, do not
declare the tool.

**Structural separation costs a build-time set.** Levels 2 and 3 cannot be extended by an application,
which means a genuinely new kind of DOM tool is a library change rather than an application one. The
alternative is a registry an application can add privileged tools to, which is the thing that must not
exist.

**A capability is per level, not per tool.** No combination of `application`, `dom` and `evaluate`
expresses "may read a customer but not write one" — that distinction is per-tool and belongs to your
application, through `available` and `confirmation`. A `read-only` capability member is deliberately
absent for exactly this reason.

## Related

- [Capabilities and the gate chain](reference-capabilities.md) — the shape, the order, the redaction rules
- [The error vocabulary](reference-error-vocabulary.md) — every refusal code
- [DOM inspection](dom-inspection.md) — what Level 2 actually exposes
- [JavaScript evaluation](javascript-evaluation.md) — the four conditions on Level 3
- [Connecting to an agent](connecting-to-an-agent.md) — tickets, tab identity, reconnection
