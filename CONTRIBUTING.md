# Contributing to `@agent-mcp/react`

This file owns every convention in this repository. Where another document repeats one of them, this
is the version that binds, and the repetition is a defect to report.

## 1. What you are contributing to

A browser-side React library that exposes a running React application as an MCP server, so an agent
can drive the application through typed tools instead of clicking its UI. **MCP is a second control
interface onto one application** — not browser automation and not a second store. The human UI and
the agent act through the same application state transitions; the library owns the control plane and
the application keeps owning its state. Everything below follows from that one fact, and the design
that follows from it is written out in [docs/design.md](docs/design.md).

## 2. Setup

```bash
git clone https://github.com/A-Launch/agent-mcp-react.git
cd agent-mcp-react
pnpm install
scripts/setup-git-hooks.sh     # points core.hooksPath at .githooks/
```

- **Node** — the version in `.nvmrc`. `nvm use` reads it.
- **pnpm** — the version in `package.json#packageManager`. `corepack enable` installs exactly that
  one, and CI uses the same mechanism.

The library is the repository root package; `examples/*` and `tools/*` are workspace packages. Never
`cd` into one — use `pnpm -C <package> <script>`. Running the stack locally, the port block, the mock
agent and how to drive a tool call by hand are in
[docs/local-development.md](docs/local-development.md).

## 3. The gate

```bash
pnpm gate
```

What it runs, and in which order, is in `package.json#scripts` and nowhere else. It is required to
be green before any pull request that touches `src/`, `examples/` or `tools/`, and branch protection
on `develop` and `main` requires the same check from everyone, maintainer included.

Three more runs are manual, because they need browser binaries or dev servers, and a gate with setup
is a gate that gets skipped:

| Command | What it does | Obliged by a change to |
|---|---|---|
| `pnpm test:e2e` | Playwright, three engines, real browser, real socket | the transport, the registry boundary (`src/webmcp/`), the DOM module, build configuration |
| `pnpm test:e2e:native` | Chromium with its native tool registry enabled, against the same page | the registry boundary |
| `pnpm verify:consumer:runs` | serves an external project's production bundle and asserts it mounts | build configuration, the exports map, a public type |

Say in the pull request which of these you ran. A run that did not happen is reported as not run,
never as passed.

## 4. Where code goes

One concern per directory. A new top-level directory documents its single responsibility in
`CLAUDE.md` and in this table before its code lands.

| Directory | Owns | Does not |
|---|---|---|
| `src/webmcp/` | The browser tool-registry standard: locate the registry, initialize the portability shim, hold the one-provider-per-document claim, register, withdraw, enumerate, translate descriptors and failures into this project's vocabulary | React, sockets, policy. It reports what the registry did and decides nothing |
| `src/runtime/` | The browser MCP runtime on the SDK's low-level server: lifecycle, the ownership record, the derived tool list, the capability gate, the error vocabulary | React, sockets. Testable without a DOM |
| `src/transport/` | `BrowserWebSocketTransport` and the reconnection schedule. One JSON-RPC message per text frame, no envelope. The deadline that guarantees an attempt settles, the scrubbing that keeps a credential out of everything it reports. Single-use: one instance, one attempt | Driving reconnection — the provider does, because what re-runs per attempt is `runtime.connect()` |
| `src/react/` | Provider, hooks, context. Binds component lifecycle to registry lifecycle | Policy, protocol |
| `src/security/` | Capability resolution, per-tool policy, redaction rules. Decides | I/O of any kind. Reads no store, touches no DOM, imports no React |
| `src/dom/` | Level 2: a semantic snapshot of roles and accessible names, the reference table with a document-global epoch, `dom.get_text`, unconditional redaction, click/fill/select/press/scroll | Checking its own capability — the gate lives in the runtime. Entering the shared document registry, ever |
| `src/evaluate/` | Level 3: `runtime.evaluate`, behind four conditions none of which implies another | A sandbox, which would prevent the expression reaching the page. A build-mode condition, which would give a fully granted operator a tool that silently does nothing |
| `src/actions/` | Declaring a tool from code that is not a component: a module-scope queue of declarations the provider adopts on mount, and the handle with `update`/`remove` | Being a runtime. A runtime an application constructs is a second MCP server on one page |
| `src/adapters/` | Optional store bindings — Redux, Zustand, router — each a thin, deletable translation from one bound action to one tool handler | Accepting a store, or exposing a generic mutation interface |
| `src/devtools/` | The in-page inspector. Observational only; constructed with a host element and nothing else, and nothing it exposes returns something callable | React, the runtime, the gateway |
| `src/page-identity.ts` | One page instance's identity, minted lazily under a `Symbol.for` key so two bundled copies agree. Metadata, never a credential | Deciding anything |
| `src/build-mode.ts` | Which build this is | — |
| `examples/customer-dashboard/` | The demonstrator the acceptance scenario runs against, consuming the package exactly as an embedder does | Deep imports into `src/` |
| `examples/composable-board/` | A second demonstrator whose screen layout an agent composes | Deep imports into `src/` |
| `examples/agent-chat/` | The agent's face: an HTTP client of the agent runtime | Importing this library, mounting a provider, opening a socket |
| `tools/mock-agent/` | Local MCP client, WebSocket gateway, dev ticket minter and chat agent | Being a production component |
| `tests/unit/` | Registry, validation, policy, serialization, reconnection. No renderer, with one exception: `tests/unit/react/` holds the cases about React that need no DOM, including the server-rendering one. A case may declare a DOM with a `// @vitest-environment jsdom` docblock when the unit under test is the document boundary | — |
| `tests/react/` | React Testing Library: mount, rerender, unmount, StrictMode, route change | — |
| `tests/transport/` | A real local WebSocket server: framing, closure, reconnect, auth, concurrency | Mocking the socket |
| `tests/integration/` | The example app driven by the mock agent through the whole stack. The only suite that may import `examples/*`; a seam case enforces that | — |
| `tests/e2e/` | Playwright. What only a browser can catch | Being part of the gate |
| `tests/conformance/` | Cases pinning each behaviour this library relies on in an adopted package, against the real package | — |
| `docs/` | Current behaviour only. Index: [docs/README.md](docs/README.md) | History |
| `.github/` | The CI workflow, issue and pull-request templates | — |

### Import rules

These are boundaries, not style. Each one is what makes a suite possible or a revision local.

- **React is imported in `src/react/` and nowhere else.** The registry, runtime, transport, security
  and DOM modules are then testable with no renderer at all, and a future non-React binding is a
  sibling directory rather than a rewrite.
- **`WebSocket` appears only in `src/transport/`.** The transport suite is the one place a real
  socket is exercised; a socket reference elsewhere is a path that suite does not cover.
- **`document.modelContext` appears only in `src/webmcp/`.** The standard is a moving draft whose
  host object has already migrated once; a revision must be absorbable in one directory.
- **`src/security/` decides and does no I/O.** A decision module that can read a store or a DOM node
  is one whose verdict depends on when you call it.
- **`src/react/` does not import `src/security/`.** A capability check reachable from the renderer is
  a check a module can be imported past. What the provider needs travels through `src/runtime/`,
  which holds the gate.
- **`src/dom/` never checks its own capability.** The gate is in the runtime's invocation path, which
  every call already takes.
- **`src/adapters/*` are leaves.** Nothing imports an adapter; each is deletable.
- **`src/devtools/` reads everything and invokes nothing**, enforced by a seam case on its imports.
- **`examples/*` and `tools/*` consume the package's public entry points only.** A deep import into
  `src/` is a capability an embedder does not have.
- **No React internals anywhere**: `__reactFiber`, `__reactInternalInstance`,
  `ReactCurrentDispatcher`, DevTools private APIs. Integration is through application-provided hooks,
  actions and stores.

Direction of dependency: `react/ → runtime/ → security/`; `runtime/ → webmcp/`; `transport/ →
runtime/` as a transport, not a caller; `adapters/ → actions/`; `dom/ → runtime/` as a build-time
built-in; `devtools/` reads and calls nothing. `src/webmcp/` imports nothing of this library's own.

### Where a new module or export goes

Ask which single thing it owns, then place it by that answer, never by the technology it uses:

- Decides whether something is allowed → `src/security/`, plus a gate call in `src/runtime/`.
- Talks to a store → `src/adapters/`, as a leaf.
- Touches the DOM → `src/dom/`, behind the capability gate, and only if no application tool could do
  the job. A DOM tool for an instrumented flow is a regression.
- Needs React → `src/react/`. If it also needs to be callable without React, it is two modules.
- Observes without acting → `src/devtools/`.

If it fits two, it is two modules. A public export is a subpath in `package.json#exports` only when an
embedder chooses whether to include it (`./dom`, `./redux`, `./zustand`, `./router`, `./evaluate`,
`./devtools`, `./actions`, `./validation`). The registry boundary is deliberately not exported: nobody
chooses whether to talk to the browser tool registry, and exporting it would create importers a
revision of the standard could break. A new export changes what an external project sees, so it
obliges `pnpm verify:package`, `pnpm verify:consumer` and a note in the pull request.

## 5. The five invariants that break silently

Every one of these fails *quietly* — the call succeeds, the agent proceeds, and the application is
just wrong. None is caught by a type. Each needs a negative case, and keeping it that way is part of
any change near it.

1. **A tool exists only by registration, and only after commit.** No discovery of application
   functions, no export scanning, no name convention that makes something callable. Registration
   happens in an effect; an aborted or suspended render exposes nothing. The document registry is
   shared with every script on the page, so presence in it is not registration by the application:
   bridge only what this library registered, and treat a divergence between the registry and the
   ownership record as an alarm, never something to filter away. *Needs a negative case.*
2. **The handler reads current state, never the render that registered it.** The registered
   callback is stable and reads the latest handler through a ref. Get this wrong and every call
   silently operates on a previous render's closure — the agent sets a filter, the tool returns
   success, and the value it applied was the one from three renders ago. *Needs a negative case.*
3. **Validation and policy run before the handler, in the runtime.** Not inside the handler, where
   every application re-implements them and one gets it wrong. A disabled or removed tool is refused
   at invocation — absence from `tools/list` is not the control. *Needs a negative case.*
4. **A call resolves only after the application accepted the mutation.** Returning after dispatch,
   before the store reflects it, is a false success. `context.afterRender()` reports what it actually
   waited for and never claims arbitrary effects completed because one frame elapsed. *Needs a
   negative case — and an assertion about agreement, because a real transport hides this one.*
5. **Capability gates are structural, and redaction is unconditional.** DOM and evaluate are
   unreachable when disabled, not merely unadvertised — and they are never placed in the shared
   document registry at all, in any configuration, because anything in it is callable by any page
   script without passing a gate. Password values are redacted, hidden inputs are not exposed, and
   tokens are never included automatically — in a snapshot, a state read or an error. *Needs a
   negative case asserting the refusal, not merely the absence.*

## 6. Comments

Every file, class, hook, public function and non-obvious decision has a comment describing what it
does in functional terms. An outdated comment is worse than no comment.

- A real description of current behaviour and boundary — what it owns, and what it does NOT.
- Written for a reader who has never seen the code.
- Updated whenever the code changes.
- Never a reference to a pull request, an issue, a ticket or a task. Never a restatement of the
  identifier. Where a comment needs to point somewhere, it points at [docs/design.md](docs/design.md)
  or the owning page under `docs/`, by repository path.
- **Capability gates, policy checks, redaction points and transport boundaries additionally name the
  invariant they enforce** — that is the comment that stops a future refactor from quietly removing
  a check.

```ts
// Bad — restates the name
// registerTool registers a tool.

// Good — describes behaviour, boundary and the invariant
// Registers one tool into the document's tool registry and returns the controller that withdraws it.
// Invariant: the callback handed to the registry is stable for the tool's whole lifetime and reads
// the latest handler through a ref — a rerender whose descriptor is unchanged must not touch the
// registry at all, because the agent would observe a tools/list-changed storm and a window in which
// the tool does not exist. The standard has no update operation, so there is nothing to fall back on.
```

## 7. Tool design

- Tools express **user or business intent**, not implementation: `invoice.mark_paid`, not
  `redux.dispatch`. A generic mutation tool widens the reachable state space past every schema the
  application declared, so the library ships none and its adapters cannot spell one.
- Namespaced, lowercase, dot-separated, verb-last: `customers.set_filters`, `dashboard.set_period`.
  The prefixes `dom.` and `runtime.` are reserved for the built-in control tools and refused at
  declaration.
- A tool that mutates declares `permissions: { available?, confirmation? }`. Both are optional; an
  absent `available` means available. `confirmation: 'required'` where an operator would want a
  person in the loop — it resolves *before* the handler, never by undoing an effect afterwards. An
  unavailable tool is left out of the derived listing, so the agent's picture of the page matches what
  it can do, **and** it is refused at invocation, because a listing is not an access control and an
  agent may be holding an older one. A tool requiring confirmation stays listed.
- **These govern this library's bridge, not the page.** A tool marked `available: false` is still in
  the shared registry and still runs for any page script. Real authorization stays in the handler,
  where it applies to every caller.
- Structured output when an output schema exists; human-readable `content` is additional, never the
  only channel. Guidance an agent should act on is *returned* — a thrown handler message is replaced
  with a generic error outside a development build, because an exception can carry internals.
- A DOM tool for a flow that already has an application tool is a regression, not a convenience.

## 8. Testing

Vitest for every layer except end-to-end, which is Playwright. Unit tests colocate next to source
(`foo.spec.ts`) or live in `tests/unit/`.
`pnpm test` runs unit and React; transport, integration and e2e are their own scripts.

- **Import a heavy dependency at file scope, not inside a test.** An `await import()` inside an
  `it()` charges module load to the per-test timeout though it is not what the test measures.
- **React tests** assert the lifecycle claims directly: mount → tool exists; rerender → no duplicate
  and no re-registration; handler sees current state; unmount → tool gone; StrictMode → nothing
  leaked; route change → tool set changes. **Assert through what an MCP client would see**, not only
  through the library's own registry — a registry read that agrees with a broken `tools/list` is a
  test of the registry.
- **Transport tests** run against a real local WebSocket server. **Never mock the socket.** Framing,
  invalid JSON, closure, reconnect, auth rejection, concurrent calls and cancellation are the subject;
  a mocked socket is a test of the mock.
- **Capability and redaction cases** are the negative suite and the most valuable tests here. Every
  reachability invariant gets a case asserting the **refusal**, not merely the absence — **at
  invocation**, not just absence from `tools/list`. A tool that is hidden and still callable is the
  leak with a lucky ending. **Never relax one.** A failing capability case is a reachability alarm,
  and the only valid response is closing the hole.
- **Integration tests** drive the example app through the mock agent: real provider, real transport,
  real store, no stubbed runtime. **Assert the observable consequence** — the rendered UI changed —
  not only the tool's return value. **And assert agreement** between what the tool reported and what
  the screen shows: deleting every `await context.afterRender()` once left every case green, because
  a real socket's round trip gives React more than enough time to commit. A DOM assertion can see "the
  UI never updated"; it cannot see "the UI updated late", and late is the defect. A timing defect that
  a real transport gives cover to needs an assertion about agreement, never about outcome.
- **The application is built once and advanced** in the acceptance scenario, not rebuilt per case: it
  is a sequence, so failures cascade and the first red names where the narrative broke. That suite
  imports `@testing-library/react/pure`, because the standard entry point's `afterEach` cleanup would
  destroy the shared application between cases.
- **Never wrap an agent call in `act()`.** A handler awaiting `afterRender()` cannot settle inside a
  callback that defers the renderer until it returns — it deadlocks for the full timeout. Outside
  `act`, React commits on its own scheduler while the call is in flight, which is exactly what a
  browser does.
- **E2E** covers what only a browser can catch: bundling, the SSR boundary, `crypto.randomUUID`
  availability, real socket closure semantics, page-level redaction.
- **Break-it-to-prove-it.** When you add or change a capability gate, a policy branch, a redaction
  rule or a lifecycle guarantee, delete the check and confirm its case goes red before restoring it.
  A suite that stays green without the check was never testing it — and watch for the assertion that
  cannot fail, such as a `toContain('3 plotted')` that also matches `"13 plotted"`. Record the
  break-it in the pull request.

## 9. Forbidden patterns

- **Never** expose a tool the application did not explicitly register. No scanning, no convention, no
  inference from a store shape or a route table.
- **Never** register during render. Registration is an effect, after commit; an aborted render must
  expose nothing.
- **Never** touch the registry on a rerender whose descriptor is unchanged. Stable callback plus ref
  for the handler. A genuine descriptor change is one withdraw-and-register cycle — there is no
  `update()` to fall back on.
- **Never** mirror the tool registry into a second list, including the MCP SDK's high-level server
  registry. `tools/list` is derived from the registry and the ownership record, on every request.
- **Never** bridge a tool this library did not register. The document registry is shared with every
  script on the page; presence in it is not registration by the application.
- **Never** put a Level 2 or Level 3 tool into the shared document registry, in any configuration.
- **Never** express "disabled" as absence from the registry. Availability is per-tool policy, refused
  at invocation.
- **Never** replace a duplicate registration silently. Development throws and names the source;
  production rejects the later one and preserves the original.
- **Never** validate inside the handler. Schema and policy run in the runtime, before invocation.
- **Never** treat absence from `tools/list` as an access control. Refuse the call.
- **Never** let connection identity imply tool authorization, and **never** read a tab id as a
  credential.
- **Never** write a tab id by hand. Two copies of one page then claim one identity, and an agent's
  request is answered by whichever connected first — a wrong answer that looks entirely normal. The
  library mints one per page instance; an application appends that.
- **Never** enable `evaluate`, or widen a capability, to make something work. That is the one change
  whose blast radius is the whole page.
- **Never** ship a generic mutation tool — `redux.dispatch`, `react.set_state`, `zustand.set`.
- **Never** touch React internals to read or write application state.
- **Never** include a token, credential, password value or hidden input in anything the agent
  receives, and never send stack traces to the agent from a production build.
- **Never** return whole-page HTML from `dom.snapshot`, and never keep a DOM ref valid across an epoch
  change.
- **Never** resolve a tool call before the application accepted the mutation, and never assert that
  effects completed because a frame elapsed.
- **Never** obtain a connection credential before a backoff wait. Both orderings satisfy "a fresh
  credential per attempt" and they behave identically until the schedule's maximum, where the
  interval meets the recommended credential lifetime — and expired, spent and "the gateway is down"
  reach a page as one cause.
- **Never** add a `setTimeout`, extra `requestAnimationFrame` or widened `waitFor` to make a flaky
  test pass. Establish the synchronization the mechanism actually needs.
- **Never** hardcode a member of a closed literal set: error codes, risk levels, connection states,
  capability names, control levels, reserved prefixes. One exported `as const` dictionary, type
  derived from it, membership checks derived from it. Validate at every boundary it crosses; never
  `as`-cast a received string onto a type that does not admit it.
- **Never** work around a bug: fix the cause. No retry, sleep or tolerance to mask a race, no
  weakened assertion, no fallback branch. Never disable or delete a failing test to go green.
  Establish the cause from the code — read it, reproduce it, instrument it, inspect the real socket
  traffic or the real store — and if the cause is not established, say so with the evidence rather
  than guessing.
- **Never** commit `.env` or real keys or tickets. `.env.example` holds key names only.
- **Never** use `git add -A` or `git add .` — stage files by name.
- **Never** skip pre-commit hooks with `--no-verify`.

## 10. Principles

### What is not up for discussion

- **One concern per directory.** No catch-alls; a new top-level directory is documented before its
  code lands.
- **The application owns its state.** The library holds, caches, mirrors or reconciles no copy of it;
  deleting the runtime loses nothing but the agent's reach.
- **Registration is the only exposure.** No discovery, no convention; registration in an effect,
  after commit; presence in the shared registry is not registration.
- **Capability, registration and permission are three separate things.** All three gates pass on
  every call, none substitutes for another, and a connection implies no authorization.
- **Authority only narrows.** No configuration, adapter, devtool or handler widens what the
  provider's capabilities admit.
- **Validate and authorize before invoking, never after.** In the runtime, not the handler; a
  disabled or removed tool never executes.
- **No React internals, no agent-supplied trust.** The socket authenticates with a short-lived,
  single-use ticket; a tab id is metadata.
- **Lifecycle integrity.** Callable only after commit, gone at unmount, idempotent cleanup, StrictMode
  leaves nothing, and a rerender whose descriptor is unchanged never touches the registry.
- **Mandatory functional comments.** Section 6.
- **Named vocabularies for literal values.** A closed set is one exported `as const` dictionary with
  its type derived.
- **Layered testing discipline.** Section 8.
- **Mandatory health-check gate.** Section 3.
- **Fix the defect, never work around it.** Timing workarounds are named because this system invites
  them.
- **Forward-only, current documentation.** `docs/` and `README.md` describe only current behaviour;
  no "previously", "used to", "no longer" framing; a claim that stops matching is fixed or deleted.
- **One branch per change.** Cut from `develop`; one pull request per contribution.
- **Three levels of control are separate layers.** Level 1 application control is the product and
  the preferred level; Level 2 semantic DOM control is a fallback and experimental; Level 3
  JavaScript execution is privileged, off by default, and never enabled to unblock a task. One level
  confers nothing on another, and Levels 2 and 3 never enter the shared registry.

### How work is done

- **Intent first.** If deleting a file loses knowledge the docs and tests do not hold, the
  requirement was never captured.
- **Coherence.** A concept has projections in code, schema, public types, docs, tests and the example
  app; a change is done when they agree again.
- **Meta over patch.** Fix the mechanism that produces a class of errors — without inventing an
  abstraction for a single typo.
- **Fail loud.** Unknown is acceptable; hidden unknown is not. No swallowed errors, no convenience
  defaults.
- **One owner.** One owner per truth, everything else derived; extend by adding owners, not editing
  old ones.
- **Explainable.** Every state is reconstructable from evidence, including what was *not* verified.

## 11. Scope

The non-goals are binding limits, not preferences. The library does not become, and a pull request
that moves it toward one is declined:

- a state management system;
- a remote React renderer;
- a React Fiber bridge;
- a browser automation or testing framework;
- a cross-origin iframe tool;
- a Streamable HTTP MCP server.

The capability model is the one exception to minimalism: the three levels, the capability gate,
per-tool policy, ticket authentication, redaction and level separation are the product and ship whole.
A change that trims one is a defect regardless of what it enables.

Deliberately absent, each behind a seam that already exists so adding it later is a local change.
Do not submit one ahead of a maintainer asking for it:

| Absent | What stands in for it |
|---|---|
| A production ticket service | `tools/mock-agent/` mints dev tickets. The provider takes `getUrl()` and never a credential, so the seam is already the real one |
| Multi-tab orchestration policy | Each tab is an independent server; selection belongs to the agent runtime. The library exposes tab metadata and decides nothing |
| A schema-validation library of this project's own | The tool descriptor carries a JSON Schema and the validator arrives through `@agent-mcp/react/validation`; tool schemas are declared in no library's dialect |
| Rate limiting or call quotas | None. Per-tool policy is the only gate |
| A telemetry pipeline | Structured events through `onToolCall` and the inspector |
| A Streamable HTTP transport | None — a non-goal |
| Bundle-size enforcement in CI | The budget is stated in [docs/records/performance-budgets.md](docs/records/performance-budgets.md) and measured by hand with `scripts/measure-bundle.mjs` |
| `useMcpResource`, `useMcpPrompt`, `useMcpPermission`, `useMcpClientInfo` | The release focuses on tools and state |
| Declarative tools from a `<form>` | Deferred, not rejected; see [docs/conformance.md](docs/conformance.md) |

## 12. Branches and pull requests

- Target **`develop`**. `main` is release-only and receives pull requests from `develop`.
- Branch from `develop`, one branch per change.
- Contributor pull requests are **squash-merged**: one commit on `develop` per contribution. The
  maintainer's own sync commits land by rebase, so `git log --first-parent develop` lists every
  change once.
- The pull-request template asks: what changed and why; the `pnpm gate` result; which manual runs
  were needed and run; which invariant, gate, policy branch or redaction rule the change touches and
  the break-it record for it; which documentation page was updated.
- The **`gate`** check must be green. Branch protection on `develop` and `main` requires it for
  everyone, the maintainer included; there is no administrator bypass.
- **Releases.** The maintainer opens a pull request from `develop` to `main`, rebase-merges it after
  CI, tags `main`'s tip, and publishes to the registry. `CHANGELOG.md` moves its `[Unreleased]`
  section to the version before the release lands on `develop`.

## 13. Contribution terms

Contributions are accepted under the Apache License, Version 2.0, by its Section 5: unless you state
otherwise, any contribution you intentionally submit for inclusion is licensed under the same terms
as the project, patent grant included. There is no sign-off line and no separate agreement to sign.
See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## 14. Reporting

- A vulnerability — anything that lets an agent reach a tool the application did not register, one
  capability confer another, a credential or password value reach an agent, or a page script reach
  a Level 2 or Level 3 tool — goes through [SECURITY.md](SECURITY.md), never a public issue.
- Everything else is an issue. The bug template asks whether the call succeeded while the screen was
  wrong, because that is this system's characteristic defect; the feature template asks for the
  intent rather than the tool, and which level of control it needs.
