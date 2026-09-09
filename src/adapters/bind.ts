import type { McpToolRegistration } from '../actions/index.ts';
import { registerMcpTool } from '../actions/index.ts';
import type { ToolCallContext } from '../runtime/index.ts';

// What every store adapter in this directory shares, and it is deliberately small: exactly the two
// things an adapter adds over calling the store yourself.
//
// **1. The call resolves only after the application ACCEPTED the mutation.** A dispatch is synchronous
// and a React render is not, so a handler that dispatched and returned would report success while the
// screen still showed the old value — this system's characteristic defect
// (docs/design.md#a-call-settles-after-the-commit). Every adapter awaits `context.afterRender()`
// before it reports anything.
//
// **2. What the call APPLIED is reported through a selector the application wrote.** Not a state
// surface: exposing state for reading is `useMcpState` (docs/exposing-state.md), which requires a
// schema and names its getter as the disclosure boundary. Conflating the two would give this directory
// a second read surface with different rules and no required schema.
//
// **What is NOT here is the whole design.** No adapter accepts a store, a raw `dispatch` alone, or
// anything else that would let the AGENT choose which action runs. That choice is made once, by the
// author, at declaration — which is what keeps the reachable state space equal to "this action, under
// this schema" rather than "anything this store can do" (docs/design.md#intent-not-implementation). An
// adapter that took a store would be `redux.dispatch` with a friendlier name, and it would be one
// parameter away.

/** What every adapter takes, whatever store it is for. */
export interface StoreToolBinding {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. Validated in the runtime before the action runs, as ever. */
  readonly inputSchema?: Record<string, unknown>;
  /** What the tool promises to return, when it reports anything structured. */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * What this call applied, read AFTER the application accepted the mutation.
   *
   * Zero-argument, and that is what keeps a store out of the adapter. The obvious alternative is
   * `selectResult: (state) => state.customers.filters`; expressed here, the application closes over
   * its own store — `() => store.getState().customers.filters` — and the adapter never holds one.
   *
   * **It reports an outcome; it is not a way to expose state for inspection.** That is `useMcpState`.
   * Whatever this returns crosses to the agent unchanged: the library traverses nothing and redacts
   * nothing, exactly the rule `useMcpState` keeps (docs/exposing-state.md), so
   * `() => store.getState()` here is the same mistake it is there.
   */
  readonly selectResult?: () => unknown;
  /**
   * Availability and confirmation, declared as values and refused at invocation
   * (docs/reference-capabilities.md#per-tool-permissions). Read live at the moment of a call.
   */
  readonly permissions?: Parameters<typeof registerMcpTool>[0]['permissions'];
}

/**
 * Builds the handler every adapter shares, given the one thing that differs: how to run the action.
 *
 * `run` is supplied by the adapter and closes over what the author bound. Nothing about the arguments
 * reaches the choice of action — they are the action's INPUT, validated against the declared schema
 * before this runs.
 */
export function bindStoreTool(
  binding: StoreToolBinding,
  // **Returns `unknown`, not `void`, and it is awaited.** An action that performs a request before it
  // mutates is ordinary — and typed `void`, its promise would be discarded: the tool would report
  // success before the mutation happened, and a rejection would surface as an unhandled rejection
  // rather than as a failed call. `void` here would make the async case silently wrong, which is the
  // shape of defect this library exists to prevent.
  run: (input: Record<string, unknown>) => unknown,
): McpToolRegistration {
  return registerMcpTool({
    name: binding.name,
    description: binding.description,
    ...(binding.inputSchema === undefined ? {} : { inputSchema: binding.inputSchema }),
    ...(binding.outputSchema === undefined ? {} : { outputSchema: binding.outputSchema }),
    ...(binding.permissions === undefined ? {} : { permissions: binding.permissions }),
    handler: async (input: Record<string, unknown>, context: ToolCallContext) => {
      // Awaited, so an async action finishes before anything is reported and a rejection becomes this
      // call's failure. Awaiting a non-promise costs one microtask and changes nothing else.
      await run(input);
      // **Before anything is reported**, and this is the line that makes an adapter worth having.
      // Returning here without it would resolve the agent's call while the store had been written and
      // the screen had not caught up — a success the agent believes and a person cannot see.
      await context.afterRender();
      if (binding.selectResult === undefined) {
        // No selector: report that it ran, and invent no state shape. The same rule the runtime
        // follows for a tool that declared no output schema — structure is never fabricated for a
        // tool that did not promise one.
        return { applied: true };
      }
      return binding.selectResult();
    },
  });
}
