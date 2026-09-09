import type { McpToolRegistration } from '../actions/index.ts';
import { bindStoreTool, type StoreToolBinding } from './bind.ts';

// Optional Redux binding (docs/store-adapters.md): a thin, deletable translation from one action
// creator to one tool.
//
// **It binds ONE creator, and never a store.** That is the whole of what keeps "intent, never an
// implementation operation" (docs/design.md#intent-not-implementation) structural rather than
// advisory. The reachable state space is exactly what the bound creator plus its declared schema
// admit — an agent cannot choose a different action, because the choice was made once, by the author,
// at declaration. An adapter that accepted a `store`, or a bare `dispatch` as the mutation, would let
// the agent reach every action the store has ever had under one schema that cannot describe them.
// That is `redux.dispatch` with a friendlier name, and it is one parameter away.
//
// Typed STRUCTURALLY: this module imports nothing from Redux, and Redux is not a dependency of this
// package. `Dispatch` and `ActionCreator` below are the shapes, not the library's types.
//
// **Nothing here is required to use Redux with this library.** The design's own primary example
// (docs/store-adapters.md#you-do-not-need-an-adapter) is `useMcpTool` with a dispatch inside the
// handler, which works today with nothing imported from here.
// This exists for a tool the application SHELL owns rather than a screen, and for the two things it
// adds: resolving only after the application accepted the mutation, and reporting what was applied.

/** The shape of `store.dispatch`, structurally. Never the store. */
export type ReduxDispatch<A> = (action: A) => unknown;

/** The shape of an action creator: arguments in, one action out. */
export type ReduxActionCreator<A> = (input: Record<string, unknown>) => A;

export interface ReduxToolBinding<A> extends StoreToolBinding {
  /**
   * `store.dispatch`, and nothing else off the store.
   *
   * Handing this over does not widen what an agent can reach, because the agent never chooses what is
   * dispatched — `action` below decides that, once, at declaration.
   */
  readonly dispatch: ReduxDispatch<A>;
  /**
   * The ONE action creator this tool runs.
   *
   * It receives the call's validated arguments and returns the action to dispatch. Bind a real
   * creator from your slice — the same one your UI's own control uses — so there is no path an agent
   * can take that a person cannot.
   */
  readonly action: ReduxActionCreator<A>;
}

/**
 * Declares one tool that dispatches one bound Redux action.
 *
 * Owned by the application shell rather than a component, and therefore registered through the
 * imperative path: it survives a provider remount and is withdrawn only by `remove()`.
 */
export function bindReduxTool<A>(binding: ReduxToolBinding<A>): McpToolRegistration {
  // Returned rather than discarded: a middleware-wrapped `dispatch` may hand back a promise (thunks,
  // sagas, RTK Query), and awaiting it is what makes "the call resolves after the application accepted
  // the mutation" true for an async action rather than only for a synchronous one.
  return bindStoreTool(binding, (input) => binding.dispatch(binding.action(input)));
}
