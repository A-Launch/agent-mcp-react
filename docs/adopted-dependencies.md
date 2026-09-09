# Adopted dependencies

What this library depends on, why each was adopted or rejected, and what happens if one stops being
maintained. Written as current state: the record of how each decision was reached is maintained
outside this repository; this page holds what the decision is.

The reasoning rule behind every row: **research precedes building, and a plan introducing a new
mechanism names the alternative it rejected.** A library rejected here is rejected on a property of
this project's requirements, not on quality.

## Adopted

### The browser tool-registry standard — the programming interface

`document.modelContext`, a W3C Web Machine Learning Community Group Draft Report.

Tools are declared through it rather than through an interface of this library's own. An action
instrumented once is therefore reachable by both this project's external agent and a browser's own
agent, and an author who knows the standard already knows this library's declaration surface.

| | |
|---|---|
| **Status** | Draft Community Group Report. One browser channel ships an implementation; no other engine has. |
| **License** | A specification, not code. |
| **Stability** | **Low, and known to be low.** The registry attribute has already migrated host objects once, with the original now deprecated. |
| **Containment** | All contact confined to `src/webmcp/`, which records the revision targeted. A revision must be absorbable there alone — the boundary rule in [package structure](design.md#package-structure). |
| **If it stalls or diverges** | The boundary is rewritten; nothing else is. That is what the boundary is for. |

### `@mcp-b/webmcp-polyfill` and `@mcp-b/webmcp-types` — portability

Installs the standard's producer API where the browser has none, defers to a native implementation
where one exists, and tracks the host-object migration upstream.

| | |
|---|---|
| **Status** | Published, actively versioned. |
| **License** | MIT. |
| **Why not write one** | It would duplicate a maintained implementation and make this project track the standard's migrations by hand — two owners of one truth, where the rule is one owner per truth and everything else derived. |
| **Why not vendor a copy** | Same problem, plus a copy that silently ages. |
| **Why not a peer dependency** | Portability is this library's promise. Delegating a correctness-critical install decision to the embedder makes it their bug. |
| **If it becomes unmaintained** | Vendoring becomes the fallback, and the cost is bounded: the surface consumed is small, and only `src/webmcp/` touches it. |

### `@modelcontextprotocol/server` — the protocol surface

Used for its **low-level** server, its JSON Schema validator, and its transport interface.

| | |
|---|---|
| **Status** | v2, the stable line, implementing the current MCP specification. |
| **License** | MIT. |
| **Why the low-level server** | The high-level `McpServer` keeps its own tool registry. Using it would make that list a second authority over which tools exist. The low-level server derives `tools/list` from a handler this library writes, so there is nothing to keep in step (see [the tool list is derived](design.md#the-tool-list-is-derived)). |
| **Browser support** | **Verified — it runs.** Bundled for a browser target it pulls no `node:` specifier and no Node global, and a full round trip executes in Chromium: construct the low-level `Server`, answer a derived `tools/list`, serve a `tools/call`, refuse a malformed argument through `fromJsonSchema`, and call `sendToolListChanged()`. Evidence below. |
| **Weight** | 59.1 KB gzip for the low-level `Server`, which is the smallest of the available options. The [50 KB size budget](records/performance-budgets.md) excludes the SDK, so this is a page-weight fact for an embedder rather than a budget breach. |

**Zod ships with it.** `zod@^4` is a hard dependency of the server package and is present even when
only `Server` is imported; it is not tree-shakeable away. This does not reverse the decision to add no
schema library of this project's own — the choice of what validates tool input is still the SDK's
`fromJsonSchema` over a JSON Schema — but a schema library is in the bundle either way, and a plan
that assumed otherwise would be wrong about page weight.

**This dependency also resolves an open question rather than adding one.** Its exported JSON Schema
validator, combined with the JSON Schema the registry's descriptor already carries, means tool input
validation needs no external schema library. That deferral is closed, not pending.

### The toolchain and the mock agent — adopted first

Not part of the published library. Recorded here anyway, because the question this page exists to answer — what happens if
this becomes unmaintained — has an answer for each, and a reader deciding whether to replace one
should not have to reconstruct it.

| Dependency | Where | License | If it goes unmaintained |
|---|---|---|---|
| `vitest` 3.2 | four test projects | MIT | The layers are plain `describe`/`it` with no framework-specific helpers; the migration cost is the config, not the cases. |
| `@playwright/test` | `tests/e2e/` | Apache-2.0 | Nothing else can drive a real browser as well; a replacement would be a genuine loss, which is why e2e is the smallest layer. |
| `@testing-library/react` + `jsdom` | `tests/react/` | MIT | Both are the de facto standard for asserting a React tree without a browser. |
| `@biomejs/biome` 2 | lint + format | MIT | Formatting and linting are not load-bearing on behaviour; the fallback is ESLint + Prettier. |
| `ws` 8 | `tools/mock-agent/` | MIT | The Node WebSocket implementation. The browser side of this library never sees it — `src/transport/` uses the platform `WebSocket`. |
| `@modelcontextprotocol/client` 2.0.0 | `tools/mock-agent/` | MIT | The counterpart of the server package already adopted; the same maintainer and release line, so its risk is not independent of it. |

**`@modelcontextprotocol/server` is a runtime dependency of the root package** — the library's own
runtime is built on its low-level server, and the root manifest is the place someone reads to learn
what ships. It began as a devDependency standing in for the page in two transport specs, and the
distinction was kept until the runtime depended on it for real.

**Node's type stripping is a dependency too**, though it installs nothing: the mock agent runs as
TypeScript through `node --experimental-strip-types`, which is why its imports carry explicit `.ts`
specifiers and why the typecheck config enables `allowImportingTsExtensions`. The alternative was a
build step for a development tool, which is a build step that goes stale exactly when someone is
debugging.


### The portability layer, exercised — 2026-08-22

Adopted as a runtime dependency on 2026-08-22 and driven by its conformance suite. Two behaviours its
documentation does not mention, both found by reading the shipped source rather than the README, and
both of which changed the design:

**It initializes itself at import time.** The module's last statement calls the initializer unless
`window.__webMCPPolyfillOptions.autoInitialize === false` was set *before* the module evaluated. A
static ESM import cannot arrange that from inside the importing module. Left as-is, importing this
library would install a registry, a deprecated `navigator.modelContext` alias and a
`navigator.modelContextTesting` surface into every document that loads it — including a build that
never mounts a provider. `src/webmcp/` imports it dynamically and initializes explicitly, with the
testing shim off.

**It has no secure-context check.** None — not a weak one. The registry attribute is `[SecureContext]`,
so a native implementation is never present on an insecure origin, but the layer installs a stand-in
there happily. The design asserted the opposite until this measurement corrected it, and
`README.md` repeated it. The check now belongs to `src/webmcp/`, and [the provider](design.md#the-provider)
states the rule: on an insecure origin the provider refuses rather than manufacturing an environment
that exists nowhere else.

**Also worth knowing**: `registerTool` throws synchronously on a duplicate name and returns a rejected
promise for an already-aborted signal, so a trailing `.catch()` handles one and not the other; change
events are coalesced onto a microtask; and the host properties are defined `configurable`, which is
what makes test isolation between cases possible at all.

None of these is a reason to reject the layer. It does the job, on three engines, and the alternative
is writing and maintaining one. They are reasons the boundary looks the way it does.


## Evaluated and rejected

**Is there a unified library that does all of this?** No. The question is worth answering in detail,
because the composition here looks like accidental complexity until you see which layer nothing
covers.

| Layer | A library exists | Status |
|---|---|---|
| Registry and portability | `@mcp-b/webmcp-polyfill` | adopted |
| React lifecycle binding | `usewebmcp`, `@mcp-b/react-webmcp` | rejected — see below |
| MCP protocol | `@modelcontextprotocol/server` | adopted |
| **Transport to a remote agent** | **nothing** | built here |
| **Capability model, ticket authentication, redaction** | **nothing** | built here |

`@mcp-b/transports@4.0.0` exports `ExtensionClient/ServerTransport`, `IframeChild/ParentTransport`,
`TabClient/ServerTransport` and `UserScriptClient/ServerTransport`. **No WebSocket transport of any
kind** — verified by reading the package's exports, not its documentation. The one WebSocket in that
ecosystem lives in the local relay, on the Node side, bridging to stdio.

The two missing rows are this project. That is the whole reason it exists.

### `@mcp-b/global` — the closest thing to a unified runtime

Bundles the shim, an MCP bridge and a transport. Run in Chromium rather than read:

- **It self-installs on import.** A deliberately wrong initializer name still left
  `document.modelContext` populated, so the install is a module-scope side effect. That breaks server
  rendering and contradicts the rule that [the provider](design.md#the-provider) initializes the
  registry inside its effect, never at module scope.
- **It replaces the registry** with its own `BrowserMcpServer` — confirmed by reading
  `document.modelContext.constructor.name` after import — carrying `registerResource`,
  `registerPrompt` and `syncNativeTools` beyond the standard. The wrapper becomes the authority and
  the platform registry becomes its mirror, which is the inversion of the rule that
  [the registry is the sole authority](design.md#registration-follows-the-commit) over which tools exist.
- Its transports are tab and iframe messaging. Cross-origin iframe access is an explicit
  [non-goal](design.md#non-goals), and this project's connectivity is its own authenticated socket.
- 910 KB bundled.

### `@mcp-b/webmcp-ts-sdk` — a mirrored server

A `BrowserMcpServer` composing the official `McpServer` and **mirroring** tools from
`document.modelContext`, with a `syncNativeTools()` reconcile step. Mirror-and-reconcile is the second
registry that [the sole-authority rule](design.md#registration-follows-the-commit) forbids; a reconcile
step exists precisely because two lists can disagree. Its origin
restriction is enforced by page JavaScript and its own documentation says this is not a security
boundary, so it cannot carry the capability model.

### `@mcp-b/webmcp-local-relay` — prior art for connectivity

Bridges a page's registered tools to a desktop agent over a loopback WebSocket. Genuine prior art,
evaluated seriously. Its stated boundary is loopback binding plus an `Origin` check, which its own
documentation says is not process authentication; this design requires
[ticket authentication](design.md#authentication) and forbids a connection's identity — including its
[page identity](design.md#page-identity) — implying authorization. It carries no capability model, and that model is the
product rather than hardening.

### `usewebmcp` — rejected, but the most useful thing read during this evaluation

The lean React binding: `@mcp-b/webmcp-polyfill` plus types, React as a peer, one exported hook
`useWebMCP(config, deps)`.

**It independently arrived at three mechanisms this project specified**, which is real validation that
[registration follows the commit](design.md#registration-follows-the-commit) and
[stable handlers](design.md#stable-handlers) describe the actual problem and not an invented one:

- the execute handler behind a `useRef`, refreshed in a layout effect — the stale-closure fix of
  [stable handlers](design.md#stable-handlers);
- one `AbortController` per registration, aborted by the effect's cleanup — withdrawal as an abort, in
  [registration follows the commit](design.md#registration-follows-the-commit);
- a module-level `Map` keyed by tool name holding a `Symbol` token, so a StrictMode double-mount
  cleans up only the registration it owns — [Strict Mode](design.md#strict-mode-and-suspense). Worth
  borrowing knowingly rather than rediscovering.

**Three disqualifiers, all the same species — a failure that becomes a log line:**

1. **A rejected `registerTool` becomes `console.warn`.** A duplicate name does not throw; it warns and
   the tool silently does not exist. The rule here is that development throws and names the
   registration source, and production rejects the later registration and keeps the original
   (see [duplicate and foreign names](design.md#duplicate-and-foreign-names)) — not that anything
   continues as though nothing happened.
2. **No registry available → `console.warn` and return.** The tool silently does not exist. This
   library has no degraded mode: [the provider](design.md#the-provider) fails loudly and names which
   of the four causes applied.
3. **An `inputSchema` change never re-registers.** The schema is read from a ref at registration time
   and the registration effect's dependencies are `[name, description, ...deps]`. Change a tool's
   input schema and the agent keeps calling against the old one — succeeding, against the wrong
   contract. This is the silent-success defect this library exists to prevent, and it is invisible to
   types and to tests that only assert the call returned.

A fourth observation, not a reason for rejection: the published build has `NODE_ENV` baked as
`production` — no `process.env` reference survives in `dist/index.js`, and there is a single entry
point with no development build — so its development-only warnings never fire for any consumer,
including the one warning it raises about re-registration.

`@mcp-b/react-webmcp` is the full-runtime sibling of the same hook and additionally depends on
`@mcp-b/global` and the v1 MCP SDK, inheriting the objections above.

### What was reused without being adopted

The confirmation that the shim is the right portability layer; that a derived server rather than a
mirrored one is how to avoid a second registry; and `usewebmcp`'s Symbol-token approach to StrictMode
cleanup, worth borrowing knowingly rather than rediscovering.

## Verification status

Every behavioural claim below came from published documentation. **Each row carries its own state**, and
the rule is unchanged and absolute: **an UNTICKED row blocks its requirement** — no requirement may be
claimed against a behaviour until its conformance case passes (the rule in
[testing strategy](design.md#testing-strategy)). A ticked row names the case that closed it.

The state lives in the rows rather than in the heading. A heading asserting "none verified" above a
row saying "TICKED" is exactly the contradiction this file exists to prevent.

| Claim | Blocks |
|---|---|
| The shim declines to install when a native registry exists | Native precedence (the rule in [the provider](design.md#the-provider)). **TICKED 2026-08-28** — `tests/e2e/native-registry/precedence.spec.ts` runs the layer's own browser build over Chromium's native registry and asserts it neither replaces the object nor leaves one of its own instances behind. **That is a different claim from the case beside it**, which shows this library never asks the layer to install; a row about the shim needs the shim invoked. Neither is evidenced by the jsdom case, where the registry already present is the layer's OWN instance. Opt-in lane, so the claim is re-checked deliberately rather than on every release. |
| A registry offered *only* under the deprecated host object still registers and invokes | Portability, the deprecated host object in [the conformance findings](conformance.md#findings). **PARTIAL** — `tests/conformance/registry-registration.spec.ts` registers a tool through the deprecated host and invokes it. Both the shim and Chromium alias the two hosts to one object, so an environment offering *only* the deprecated one is not reachable here. |
| Native and shimmed registries agree on abort-driven withdrawal under React's double-invoked effects | Lifecycle — withdrawal as an abort, in [registration follows the commit](design.md#registration-follows-the-commit). The shim half is verified by `tests/conformance/registry-registration.spec.ts`; the native half is unwritten — `tests/e2e/native-registry/` reaches an engine that could answer it and carries no case for it. Listed open in [the conformance rows](conformance.md#the-rows). |
| The client call that opens the stream carrying `notifications/tools/list_changed` on the current protocol | Change notification (see [the tool list is derived](design.md#the-tool-list-is-derived)). **TICKED** — `tests/transport/runtime/notification.spec.ts` drives it against the mock agent under `tools/mock-agent/` and asserts the negotiated protocol version is `2025-11-25`, the era where notifications are unsolicited: there is no subscription call, and the notification arrives without one. |

The rows that need **an engine with a native implementation** are work rather than blockers: Chromium
under `--enable-features=WebMCP` is reachable (measured 2026-08-28) and `tests/e2e/native-registry/`
measures it. Firefox and WebKit implement none of it, so the shim path is the only one this project can
exercise there — which is also the path Safari and Firefox users take, so the coverage gap is on the
rarer configuration rather than the common one.

A verification that has not run is a fact about the state of this project, not an omission from this
page.


## Verified

### The MCP SDK server package runs in a browser — 2026-08-22

The one claim that blocked the whole protocol layer. Established by execution, not by reading.

**Method.** `@modelcontextprotocol/server@2.0.0` installed clean, entry point importing only `Server`
and `fromJsonSchema`, bundled with esbuild at `--platform=browser --format=esm`, served over
`http://127.0.0.1` and driven in Chromium.

**Result — all pass.**

| Check | Outcome |
|---|---|
| Bundles for a browser target | Yes, no unresolved imports |
| `node:` specifiers in output | 0 |
| Node globals (`process`, `Buffer`, `__dirname`) | 0 |
| Constructs the low-level `Server` with `tools: { listChanged: true }` | Yes |
| `fromJsonSchema` produces a working validator | Yes |
| `server.connect()` over a hand-written `Transport` | Yes |
| `tools/list` answered from a derived list | Yes |
| `tools/call` returning `structuredContent` | Yes |
| A malformed argument refused before the handler | Yes |
| `sendToolListChanged()` | Does not throw |

**Comparative weight**, minified and gzipped, browser target:

| | min | gzip |
|---|---|---|
| **v2 low-level `Server`** | 229.9 KB | **59.1 KB** |
| v2 `Server` + `fromJsonSchema` | 230.2 KB | 59.2 KB |
| v2 `McpServer` (high-level) | 247.1 KB | 63.6 KB |
| v1 low-level `Server` | 243.0 KB | 69.4 KB |
| v1 `McpServer` | 341.0 KB | 92.9 KB |

**The v1 fallback is unnecessary, and would have been the worse choice on both axes.** It is larger, and its
dependency list is oriented at a Node server — Express, Hono, cors, jose, cross-spawn — which
tree-shakes out of a browser bundle but is not what this library wants underneath it.

The low-level `Server` was already the design choice, for the single-authority reason in
[the tool list is derived](design.md#the-tool-list-is-derived). It is
independently the smallest of the five options measured, which is a coincidence worth noting rather
than relying on.

**What this does not establish.** That the probe is not the library. A permanent conformance case
belongs in the repository, in the layer that owns bundling — the rule in
[testing strategy](design.md#testing-strategy) that a documented claim is not a verified one — and it
exists: `tests/e2e/conformance-bundle.spec.ts`. A question answered once in a scratch directory is not a regression test; that case is.


### The registry layer, across three engines — 2026-08-22

The SDK result above says the protocol layer runs. This says the **registration** layer does, on the
engines [browser support](browser-support.md) claims.

`@mcp-b/webmcp-polyfill@4.0.0` (MIT), bundled for a browser target and driven over
`http://127.0.0.1` in Playwright's Chromium 151, Firefox 153 and WebKit 26.5.

| Check | Chromium | Firefox | WebKit |
|---|---|---|---|
| Module loads; `initializeWebMCPPolyfill` is a function | ✅ | ✅ | ✅ |
| Installs `document.modelContext` | ✅ | ✅ | ✅ |
| `navigator.modelContext` present as an alias | ✅ | ✅ | ✅ |
| A second initialization keeps the same instance | ✅ | ✅ | ✅ |
| `registerTool` resolves | ✅ | ✅ | ✅ |
| `getTools` returns the registration | ✅ | ✅ | ✅ |
| A duplicate name rejects | ✅ | ✅ | ✅ |
| Aborting the signal withdraws the tool | ✅ | ✅ | ✅ |
| `toolchange` fires once on withdrawal | ✅ | ✅ | ✅ |

**Note what "WebKit" is and is not.** Playwright's WebKit is the engine Safari is built on, not Safari.
It is the standard proxy and it is what CI can run, but Apple ships additions and differences on top of
it. A claim about Safari specifically is a claim about a browser this project has not driven.

**Minimum engine versions.** The newest built-in in the bundle is `AbortSignal.any` — Chrome 116,
Safari 17.4, Firefox 124. esbuild compiles the syntax down cleanly; built-ins are what set the floor,
because esbuild downlevels syntax and does not polyfill globals.

The next-newest built-in is `Object.hasOwn` (Safari 15.4, Firefox 92), so the floor is set by a
**feature** rather than by a bundling built-in. A call ends for two real reasons, the agent
cancelling and the tool ceasing to be declared, and a handler has to learn about both through the one
signal it already holds; the alternative was a second mechanism every application would check by hand.
The trade was made knowing all three versions sit inside the support window this project states.

### One divergence from the standard, found by running it

The standard specifies that registering a name the registry already holds rejects with an
`InvalidStateError` **DOMException**. The shim rejects with a **plain `Error`**:

```
constructor : Error          e.name : Error
message     : Tool already registered: a.b
instanceof DOMException : false      code : undefined
```

Identical on all three engines. Recorded at planning time as "not verified"; now verified
as **not matching**.

**It changes the design, and for the better.** Nothing may key off the exception's class, name or
message — that would work on the shim and break on a native registry, or the reverse. The library
decides which duplicate case it is from **its own ownership record**: if it holds the name, another
mounted component registered it; if it does not, the name belongs to someone else. That test is a
property of this project's own state, so it returns the same answer under any implementation.
That rule is stated under [duplicate and foreign names](design.md#duplicate-and-foreign-names); the
[conformance findings](conformance.md#findings) record what each registry does with the collision.

This is the value of running a claim rather than reading it: the documented behaviour and the shipped
behaviour disagreed, and the design that depended on the documented one would have failed on whichever
implementation it was not tested against.
