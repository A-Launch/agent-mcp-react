import type { RegistryEntry } from '../webmcp/index.ts';
import type { BuiltInTable } from './built-ins.ts';
import { RUNTIME_FAILURE, RuntimeError } from './errors.ts';
import type { OwnershipRecord } from './ownership.ts';

// Step 2 of the gate chain: deciding what a name the agent sent actually refers to.
//
// This step is not optional plumbing, and the reason is measured rather than assumed: **the MCP SDK
// validates nothing.** A call naming a tool that appeared in no listing is delivered straight to the
// call handler. Without this step the agent reaches whatever that handler does, under a name nobody
// registered — which is the shared-registry problem arriving through the protocol instead of the page.
//
// Five outcomes rather than "found or not found", because the responses genuinely differ:
//
//   builtIn   — a tool this library ships. Proceed, at the level ITS OWN TABLE declares.
//   owned     — a tool the application registered. Proceed, at Level 1.
//   foreign   — another script holds the name. The application cannot fix this by changing its own
//               code, and we must not shadow, rename around or remove it.
//   unknown   — nobody holds it.
//   diverged  — WE believe we hold it and the registry disagrees. A broken invariant, not an absence.
//
// Collapsing any of these into one cause would hide which condition an operator is facing.
//
// **The built-in outcome is decided HERE rather than by the dispatcher, and that is the whole reason
// this file changed**. A built-in tested ahead of resolution would make this step's own
// description — *"whether the named tool is one this library registered"* — false for every built-in,
// and would leave the collision precedence to whichever call site happened to check first. One owner
// of "what does this name refer to", one precedence rule.

/** What a name resolved to. A closed set, declared once here with its type derived from it. */
export const RESOLUTION = {
  /**
   * A tool this library ships — Level 2 or Level 3, and never in the document's registry.
   *
   * First in precedence, unconditionally. A foreign script may register `dom.click` and this library
   * cannot stop it; what it can guarantee is that the name means the built-in **over the bridge**,
   * whatever is in the registry. The page's own route still reaches the foreign handler, which is the
   * page's business and not something this library can or should change.
   */
  builtIn: 'builtIn',
  owned: 'owned',
  foreign: 'foreign',
  unknown: 'unknown',
  diverged: 'diverged',
} as const;

export type Resolution = (typeof RESOLUTION)[keyof typeof RESOLUTION];

/**
 * Decides what a name refers to, from the registry and the ownership record and nothing else.
 *
 * Both inputs are supplied rather than read here, so this function is a decision with no I/O — which
 * is what lets every outcome be exercised without a registry, a socket or a document.
 */
export function resolve(
  name: string,
  registryEntries: readonly RegistryEntry[],
  ownership: OwnershipRecord,
  builtIns: BuiltInTable,
): Resolution {
  // **First, and the ordering IS the precedence rule.** A name in this library's own table means that
  // tool over the bridge, whatever a foreign script has put in the document under it. Checking the
  // registry first would let any page script take a gated Level 2 name away from the agent by
  // registering it — the shape of a downgrade attack, and one an application could not detect.
  if (builtIns.has(name)) return RESOLUTION.builtIn;

  const inRegistry = registryEntries.some((entry) => entry.name === name);
  const inRecord = ownership.holds(name);

  if (inRegistry && inRecord) return RESOLUTION.owned;
  if (inRegistry) return RESOLUTION.foreign;
  if (inRecord) return RESOLUTION.diverged;
  return RESOLUTION.unknown;
}

/**
 * Turns a non-`owned` outcome into the failure that will reach the agent.
 *
 * Invariant: **a withdrawn tool is refused here, not merely absent from the listing.** Absence is not
 * an access control — an agent may hold a list from before the withdrawal, and a well-behaved client
 * is not the case a control exists for. A withdrawn name resolves as `unknown` and is refused.
 */
export function refusalFor(
  name: string,
  outcome: Exclude<Resolution, 'owned' | 'builtIn'>,
): RuntimeError {
  switch (outcome) {
    case RESOLUTION.foreign:
      return new RuntimeError(
        RUNTIME_FAILURE.nameHeldByForeignOwner,
        `the tool "${name}" is registered in this document by a script this application does not own, so it is not bridged`,
        name,
      );
    case RESOLUTION.diverged:
      return new RuntimeError(
        RUNTIME_FAILURE.ownershipDiverged,
        `the tool "${name}" is recorded as registered by this application but is not in the document's registry`,
        name,
      );
    case RESOLUTION.unknown:
      return new RuntimeError(
        RUNTIME_FAILURE.toolNotFound,
        `no tool named "${name}" is registered`,
        name,
      );
  }
}
