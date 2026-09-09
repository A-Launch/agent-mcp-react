# `@agent-mcp/react` documentation

Organized by the [Diataxis](https://diataxis.fr/) quadrants — **tutorial** (learning), **how-to** (a
specific task), **reference** (the facts), **explanation** (the why). Pick your audience.

Documentation here describes only **current** behavior. Dated material — release notes, defect
records, measurements — lives under [Records](#records) and says on its first line that it describes
a moment. The condensed design is [design.md](design.md); the pages below link into it.

## Start here

- **[Tutorial: your first agent-callable tool](tutorial-first-tool.md)** — from `npm install` to
  calling a tool from your browser console and watching the page change, with no server, no
  credentials and no agent runtime. Then the same tool, driven by a real agent.
- **[API reference](reference-api.md)** — every public export by subpath: 57 values and 57 types
  across nine entry points, extracted from the shipped types and verified to import.
- **[Consuming it without publishing](consuming-without-publishing.md)** — four routes, and three of
  them fail in ways that still exit `0`. The tarball is the one to use; a local directory dependency
  cannot work, and the reason is `publishConfig`.

## Instrumenting an application

You have a React application and you want an agent to be able to drive it.

- **Tutorial** — Expose your first tool and call it from an agent
- **How-to** — [Expose state for inspection](exposing-state.md) ·
  [Bind a Redux, Zustand or router action](store-adapters.md) ·
  [Keep filters in the URL](store-adapters.md) ·
  [Register a tool outside React](tools-outside-react.md) ·
  Handle cancellation · Wait for the application to settle before returning
- **Reference** — [Declaring a tool](declaring-a-tool.md) — the contract, and **who on the page can
  call a tool you declare** and **[declaring when a tool may be reached](declaring-a-tool.md#declaring-when-a-tool-may-be-reached)**
  · [Exposing state](exposing-state.md) — `useMcpState`, **why the schema is a contract and not a
  redactor**, and why a state change notifies nobody
  · [Declaring tools outside React](tools-outside-react.md) — `registerMcpTool`, why it is **not** a
  runtime, and why a shell-owned tool survives a provider remount
  · [Store adapters](store-adapters.md) — Redux, Zustand and router bindings, **and where the
  no-generic-mutation guarantee is a type and where it is only a schema**
  · [The error vocabulary](reference-error-vocabulary.md) — every code, what raises it, who sees it,
  and **why a thrown message is replaced while a returned one is not**
  · `AgentMcpProvider` props · Tool naming conventions and the reserved prefixes
- **Worked example** — [The composable board](composable-board.md) — a demonstrator whose screen
  LAYOUT is the shared surface: a person describes a dashboard and panels appear, and the same panels
  can be built by hand. Read it for the closed-catalog boundary, per-panel tool registration, and
  **why a refusal has to be RETURNED rather than thrown**.
- **Explanation** — [Why this is a second control interface and not browser automation](explanation-second-control-interface.md)
  — the three failure modes of driving a UI, and why the browser is the MCP server
  · [Why a tool appears after the commit, and a call waits for one](explanation-commit-and-registration.md)
  — registration in an effect, `afterRender`, and **the false success a real transport gives cover to**

## Deciding what an agent may reach

You are choosing capabilities for a deployment, or reviewing what an agent can do.

- **How-to** — Choose a capability profile · [Gate a tool behind confirmation, or close it while your
  application is not offering it](declaring-a-tool.md#declaring-when-a-tool-may-be-reached) ·
  [Enable the DOM fallback for one uninstrumented flow](dom-inspection.md) · Audit what is currently
  reachable with `useMcpCapabilities`
- **Reference** — [Observing tool calls](observing-tool-calls.md) — the five callbacks, **which gate
  step refused a call**, why a page-script call reports its ungated steps as `notRun`, what events do
  and do not carry, and the in-page inspector
- **The thing to get right** — a capability and a per-tool permission gate **this library's bridge to
  the agent, not your page**. Your tools stay in the shared document registry and stay callable by any
  script in it. Keep domain rules in your handlers.
- **Reference** — [Reading and driving the page](dom-inspection.md) — Level 2, **the two conditions
  that are both required**, why a reference goes stale, and the six things it does **not** guarantee
  · [Running JavaScript in the page](javascript-evaluation.md) — Level 3, **the four conditions**,
  why the build mode is deliberately not one of them, and what evaluation actually grants
  · [Capabilities and the gate chain](reference-capabilities.md) — the shape, the seven steps in
  order, per-tool permissions, why `risk` does not ship, and **what the library redacts and what only
  your `getState` can**
  · [The error vocabulary](reference-error-vocabulary.md) — what each code means
- **Explanation** — [What an agent can reach, and what a capability actually protects](explanation-reachability.md)
  — the three levels and their blast radius, why absence from `tools/list` is not access control, why
  a capability governs the bridge and not your page, and why identity is not authorization

## Connecting to an agent runtime

You are running the gateway the browser dials.
[connecting-to-an-agent.md](connecting-to-an-agent.md)

- **How-to** — Mint a ticket from your backend · Give each page instance an identity · Reject an
  unauthenticated socket · Route among multiple tabs
- **Reference** — What a refused page is told, and what it cannot know · Tab metadata
- **Explanation** — [Why the browser is the MCP server and dials outbound](explanation-second-control-interface.md#the-browser-is-the-mcp-server-and-it-dials-out)
  · [Why identity is not authorization](explanation-reachability.md#why-identity-is-not-authorization)
  · Why a refused handshake and a dead port share one cause
- **Reference** — [The WebSocket framing contract](websocket-framing.md) — one message per frame, no
  envelope, why `serializeMessage` is not used, and what a gateway must do
  · [The connection state machine](connection-lifecycle.md) — the five states, **why `connecting` and
  `reconnecting` are separate**, why only an established channel is recovered, and the backoff schedule
  with its jitter

## Where it runs, and what it costs

- **[Browser support](browser-support.md)** — the required APIs, the three engines actually tested,
  and — stated in the same place — the twelve real-browser runs that would close the documented
  matrix. It is a support **target**, not verified support, and the page says so.
- **[Performance budgets, measured](records/performance-budgets.md)** — every budget number, with the
  command that reproduces it and a list of what is deliberately not measured. Run by a person: CI
  bundle-size enforcement is deferred by decision, and the page says what stands in for it.

## Known limitations

- **[The bundled validator requires CSP `unsafe-eval`](issues/validator-requires-unsafe-eval.md)** — a
  strict-CSP application must supply its own `SchemaValidator`, or it exposes no tools at all.

## What is verified against adopted packages

- **[The conformance layer](conformance.md)** — the rule that a documented claim is not a verified
  one, the behaviours pinned against the real registry and the real MCP SDK, the one row that stays
  open, and what none of it evidences.

  It also carries the **audit against the WebMCP draft**, pinned to an immutable commit: which of this
  library's beliefs about the standard survived reading it, six places where the draft and the
  implementations disagree, and the measurements from a real native registry — reachable on Chromium
  under a flag, which this repository spent a long stretch believing did not exist.

  And **what of the standard this library does not implement**, member by member, each sorted into a
  non-goal, a role mismatch, a deliberate substitution, or genuinely open. Exactly one falls in the
  last bucket: Declarative WebMCP.

## Internals

How the library itself works, for contributors.

- The conventions and the principles behind them: [CONTRIBUTING.md](../CONTRIBUTING.md) — module
  boundaries, the testing discipline, the forbidden patterns, the health gate, the scope limits
- The design, condensed: [design.md](design.md) — every claim a page or a source comment cites,
  under a stable heading
- Running it locally: [local-development.md](local-development.md) — the port block, the mock agent
  runtime, driving a call by hand, the test layers
- When it fails quietly: [troubleshooting.md](troubleshooting.md) — the class of bug this system
  produces, symptoms by layer, the diagnostic order
- What this library depends on and why: [adopted-dependencies.md](adopted-dependencies.md) —
  including what has **not** been verified

## Records

Dated material, kept apart from the docs above because it describes a moment rather than current
behavior; each file says so at its top.

- `issues/` — the defect register. One file per known defect: what it is, the evidence, and whether
  it is open, deferred by decision, or fixed.
- `records/` — measurements taken on a date, with the command that reproduces each.
- `releases/` — the notes for each released version, kept verbatim.

## Conventions

Module boundaries, testing discipline, forbidden patterns and the local port table live in
[CONTRIBUTING.md](../CONTRIBUTING.md). An entry above with no link yet names a page that is owed,
not one that exists.
