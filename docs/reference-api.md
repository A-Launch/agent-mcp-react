# API reference

Every public export of `@agent-mcp/react`, by subpath. **57 values and 57 types across nine entry
points.** The list was extracted from the shipped `.d.ts` files and every value was verified to import
from the built package, so it describes what is in the tarball rather than what is in `src/`.

Deep imports into `src/` are not supported and are not part of this surface. Anything not listed here
is internal and may change without notice.

| Subpath | Values | Types | What it is for |
|---|---:|---:|---|
| [`@agent-mcp/react`](#agent-mcpreact) | 42 | 37 | The provider, the hooks, and the closed vocabularies |
| [`/actions`](#agent-mcpreactactions) | 1 | 2 | Declaring a tool from outside React |
| [`/validation`](#agent-mcpreactvalidation) | 2 | 1 | The bundled Ajv validator |
| [`/dom`](#agent-mcpreactdom) | 6 | 5 | Level 2 — semantic DOM control |
| [`/evaluate`](#agent-mcpreactevaluate) | 1 | 1 | Level 3 — JavaScript execution |
| [`/devtools`](#agent-mcpreactdevtools) | 1 | 3 | The in-page inspector |
| [`/redux`](#agent-mcpreactredux) | 1 | 3 | Redux action binding |
| [`/zustand`](#agent-mcpreactzustand) | 1 | 2 | Zustand action binding |
| [`/router`](#agent-mcpreactrouter) | 2 | 3 | Navigation and URL-backed filters |

**Importing a subpath is one of two independent conditions for Level 2 and Level 3.** Importing
`/dom` or `/evaluate` does not grant anything; an operator must also grant the capability. Conversely
a granted capability with nothing imported reaches no tool. Neither implies the other, by design.

---

## `@agent-mcp/react`

### The provider

```ts
function AgentMcpProvider(props: AgentMcpProviderProps): ReactNode
```

**Four props are required**: `connection`, `server`, `capabilities`, `onUnexpectedState`.

| Prop | Required | Notes |
|---|---|---|
| `connection: { getUrl }` | **yes** | Called once per connection attempt. Its result is opaque — never parsed, amended, or stored |
| `server: { name, version }` | **yes** | Identifies this page to the MCP client |
| `capabilities: AgentCapabilities` | **yes** | **Every member required.** No default profile; absent denies |
| `onUnexpectedState` | **yes** | Where a broken invariant goes. Required so alarms cannot default to silence |
| `validation: { validator }` | no | Required in practice: a tool declaring a schema with no validator **is not registered** |
| `builtInTools` | no | Level 2 / Level 3 tools, supplied by the application |
| `confirmation: { resolver }` | no | Without it, every `confirmation: 'required'` tool is refused at invocation |
| `observability: { payloads }` | no | `'metadata'` or `'values'` |
| `devtools: { enabled }` | no | Development builds only |
| `onToolCall`, `onToolResult`, `onToolError` | no | Call lifecycle |
| `onRegistryChange`, `onRegistration`, `onConnectionChange` | no | Registry and connection lifecycle |

### Hooks

```ts
function useMcpTool(definition: McpToolDefinition): void
function useMcpState(definition: McpStateDefinition): void
function useMcpCapabilities(): AgentCapabilities
function useMcpConnection(): McpConnectionState
function useMcpTabId(): string
```

- **`useMcpTool`** declares a tool for as long as the component is mounted. Registration happens in an
  effect, after commit — an aborted render exposes nothing. See [declaring-a-tool.md](declaring-a-tool.md).
- **`useMcpState`** publishes `<name>.get_state` as an ordinary Level 1 tool. It is a composition over
  `useMcpTool`, not a second registration path. See [exposing-state.md](exposing-state.md).
- **`useMcpCapabilities`** returns the granted set, frozen at its source.
- **`useMcpTabId`** returns this page instance's identity. **Metadata, never a credential**, and never
  write one by hand.

### Errors

```ts
class AgentMcpReactError    // a refusal from the React layer
class PageIdentityError     // the platform could not mint an identity
```

### Closed vocabularies

Every set below is exported `as const` with its type derived from it, plus a membership guard. Never
hardcode a member: a closed set has one owner, its type is derived from it, and membership is checked at
every boundary a value crosses rather than cast onto the type.

| Constant | Members | Guard |
|---|---|---|
| `CONNECTION_STATUS` | `disconnected`, `connecting`, `connected`, `reconnecting`, `error` | `isConnectionStatus` |
| `CONNECTION_TRANSITIONS` | the legal moves between those states | — |
| `CONTROL_LEVEL` | `application: 1`, `dom: 2`, `evaluate: 3` | — |
| `CAPABILITY_MEMBER` | `application`, `dom`, `evaluate` | `isCapabilityMember` |
| `DOM_AUTHORITY` | `inspect`, `interact` | `isDomAuthority` |
| `CALL_PHASE` | `start`, `result`, `error` | `isCallPhase` |
| `CALL_ROUTE` | `bridge`, `registry` | `isCallRoute` |
| `GATE_OUTCOME` | `passed`, `refused`, `notRun` | `isGateOutcome` |
| `CONFIRMATION` | `approved`, `refused` | `isConfirmationDecision` |
| `OBSERVED_PAYLOADS` | `metadata`, `values` | `isObservedPayloads` |
| `VALIDATION` | `valid`, `invalid`, `unusable` | — |
| `RISK` | `read`, `write`, `destructive`, `privileged` | `isRisk` |
| `STATE_TOOL_SUFFIX` | `"get_state"` | — |

> **`RISK` is spelled but not enforced.** Nothing reads it and MCP's annotations schema strips it in
> transit. It exists so a future feature cannot spell a level as a string literal. It never softens a
> gate above it.

### Failure codes

| Dictionary | Codes | Covers |
|---|---:|---|
| `RUNTIME_FAILURE` | 24 | Everything a call can be refused for |
| `REACT_REFUSED` | 7 | The React layer |
| `REGISTRATION_REFUSED` | 6 | A registration the registry would not take |
| `REGISTRY_UNAVAILABLE` | 5 | No usable registry — insecure context, policy, install refused |
| `CLAIM_REFUSED` | 3 | The one-provider-per-document claim |
| `IDENTITY_UNAVAILABLE` | 3 | Page identity could not be minted |
| `FAILURE_VOCABULARY` | 3 | Which dictionary a code belongs to |

Guards: `isRuntimeFailureCode`, `isReactRefusedCode`, `isResolutionRefusal`, `isFailureVocabulary`,
`isIdentityUnavailableCode`.

### Types

`AgentCapabilities`, `AgentMcpProviderProps`, `CallPhase`, `CallRoute`, `CapabilityMember`,
`CompiledSchema`, `ConfirmationDecision`, `ConfirmationRequest`, `ConfirmationResolver`,
`ConnectionStatus`, `ControlLevel`, `DeclaredPermissions`, `DomAuthority`, `GateOutcome`,
`GateStepName`, `IdentityUnavailableCode`, `McpCallFailure`, `McpConnectionState`, `McpObservedCall`,
`McpRegistrationEvent`, `McpRegistryChangeEvent`, `McpStateDefinition`, `McpToolCallEvent`,
`McpToolDefinition`, `McpToolErrorEvent`, `McpToolResultEvent`, `ObservedGate`, `ObservedPayloads`,
`ReactFailureCode`, `ReactRefusedCode`, `ResolutionRefusal`, `Risk`, `RuntimeFailureCode`,
`SchemaValidator`, `ToolCallContext`, `ValidationOutcome`, `ValidationVerdict`.

---

## `@agent-mcp/react/actions`

```ts
function registerMcpTool(definition: McpToolDefinition): McpToolRegistration
```

Declares a tool whose owner is the application shell — a singleton service, a router, an import-time
module. Imports no React, so it works from anywhere.

The returned handle carries `update` and `remove`. **The queue holds declarations; the provider holds
registrations**, which is why a shell-owned tool survives a provider remount. Only `remove()` ends it.

This is a **registration API, not a runtime.** The `createAgentMcpRuntime()` the original design
sketched does not ship: a runtime an application constructs is a second MCP server on one page. See
[It is a registration API, not a runtime](tools-outside-react.md#it-is-a-registration-api-not-a-runtime).

Types: `McpToolDefinition`, `McpToolRegistration`.

---

## `@agent-mcp/react/validation`

```ts
function createAjvValidator(options?: AjvValidatorOptions): SchemaValidator
const DIALECT = 'draft-07'
```

**A tool that declares a schema with no validator installed is not registered at all** — silently
absent rather than broken.

> **Requires CSP `unsafe-eval`.** Ajv compiles schemas with `new Function`. Under a `script-src` that
> omits it, compilation throws and **your app exposes no tools**. See
> [the defect record](issues/validator-requires-unsafe-eval.md).

The dialect is draft-07 because that is what the MCP SDK re-exports. Supply your own `SchemaValidator`
for 2020-12.

Types: `AjvValidatorOptions`.

---

## `@agent-mcp/react/dom`

Level 2. **Never registered** — absent from the document's shared registry in every configuration,
including one that granted it, because anything in that registry is callable by any page script
without passing a gate.

```ts
function domInspectTools(options: DomInspectOptions): readonly BuiltInTool[]   // dom.snapshot, dom.get_text
function domInteractTools(options: DomInspectOptions): readonly BuiltInTool[]  // click, fill, select, press, scroll
function invalidateDomRefs(document?: Document): void
```

Vocabularies: `NOT_INTERACTABLE`, `PRESSABLE_KEY`, `SCROLL_DIRECTION`.
Types: `NotInteractable`, `PressableKey`, `ScrollDirection`, and the shape of what a snapshot returns
— `Snapshot` and `SemanticElement`.

`DomInspectOptions` appears in the signatures above and is **not** exported from this subpath, so a
consumer cannot name it. Pass an object literal; the compiler checks it against the parameter either
way.

Two independent conditions gate these: the application imports this subpath and supplies
`builtInTools`, **and** an operator grants `dom.inspect` or `dom.interact`. `inspect` does not admit a
write tool. Experimental in `0.1`. See [dom-inspection.md](dom-inspection.md).

---

## `@agent-mcp/react/evaluate`

Level 3, **disabled by default**, behind four conditions none of which implies another: the
application imports this subpath, an operator grants `evaluate`, a confirmation resolver is wired, and
a person approves the specific call.

```ts
const runtimeEvaluateTool: BuiltInTool     // runtime.evaluate
```

The first built-in to use `permissions.confirmation`. Uses `new Function`, never `eval` — `eval` runs
in the caller's scope, which would be this library's. Never enable it to unblock a task. See
[javascript-evaluation.md](javascript-evaluation.md).

Types: `EvaluateToolOptions`.

---

## `@agent-mcp/react/devtools`

```ts
function createInspector(options: InspectorOptions): Inspector
```

Observational only: it can explain a denied call and can never make one. Enforced by shape rather than
by a type — it is constructed with a host element and nothing else, and nothing it exposes returns
something callable. Imports no React.

Types: `Inspector`, `InspectorOptions`, and `InspectedCall` — one entry of the call log the inspector
renders.

---

## `@agent-mcp/react/redux`

```ts
function bindReduxTool<A>(binding: ReduxToolBinding<A>): McpToolRegistration
```

Binds **one action creator** — never a store. `redux.dispatch` is unspellable through this adapter
because a store is not an action creator.

Types: `ReduxActionCreator`, `ReduxDispatch`, `ReduxToolBinding`.

---

## `@agent-mcp/react/zustand`

```ts
function bindZustandTool(binding: ZustandToolBinding): McpToolRegistration
```

**A bound Zustand action and `store.setState` have the same structural type**, so no signature can
tell them apart. What bounds this one is the declared schema. Both spellings are shown side by side in
[store-adapters.md](store-adapters.md).

Types: `ZustandAction`, `ZustandToolBinding`.

---

## `@agent-mcp/react/router`

```ts
function bindNavigationTool(binding: NavigationToolBinding): McpToolRegistration
function bindUrlFilterTool(binding: UrlFilterToolBinding): McpToolRegistration
```

**There is no navigation capability.** Navigating does change which tools exist — a route change
unmounts the components that declared them — which is a reason to prefer a domain intent over a path,
not a reason for a fourth capability member.

Types: `Navigate`, `NavigationToolBinding`, `UrlFilterToolBinding`.

---

## See also

- [Tutorial: your first agent-callable tool](tutorial-first-tool.md) — start here if you have not used it
- [Declaring a tool](declaring-a-tool.md) — everything `useMcpTool` accepts
- [Connecting to an agent](connecting-to-an-agent.md) — the socket, tickets and reconnection
- [Consuming without publishing](consuming-without-publishing.md) — install routes that work
