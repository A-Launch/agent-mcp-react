// The package's principal entry point: everything an application author imports, and nothing else.
//
// **The surface is five things an application calls** — a provider and four hooks — plus the types and
// closed vocabularies needed to name what they hand back. That count is a decision, not an accident of
// what happened to be finished:
//
//   - **No hook returns the runtime.** It carries the ownership record every gate is built on, and a
//     value a component can reach is a value an application can reach around the gates with. The
//     public surface (docs/reference-api.md#hooks) does not include `useMcpRuntime`; it is deferred
//     until something has a use for it, rather than exported because a list mentions it.
//   - **The registry boundary, the transport and the runtime are internal.** An application reaches
//     them through the provider. Exporting any of them would create importers outside this package
//     whose code a revision of the browser tool-registry standard could break.
//   - **`useMcpCapabilities` publishes what this connection may reach.** It reads and never decides:
//     the gate runs in the runtime before every handler, and an application that used this hook
//     INSTEAD of its own check would have moved a decision out of the place that is enforced for both
//     call routes. The set it returns is frozen at its source, so publishing the
//     connection's authority cannot become a way to widen it.
//   - **`useMcpTabId` publishes which page this is.** It is metadata and never a credential: an agent
//     runtime holding several connections uses it to say which page it means, and holding one grants
//     nothing. It is the one hook that needs no provider above it, because an identity is a
//     fact about the page rather than about a connection.
//   - **`useMcpState` is how an agent reads.** It declares one named view of state and publishes
//     `<name>.get_state` — an ORDINARY Level 1 registration, so it is reachable by any script on the
//     page exactly as every other Level 1 tool is, because a capability governs this library's bridge
//     and not the page (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page),
//     and never an entry in the built-in table. What crosses to the agent is what the application's
//     `getState` returned: this library traverses no store and redacts nothing, which is the whole of
//     what invariants 11 and 14 require (docs/design.md#security-invariants) and is deliberately
//     narrower than protecting an author from their own getter.
//   - **`src/security/` is internal.** Its vocabularies are exported below because an application must
//     name a capability; its decision functions are not, because they are the gates' own and a caller
//     holding them would be reasoning about admission somewhere other than where it is enforced.
//
// The vocabularies ARE exported, and that is not a widening of the rule above. A caller must match
// against a named member rather than spell a code as a string literal — so an application that cannot
// import the dictionary is an application forced to hardcode one.

// The page instance's identity, and why it could not be produced. The error type and its closed set
// are exported for the same reason every other dictionary here is: a caller that cannot import the set
// is a caller forced to spell a code as a literal, and a literal cannot be checked against the set it
// came from (CONTRIBUTING.md#9-forbidden-patterns).
export {
  IDENTITY_UNAVAILABLE,
  type IdentityUnavailableCode,
  isIdentityUnavailableCode,
  PageIdentityError,
} from './page-identity.ts';
export type {
  ConnectionStatus,
  McpCallFailure,
  McpConnectionState,
  McpObservedCall,
  McpRegistrationEvent,
  McpRegistryChangeEvent,
  McpToolCallEvent,
  McpToolErrorEvent,
  McpToolResultEvent,
  ReactFailureCode,
  ReactRefusedCode,
} from './react/index.ts';
export {
  AgentMcpProvider,
  type AgentMcpProviderProps,
  AgentMcpReactError,
  CONNECTION_STATUS,
  CONNECTION_TRANSITIONS,
  isConnectionStatus,
  isReactRefusedCode,
  type McpStateDefinition,
  type McpToolDefinition,
  REACT_REFUSED,
  STATE_TOOL_SUFFIX,
  useMcpCapabilities,
  useMcpConnection,
  useMcpState,
  useMcpTabId,
  useMcpTool,
} from './react/index.ts';
export type {
  CallPhase,
  CallRoute,
  GateOutcome,
  GateStepName,
  ObservedGate,
  ObservedPayloads,
  ResolutionRefusal,
  RuntimeFailureCode,
  ToolCallContext,
} from './runtime/index.ts';
// The runtime's failure vocabulary, for the same reason as every other dictionary here: an application
// receives these codes through `onUnexpectedState` and on a tool error, and one that cannot import the
// set is one forced to spell `'MCP_TOOL_CALL_ABANDONED'` as a literal — which is forbidden precisely
// because a literal cannot be checked against the set it came from.
// The dictionaries and their membership checks — never the projector, the emitter or the counter. An
// application that could construct or emit a record could fabricate evidence about a call that never
// happened, and an observability surface whose records cannot be trusted is worse than none because it
// is believed.
export {
  CALL_PHASE,
  CALL_ROUTE,
  FAILURE_VOCABULARY,
  GATE_OUTCOME,
  isCallPhase,
  isCallRoute,
  isFailureVocabulary,
  isGateOutcome,
  isObservedPayloads,
  isResolutionRefusal,
  isRuntimeFailureCode,
  OBSERVED_PAYLOADS,
  RUNTIME_FAILURE,
} from './runtime/index.ts';
export type {
  CompiledSchema,
  SchemaValidator,
  ValidationOutcome,
  ValidationVerdict,
} from './runtime/validation.ts';
export { VALIDATION } from './runtime/validation.ts';
// The capability and permission vocabulary. An application writes `capabilities`, declares
// `permissions` on a tool, and writes a confirmation resolver that must RETURN a decision — so every
// one of those closed sets has to be importable, or the required props can only be written as string
// literals, which is exactly what a closed set exists to prevent.
//
// `src/security/` itself stays internal — there is no subpath for it, and nothing here
// exposes the decision functions the gates call. `isConfirmationDecision` is the one predicate that
// crosses, because an application writing a resolver over its own UI state has the same narrowing
// problem the runtime does.
export type {
  AgentCapabilities,
  CapabilityMember,
  ConfirmationDecision,
  ConfirmationRequest,
  ConfirmationResolver,
  ControlLevel,
  DeclaredPermissions,
  DomAuthority,
  Risk,
} from './security/index.ts';
export {
  CAPABILITY_MEMBER,
  CONFIRMATION,
  CONTROL_LEVEL,
  DOM_AUTHORITY,
  isCapabilityMember,
  isConfirmationDecision,
  isDomAuthority,
  isRisk,
  RISK,
} from './security/index.ts';
export { CLAIM_REFUSED, REGISTRATION_REFUSED, REGISTRY_UNAVAILABLE } from './webmcp/index.ts';
