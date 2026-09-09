// The boundary onto the browser's per-document tool registry: the only module in this package that
// touches it, and the unit of change when the standard is revised (docs/conformance.md).
//
// It is deliberately NOT a public subpath export. `./dom`, `./redux`, `./zustand` and `./router` are
// exported because an embedder chooses whether to include them; nobody chooses whether to talk to the
// browser's tool registry — the provider does it — and exporting this boundary would create importers
// outside the package whose code a revision of the standard could break.
export { claimDocument, currentClaimHolder, releaseDocument } from './claim.ts';
export type { RegistryEntry, ToolDeclaration } from './descriptor.ts';
export { fromRegistryEntry, toDescriptor } from './descriptor.ts';
export type {
  BoundaryCode,
  ClaimRefusedCode,
  RegistrationRefusedCode,
  RegistryUnavailableCode,
} from './errors.ts';
export {
  CLAIM_REFUSED,
  isRegistryUnavailableCode,
  REGISTRATION_REFUSED,
  REGISTRY_UNAVAILABLE,
  WebMcpBoundaryError,
} from './errors.ts';
export type { ResolvedRegistry } from './registry.ts';
export {
  ensureRegistry,
  enumerate,
  onToolChange,
  register,
  replaceRegistration,
} from './registry.ts';
export { TARGETED_REVISION } from './revision.ts';
