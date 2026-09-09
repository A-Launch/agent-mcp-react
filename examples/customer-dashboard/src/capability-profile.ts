import type { AgentCapabilities } from 'agent-mcp-react';

// Which capability profile this page grants, chosen by an operator at start-up.
//
// **This exists so a capability REFUSAL can be driven in a real browser.** Until now the demonstrator
// hardcoded Level 1, every tool in it was Level 1, and `src/dom/` is a placeholder — so there was
// nothing a live agent could be refused BY. Every capability denial in this repository was covered by
// the suites and by nothing else.
//
// The variable was named in `.env.example` and read by nothing. That is worse than an absent knob: an
// operator could set it, watch nothing change, and conclude the gate did not work — a hidden unknown,
// where an unexpected state has to fail loud.
//
// **What is observable today, stated exactly.** There are Level 2 read tools, so every member has
// tools behind it. `inspect` grants the read tools, `developer` adds the write
// tools, and `evaluate` adds Level 3 — which is a separate profile rather than part of `developer`,
// because bundling arbitrary code execution with "the developer preset" is how it ends up somewhere
// nobody meant it to be.

/**
 * The profiles an operator may select, as a closed set: declared once here, with the type and the
 * membership check below derived from it rather than re-spelled anywhere.
 *
 * `read-only` from the original `.env.example` is deliberately NOT here. A capability is per-LEVEL, so
 * no combination of these members can express "may read but not write" — that distinction is per-tool
 * (`permissions.available`) and belongs to the application. A profile name promising it would have
 * been a name the model cannot keep.
 */
export const CAPABILITY_PROFILE = {
  /**
   * Nothing granted. Every bridged call is refused at the capability step.
   *
   * **The one that makes the gate visible.** The tools stay registered in the document and stay
   * callable by any script on the page — which is the pairing that shows a capability governs this
   * library's bridge and not the page
   * (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page).
   */
  none: 'none',
  /** Level 1 only: the application's own tools. What this page has always granted, and the default. */
  standard: 'standard',
  /**
   * Level 1 plus reading the page — `application` and `dom.inspect`, and nothing that acts.
   *
   * **The profile the documentation recommends for an agent that must cope with uninstrumented
   * flows**, and the one that makes the two halves of the DOM capability visibly different: the agent
   * can describe this page and cannot touch it. `dom.interact` is withheld and stays withheld here.
   */
  inspect: 'inspect',
  /**
   * Level 1 plus both halves of the DOM capability — reading the page and acting on it.
   *
   * Every flag it sets has tools behind it.
   */
  developer: 'developer',
  /**
   * Everything, **including `runtime.evaluate`**.
   *
   * **Never the default of anything, and never a profile an embedder copies without reading
   * docs/javascript-evaluation.md.**
   * Level 3 is equivalent to arbitrary code execution in this page's origin: the DOM, application
   * globals, storage, same-origin requests, and any non-HttpOnly credential this page can reach. It is
   * present here so an operator can watch the gate work — the refusal under every other profile, and
   * the confirmation a person answers under this one — and for no other reason.
   *
   * A tool an agent needs is instrumented as a Level 1 tool. This is never enabled to unblock a task:
   * the three levels are separate layers, one confers nothing on another, and widening this one is the
   * change whose blast radius is the whole page.
   */
  evaluate: 'evaluate',
} as const;

export type CapabilityProfile = (typeof CAPABILITY_PROFILE)[keyof typeof CAPABILITY_PROFILE];

/** Membership derived from the dictionary, so a new profile cannot be half-added. */
const PROFILES: ReadonlySet<string> = new Set(Object.values(CAPABILITY_PROFILE));

function isProfile(value: string): value is CapabilityProfile {
  return PROFILES.has(value);
}

const GRANTS: Readonly<Record<CapabilityProfile, AgentCapabilities>> = {
  [CAPABILITY_PROFILE.none]: {
    application: false,
    dom: { inspect: false, interact: false },
    evaluate: false,
  },
  [CAPABILITY_PROFILE.standard]: {
    application: true,
    dom: { inspect: false, interact: false },
    evaluate: false,
  },
  [CAPABILITY_PROFILE.inspect]: {
    application: true,
    dom: { inspect: true, interact: false },
    evaluate: false,
  },
  [CAPABILITY_PROFILE.developer]: {
    application: true,
    dom: { inspect: true, interact: true },
    evaluate: false,
  },
  [CAPABILITY_PROFILE.evaluate]: {
    application: true,
    dom: { inspect: true, interact: true },
    evaluate: true,
  },
};

/**
 * The profile this page is running under, and what it grants.
 *
 * **An unrecognised value throws rather than falling back.** A typo that quietly became `standard`
 * would hand an agent capabilities the operator believed they had withheld — and it would look
 * exactly like a working deployment. That is exactly the convenience default this project forbids,
 * and it
 * is the same reasoning that makes the provider's `capabilities` prop required with no default.
 *
 * An ABSENT value is different from a wrong one: nothing was chosen, so the documented default
 * applies. The two are not the same and are not treated the same.
 */
export function selectedProfile(): { profile: CapabilityProfile; grants: AgentCapabilities } {
  const requested = import.meta.env.AMR_CAPABILITIES;

  if (requested === undefined || requested === '') {
    return {
      profile: CAPABILITY_PROFILE.standard,
      grants: GRANTS[CAPABILITY_PROFILE.standard],
    };
  }
  if (!isProfile(requested)) {
    throw new Error(
      `AMR_CAPABILITIES="${requested}" is not a profile this page offers. ` +
        `Choose one of: ${Object.values(CAPABILITY_PROFILE).join(', ')}. ` +
        'It is refused rather than defaulted, because a typo that silently granted the standard ' +
        'profile would hand an agent capabilities you believed you had withheld.',
    );
  }
  return { profile: requested, grants: GRANTS[requested] };
}
