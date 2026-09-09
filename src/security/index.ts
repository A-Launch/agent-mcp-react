// The capability model's decision surface: the closed vocabularies it is made of, the check on what an
// application handed us, and the rules that say whether a call may proceed.
//
// What this module owns: **deciding**. What it deliberately does not own, so each absence reads as a
// boundary rather than an omission — it performs no I/O, reads no store, touches no DOM, imports no
// React, and holds no state between calls. A decision module that could read the page is one whose
// verdict depends on when you call it.
//
// **The gates that use these decisions live in the runtime.** A module that decides whether it may run
// is a module that can be imported past its own check — the same reason the DOM capability gate is not
// in `src/dom/`.
//
// There is deliberately **no subpath export** for this module in `package.json`. An
// application reaches it through the provider's `capabilities` prop and through the types re-exported
// from the package root; an importer outside this package would be code holding the gate's own
// vocabulary at arm's length from the gate.

export type {
  CapabilityNormalization,
  CapabilityProblem,
  CapabilityProblemKind,
} from './normalize.ts';
export {
  CAPABILITY_PROBLEM,
  capabilitySignature,
  DENIES_EVERYTHING,
  describeProblems,
  normalizeCapabilities,
} from './normalize.ts';
export type { Decision, DeclaredPermissions } from './resolve.ts';
export { admitsAvailability, admitsLevel, needsConfirmation } from './resolve.ts';
export type {
  AgentCapabilities,
  CapabilityMember,
  ConfirmationDecision,
  ConfirmationRequest,
  ConfirmationResolver,
  ControlLevel,
  DomAuthority,
  RefusedBecause,
  ReservedPrefix,
  Risk,
} from './vocabulary.ts';
export {
  CAPABILITY_MEMBER,
  CONFIRMATION,
  CONTROL_LEVEL,
  DOM_AUTHORITY,
  isCapabilityMember,
  isConfirmationDecision,
  isDomAuthority,
  isRisk,
  LEVEL_CAPABILITY,
  REFUSED_BECAUSE,
  RESERVED_PREFIX,
  RISK,
  reservedPrefixOf,
} from './vocabulary.ts';
