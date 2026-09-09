// The browser MCP runtime: the MCP server an agent talks to, and the ownership record of what this
// library registered.
//
// What it owns: the server lifecycle, the derivation of `tools/list` from the registry intersected
// with the ownership record, name resolution, and the invocation of the handler that resolution found.
//
// What it does NOT own, so that each absence reads as a decision rather than an omission: the
// connection (it is handed a transport), the tool registry (it reaches one through `src/webmcp/`),
// what a capability admits (`src/security/` decides it; the gate that enforces it is here),
// registration timing and React lifecycle (`src/react/`), and tool-list change notification.
//
// There is deliberately **no subpath export** for this module in `package.json`. Like the registry
// boundary and the transport, it is internal surface: an application reaches it through the provider.

// **The capability model's conduit into the React binding.**
//
// `src/react/` must not import `src/security/` directly — a seam case enforces it, because a gate
// reachable from the renderer is a gate a module can be imported past. What the provider legitimately
// needs is not a gate: it is the check on the value an author handed it, and the shape the gate reads.
// Both travel through here, which is the module that actually holds the gate, so the layering the
// package topology states — react → runtime → security — is the layering the imports have.
//
// The decision functions themselves (`admitsLevel` and its siblings) are deliberately NOT re-exported.
// They are called from `invocation.ts` and nowhere else.
export type {
  AgentCapabilities,
  CapabilityProblem,
  ConfirmationDecision,
  ConfirmationRequest,
  ConfirmationResolver,
  ControlLevel,
  DeclaredPermissions,
  DomAuthority,
  ReservedPrefix,
} from '../security/index.ts';
export {
  CAPABILITY_PROBLEM,
  CONFIRMATION,
  CONTROL_LEVEL,
  capabilitySignature,
  DENIES_EVERYTHING,
  DOM_AUTHORITY,
  describeProblems,
  normalizeCapabilities,
  // The one decision function that DOES travel this conduit, and the exception is worth stating
  // because the paragraph above says the others do not. `reservedPrefixOf` decides nothing about a
  // CALL — it classifies a name at DECLARATION, and declaration happens in `src/react/`, which is the
  // only code that ever puts an application's tool into the document's registry. A gate at invocation
  // could not enforce it at all: by then the name is already taken in a registry shared with every
  // script on the page.
  RESERVED_PREFIX,
  reservedPrefixOf,
} from '../security/index.ts';
// The second source of callable tools. Internal like everything else here: an application does not
// choose which built-ins exist, it chooses which of them an agent may reach. The DOM module and
// `runtime.evaluate` supply entries through this type; nothing outside this package sees it.
export type { BuiltInTable, BuiltInTool } from './built-ins.ts';
export { buildBuiltInTable } from './built-ins.ts';
export type {
  CallPhase,
  CallRoute,
  GateOutcome,
  GateStepName,
  ObservedCall,
  ObservedFailure,
  ObservedGate,
  ObservedPayloads,
  ResolutionRefusal,
} from './call-record.ts';
// The DICTIONARIES and their membership checks, never the projector, the emitter or the counter. An
// application that could construct or emit a record could fabricate evidence about a call that never
// happened — and an observability surface whose records cannot be trusted is worse than none, because
// it is believed.
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
  OBSERVED_PAYLOADS,
} from './call-record.ts';
export type { RuntimeFailureCode } from './errors.ts';
export { isRuntimeFailureCode, RUNTIME_FAILURE, RuntimeError } from './errors.ts';
export type { GateStep, GateStepState } from './gate-chain.ts';
export { builtSteps, GATE_CHAIN, GATE_STEP_STATE, unbuiltSteps } from './gate-chain.ts';
export type { DerivedListing, ListedTool } from './listing.ts';
export { deriveListing } from './listing.ts';
export type {
  CallFacts,
  CallObservation,
  ConsumerFailureSink,
  ObservationBus,
} from './observation.ts';
export { createObservationBus } from './observation.ts';
export type {
  OwnershipEntry,
  OwnershipLookup,
  OwnershipRecord,
  ToolCallContext,
  ToolHandler,
} from './ownership.ts';
export { createOwnershipRecord } from './ownership.ts';
export type { Resolution } from './resolution.ts';
export { RESOLUTION, refusalFor, resolve } from './resolution.ts';
export type { McpRuntime, RuntimeOptions } from './server.ts';
export { createMcpRuntime } from './server.ts';
