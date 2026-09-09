// The revision of the browser tool-registry standard this boundary is written against.
//
// This is a record, not a runtime check. Nothing in this library reads it to make a decision, and no
// version negotiation happens anywhere — the point is that a maintainer comparing this module against
// a published revision can see, without reading code, which draft its behaviour assumes.
//
// It exists because the standard is a draft that has already moved twice in ways this module depends
// on, and a divergence that nothing records is a divergence that surfaces as a runtime failure in a
// browser channel nobody tested.

/**
 * The draft this module's behaviour assumes, and the two changes that produced the shape it relies on.
 *
 * Both entries are load-bearing rather than historical trivia:
 *
 * - Withdrawal is abort-only because the April 2026 draft removed the unregister operation. This
 *   module therefore exposes no unregister, and never calls the deprecated one the portability layer
 *   still carries.
 * - The registry is reached on the document because the May 2026 draft moved it there. The earlier
 *   host object is tolerated at this boundary and nowhere else.
 */
export const TARGETED_REVISION = {
  /** The draft this module is written against, as a date a maintainer can look up. */
  draft: '2026-05-27',
  /** Where the specification lives. */
  specification: 'https://webmachinelearning.github.io/webmcp/',
  /** The changes this module's shape depends on. */
  dependsOn: [
    {
      draft: '2026-04-23',
      change: 'unregisterTool removed in favour of registerTool(tool, { signal })',
    },
    {
      draft: '2026-05-27',
      change: 'the modelContext getter moved from Navigator to Document',
      reference: 'https://github.com/webmachinelearning/webmcp/pull/184',
    },
  ],
} as const;
