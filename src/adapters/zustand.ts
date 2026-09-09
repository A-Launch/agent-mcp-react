import type { McpToolRegistration } from '../actions/index.ts';
import { bindStoreTool, type StoreToolBinding } from './bind.ts';

// Optional Zustand binding (docs/store-adapters.md): one store action, one tool.
//
// **The difference from the Redux adapter is real and is the only reason this is a separate module.**
// Redux composes a creator with a dispatcher — `dispatch(creator(args))`. A Zustand action is already
// a function on the store — `store.getState().setFilters(args)` — so there is nothing to compose. Two
// modules that differed only by a rename would be a second way to spell one thing, which one owner
// per truth forbids; these differ in what they do with what they are given.
//
// The design permits a Zustand integration registered outside React, because a Zustand action is
// reachable without a component. This module is that path, and it is why nothing in this directory
// imports the renderer.
//
// Typed STRUCTURALLY: Zustand is not a dependency of this package and is not imported here.

/** The shape of a bound store action: validated arguments in, whatever it returns ignored. */
export type ZustandAction = (input: Record<string, unknown>) => unknown;

export interface ZustandToolBinding extends StoreToolBinding {
  /**
   * The ONE action this tool runs, already bound to your store.
   *
   * Write it as `(input) => useCustomerStore.getState().setFilters(input)` — the same setter your UI
   * calls. The store itself is never handed over, so an agent cannot reach a different action: the
   * choice was made once, by the author, at declaration
   * (docs/design.md#intent-not-implementation).
   */
  readonly action: ZustandAction;
}

/**
 * Declares one tool that runs one bound Zustand action.
 *
 * Owned by the application shell rather than a component, so it survives a provider remount and is
 * withdrawn only by `remove()`.
 */
export function bindZustandTool(binding: ZustandToolBinding): McpToolRegistration {
  // Returned rather than discarded, so an action that awaits a request before mutating finishes
  // before the tool reports anything.
  return bindStoreTool(binding, (input) => binding.action(input));
}
