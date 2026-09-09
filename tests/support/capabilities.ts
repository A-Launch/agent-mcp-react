import type { AgentCapabilities } from '../../src/index.ts';

// The capability sets the suites mount providers with.
//
// **Named rather than inlined, and named rather than defaulted.** The library ships no default profile
// — there is no default profile, and a test helper that supplied one would be that default arriving through the
// back door, quietly granting whatever a future member happens to add. These are explicit sets a case
// opts into, and each one says what it grants.
//
// A case that is ABOUT a capability writes its own literal instead of importing one of these. Reading
// the granted set at the assertion is the whole point of such a case, and a name would hide it.

/**
 * What almost every case here wants: an agent that may call the application's own tools, and nothing
 * else.
 *
 * It is also the profile the documentation recommends. Level 2 and Level 3 are withheld, which is what
 * makes the suite's Level 1 cases a test of Level 1 rather than of a page with everything switched on.
 */
export const APPLICATION_ONLY: AgentCapabilities = {
  application: true,
  dom: { inspect: false, interact: false },
  evaluate: false,
};

/**
 * An agent granted nothing.
 *
 * Every bridged call is refused; every tool stays registered in the document and reachable by any
 * script on the page. That pairing — refused for the agent, callable in the page — is the difference
 * between a capability and a withdrawal, and it is asserted rather than assumed.
 */
export const NOTHING_GRANTED: AgentCapabilities = {
  application: false,
  dom: { inspect: false, interact: false },
  evaluate: false,
};
