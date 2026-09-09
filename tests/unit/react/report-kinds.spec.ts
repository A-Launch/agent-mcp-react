import { describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { CLAIM_REFUSED, REGISTRATION_REFUSED } from '../../../src/webmcp/index.ts';

// The provider's unexpected-state destination now carries two kinds of report, and a receiver has to
// tell them apart to respond correctly: a registry-integrity alarm means this library's bookkeeping is
// broken, while a contested name in a production build means two things want one name and the
// application is otherwise fine. Those call for different responses from an operator.
//
// The requirement is that the distinction survives on `code` alone. Reading a message string to decide
// what happened is how a wording change becomes an outage.

/**
 * The only runtime cause that reaches the destination.
 *
 * The runtime raises six causes; five of them are refusals returned to the agent, and exactly one is
 * reported to the operator. Named here rather than derived, because "which of these reaches the
 * destination" is a property of the runtime's code paths and a derived set would be a second statement
 * of it that can drift.
 */
const REACHES_DESTINATION_FROM_RUNTIME = [RUNTIME_FAILURE.ownershipDiverged] as const;

/** What a contested name reports with, in a production build. */
const REACHES_DESTINATION_FROM_REGISTRATION = [
  REGISTRATION_REFUSED.nameHeldByThisApplication,
  REGISTRATION_REFUSED.nameHeldByForeignOwner,
] as const;

describe('the codes reaching the unexpected-state destination', () => {
  it('do not overlap, so a receiver can branch on the code alone', () => {
    const fromRuntime = new Set<string>(REACHES_DESTINATION_FROM_RUNTIME);
    const overlapping = REACHES_DESTINATION_FROM_REGISTRATION.filter((code) =>
      fromRuntime.has(code),
    );

    expect(
      overlapping,
      `these codes could arrive from either kind of report, so a receiver cannot tell a broken invariant from a contested name: ${overlapping.join(', ')}`,
    ).toEqual([]);
  });

  it('are each a member of the dictionary that owns them', () => {
    // Guards against the distinction being kept by a literal written here rather than by the closed
    // sets. A code renamed in its dictionary must fail here, not drift silently.
    for (const code of REACHES_DESTINATION_FROM_RUNTIME) {
      expect(Object.values(RUNTIME_FAILURE)).toContain(code);
    }
    for (const code of REACHES_DESTINATION_FROM_REGISTRATION) {
      expect(Object.values(REGISTRATION_REFUSED)).toContain(code);
    }
  });

  it('records that the two dictionaries DO share a code that must never both reach here', () => {
    // A real overlap, found while writing this: the runtime and the boundary both use
    // `MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER`, for the same underlying condition at different moments —
    // an agent calling a foreign name, and this application trying to register one.
    //
    // Today it is harmless, because the runtime's version is returned to the agent as a refusal and
    // never reported to the operator. The case exists so that a future feature which starts forwarding
    // the runtime's foreign refusal to the destination discovers the ambiguity HERE, rather than an
    // operator discovering it as an alarm that could mean either thing.
    expect(RUNTIME_FAILURE.nameHeldByForeignOwner).toBe(
      REGISTRATION_REFUSED.nameHeldByForeignOwner,
    );
    expect(REACHES_DESTINATION_FROM_RUNTIME).not.toContain(RUNTIME_FAILURE.nameHeldByForeignOwner);
  });

  it('excludes the claim refusal, which travels the throw channel and never this one', () => {
    const fromRuntime = new Set<string>(REACHES_DESTINATION_FROM_RUNTIME);
    const fromRegistration = new Set<string>(REACHES_DESTINATION_FROM_REGISTRATION);
    expect(fromRuntime.has(CLAIM_REFUSED.providerAlreadyActive)).toBe(false);
    expect(fromRegistration.has(CLAIM_REFUSED.providerAlreadyActive)).toBe(false);
  });
});
