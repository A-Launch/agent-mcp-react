import {
  type AgentCapabilities,
  CONTROL_LEVEL,
  type ControlLevel,
  type DomAuthority,
  REFUSED_BECAUSE,
  type RefusedBecause,
} from './vocabulary.ts';

// Whether a call may proceed — decided, never performed.
//
// **This module does no I/O and knows nothing about how a call arrives.** No registry, no React, no
// store, no clock, no `await`. Every input is passed in, so every branch is reachable from a table and
// the negative suite over it is exhaustive rather than illustrative.
//
// **The gates that USE this live in the runtime, not here.** A module that decides whether it may run
// is a module that can be imported past its own check — which is the same reason the DOM capability
// gate does not live in `src/dom/`.
//
// One thing this file cannot say, and the documentation says it everywhere instead: a decision here
// governs **this library's bridge**. A Level 1 tool sits in the document's shared registry and any
// script in the page can invoke it with none of this in the path
// (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page).

/** Admitted, or refused with a cause. Never a warning — an undeterminable answer is a refusal. */
export type Decision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly because: RefusedBecause };

const ADMITTED: Decision = { admitted: true };

function refuse(because: RefusedBecause): Decision {
  return { admitted: false, because };
}

/**
 * What a tool declared about itself, as far as a decision is concerned.
 *
 * `risk` is absent on purpose. It enforces nothing — enforcement is availability and confirmation —
 * and it cannot be transmitted, because the MCP annotations schema admits five named hints and strips
 * anything else. A field declared, held, sent nowhere and read by nothing is an inert promise; it
 * arrives with the surface that reads it.
 */
export interface DeclaredPermissions {
  /**
   * Whether the application currently offers this tool. Absent means available.
   *
   * A declared value rather than a function consulted at call time. A callback would be application
   * code running inside a gate, could not be prevented from widening by side effect, would
   * emit no change signal for the agent to learn from, and would be the one check the shared-registry
   * route does not share — so a domain rule moved into it would stop applying to every page script.
   */
  readonly available?: boolean;
  /** Whether an operator must approve before the handler runs. */
  readonly confirmation?: 'required';
}

/**
 * Whether this connection's capability set admits a control level.
 *
 * Invariant: **one level confers nothing on another.** `application` does not admit DOM, reading the
 * page does not admit acting on it, and nothing short of `evaluate` admits Level 3. The read-only
 * agent profile is exactly `inspect: true, interact: false`, which is why `dom` is a pair rather than
 * a boolean (docs/reference-capabilities.md#the-shape).
 *
 * Level 2 takes a second argument because a DOM tool is admitted by one half of the pair or the other,
 * and which half is a property of the tool rather than of the level.
 */
export function admitsLevel(
  capabilities: AgentCapabilities,
  level: ControlLevel,
  domAuthority?: DomAuthority,
): Decision {
  if (level === CONTROL_LEVEL.application) {
    return capabilities.application ? ADMITTED : refuse(REFUSED_BECAUSE.capabilityDenied);
  }

  if (level === CONTROL_LEVEL.dom) {
    // An unstated half is not a grant. A DOM tool that did not say which authority it needs cannot be
    // admitted by either, because admitting it under the weaker one would let a future tool land in
    // the wrong half silently, and a silent landing is a hidden unknown.
    if (domAuthority === undefined) return refuse(REFUSED_BECAUSE.capabilityDenied);
    // **Indexed by the authority, never a two-way branch on one of them.** `inspect ? a : b` reads
    // identically and means something different the day a third authority exists: it would compile,
    // and every tool needing the new one would be admitted by whatever `interact` happened to be.
    return capabilities.dom[domAuthority] ? ADMITTED : refuse(REFUSED_BECAUSE.capabilityDenied);
  }

  if (level === CONTROL_LEVEL.evaluate) {
    return capabilities.evaluate ? ADMITTED : refuse(REFUSED_BECAUSE.capabilityDenied);
  }

  // A level outside the closed set. Refused rather than allowed to fall through — authority only
  // narrows, so a decision that cannot be computed is a denial, never an admission with a warning.
  return refuse(REFUSED_BECAUSE.capabilityDenied);
}

/**
 * Whether the application currently offers this tool.
 *
 * Absent means available, which is the only reading that does not make every existing declaration
 * unavailable — and it is not the "absent is denied" rule inverted, because that rule is about
 * capabilities, where absence means an operator did not grant something. Here absence means an
 * application said nothing about a tool it went to the trouble of declaring.
 */
export function admitsAvailability(permissions: DeclaredPermissions | undefined): Decision {
  return permissions?.available === false ? refuse(REFUSED_BECAUSE.unavailable) : ADMITTED;
}

/** Whether this tool needs an operator's approval before its handler runs. */
export function needsConfirmation(permissions: DeclaredPermissions | undefined): boolean {
  return permissions?.confirmation === 'required';
}
