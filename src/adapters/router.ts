import type { McpToolRegistration } from '../actions/index.ts';
import { bindStoreTool, type StoreToolBinding } from './bind.ts';

// Optional router binding (docs/store-adapters.md#navigation-is-level-1): navigation and URL-backed
// filters as declared tools.
//
// **A CORRECTION, recorded because this file used to assert the opposite.** Its placeholder comment
// said navigation was "capability-gated separately from application control". It is not, and there is
// no build in which it was: `CAPABILITY_MEMBER` is `application | dom | evaluate` and nothing else.
// **Navigation is Level 1, like every other application action.** An adapter documenting a gate the
// library does not have is worse than no adapter, because an operator reads it and believes a route
// is separately withheld.
//
// The observation UNDERNEATH that claim is true and worth keeping: **navigating does change which
// tools exist**, because a route change unmounts the components that declared them, and an agent that
// navigates may find the tool it was about to call has gone. That is a real property of this library
// and a reason to prefer domain-specific navigation. It is not a reason for a fourth capability — a
// different KIND of authority would be, and this is a riskier action rather than a different kind.
//
// **To withhold a particular route, declare it unavailable**: `permissions: { available: false }`, or
// `confirmation: 'required'` where a person should be in the loop. That is per-tool policy, refused at
// invocation, and it is the mechanism that actually exists.
//
// Typed STRUCTURALLY: no router library is imported here and none is a dependency.

/** The shape of a navigate function, structurally — a path in, anything out. */
export type Navigate = (path: string) => unknown;

export interface NavigationToolBinding extends StoreToolBinding {
  /** The application's own navigate. The same one its links and buttons call. */
  readonly navigate: Navigate;
  /**
   * Turns the call's validated arguments into a path.
   *
   * **Prefer a domain intent over a path the agent constructs**
   * (docs/store-adapters.md#navigation-is-level-1). `customers.open` taking `{ customerId }` and
   * building `/customers/cus_123` here is better than `navigation.go` taking a
   * path, because the agent cannot then invent an internal URL, and the schema can say what a valid
   * customer id is. The path form remains available for a genuinely generic navigator.
   */
  readonly toPath: (input: Record<string, unknown>) => string;
}

/**
 * Declares one tool that navigates.
 *
 * Level 1, like any application action. The call resolves only after the application accepted the
 * navigation, so an agent that navigates and then lists tools sees the tool set the new route
 * actually has rather than the one it was leaving.
 */
export function bindNavigationTool(binding: NavigationToolBinding): McpToolRegistration {
  // Returned rather than discarded: a router's navigate may be asynchronous, and an agent that
  // navigates and then lists tools must see the set the NEW route has.
  return bindStoreTool(binding, (input) => binding.navigate(binding.toPath(input)));
}

export interface UrlFilterToolBinding extends StoreToolBinding {
  /**
   * Applies the call's arguments to the current query string, through the application's OWN router.
   *
   * The design requires that where query parameters are the canonical state, an MCP action updates
   * the URL rather than maintaining state beside it. Two copies of one truth is the defect this avoids
   * — the URL and a shadow object drift, and whichever the page reads is right by accident. One owner
   * per truth, and here the URL is the owner.
   *
   * The adapter deliberately does not build the query string: an application's own encoding of arrays,
   * ranges and empties is not this library's to guess, and guessing it would produce URLs a person
   * cannot reproduce through the UI.
   */
  readonly applyToUrl: (input: Record<string, unknown>) => unknown;
}

/**
 * Declares one tool that changes URL-backed filters, where the URL is the canonical state.
 *
 * Separate from `bindNavigationTool` because the two are different intents: one moves the page, the
 * other narrows what is on it. An agent choosing between them from their descriptions should not have
 * to guess which a path change means.
 */
export function bindUrlFilterTool(binding: UrlFilterToolBinding): McpToolRegistration {
  return bindStoreTool(binding, (input) => binding.applyToUrl(input));
}
