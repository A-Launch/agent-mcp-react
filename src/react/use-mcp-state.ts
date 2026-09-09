import { AgentMcpReactError, REACT_REFUSED } from './errors.ts';
import { type McpToolDefinition, useMcpTool } from './use-mcp-tool.ts';

// `useMcpState`: declares one named view of application state, which an agent reads back through a
// tool named `<name>.get_state` (docs/exposing-state.md).
//
// **This hook is a COMPOSITION over `useMcpTool`, and that is the design rather than an economy.**
// It derives a name, maps `schema` onto `outputSchema`, and supplies a handler that calls `getState`.
// Everything else — the handler read through a ref so a call sees the current render, the
// content-based descriptor comparison that keeps a rerender off the registry, the duplicate and
// foreign and reserved-prefix refusals, the whole gate chain, cancellation, serialization, structured
// output — is inherited BY CONSTRUCTION rather than re-derived here.
//
// Registering directly would mean writing a second answer to "how does a tool reach the registry",
// and the two would drift the first time one gained a case, with nothing failing to say so — one
// owner per truth, and everything else derived from it. Those mechanisms were also MEASURED into
// existence rather than designed — the descriptor comparison exists because comparing by identity
// cost a withdraw-and-register cycle per rerender while the registration count stayed correct — so
// the failure mode of re-deriving one subtly wrong is silence.
//
// What this module owns, and it is exactly one thing: **how a surface name becomes a tool name.**
//
// **What crosses to the agent is what `getState` returned, and nothing this library went looking
// for.** It traverses no store, scans no object graph and injects no field. That is the whole of the
// guarantee — *nothing is included automatically*, the rule set out in
// docs/reference-capabilities.md#what-the-library-redacts-and-what-it-does-not — and it is
// deliberately narrower than "the library protects you": see the note on `getState` below.

/**
 * The suffix appended to a surface's name to produce the agent-visible tool.
 *
 * One constant rather than a literal at each of the four sites that need it — the hook, its cases, the
 * documentation and the example application. A closed value is declared once and read from that one
 * declaration everywhere; a typo in any of them would produce a tool nobody can find under a name
 * that looks entirely plausible.
 *
 * **Not configurable**, and that is a decision rather than an omission: a configurable suffix makes
 * the agent-visible name unpredictable from the declaration, and the acceptance scenario in
 * docs/design.md#the-acceptance-scenario names `customers.get_state` literally.
 */
export const STATE_TOOL_SUFFIX = 'get_state';

/**
 * The agent-visible tool name for a state surface.
 *
 * The single site that performs the derivation, so the reserved-prefix check, the duplicate check and
 * every case all reason about the same string.
 */
export function stateToolName(surface: string): string {
  return `${surface}.${STATE_TOOL_SUFFIX}`;
}

export interface McpStateDefinition {
  /**
   * The surface's own name — `customers`, not `customers.get_state`.
   *
   * The agent-visible tool name is derived from it. A collision between that derived name and a tool
   * the application declared by hand is refused by the existing registration gateway, in the existing
   * duplicate vocabulary — the derivation makes a collision possible without the author having
   * written the colliding name anywhere, which is why the refusal has to name its source.
   */
  readonly name: string;
  /** What this state IS, written for an agent deciding whether to read it. */
  readonly description: string;
  /**
   * JSON Schema for the value `getState` returns. **REQUIRED**, unlike `useMcpTool`'s optional
   * `outputSchema`.
   *
   * The difference is not an inconsistency: a mutating tool's return value is incidental to what it
   * did, while a state surface's return value IS the whole thing it offers. A surface registered
   * without one would advertise a contract nothing checks and would silently widen what crosses to
   * the agent.
   *
   * **A CONTRACT, never a redactor.** It is validated exactly as authored and is never rewritten into
   * a closed variant. Declaring it does NOT stop an undeclared field reaching the agent, and a
   * declared `token: string` crosses exactly as asked.
   *
   * That was decided over the attractive alternative — synthesize `additionalProperties: false` and
   * fail on an undeclared field — because a closed schema cannot express secrecy even when perfectly
   * implemented: `user: { type: 'object' }` passes everything beneath it, and a JWT inside a declared
   * `notes: string` passes. It would also advertise one schema through the listing while enforcing
   * another, which is one contract with two authorities. Shipping a mechanism that looks like
   * protection and is not would be worse than this documented absence, because an author stops
   * looking.
   */
  readonly schema: Record<string, unknown>;
  /**
   * Returns what the agent receives. **THIS IS THE DISCLOSURE BOUNDARY.**
   *
   * Build an agent-facing value here. Do not return a store:
   *
   * ```tsx
   * // WRONG — sends the whole store, including session and tokens.
   * getState: () => store.getState()
   *
   * // RIGHT — the author chooses each field that crosses.
   * getState: () => ({ filters, sort, page, resultCount })
   * ```
   *
   * The wrong version is shorter, reads as correct and reviews as correct, which is why it is named
   * here rather than left to inference.
   *
   * Read through `useMcpTool`'s definition ref, so a call always reaches the CURRENT render's getter.
   * Getting that wrong is invisible: the call succeeds, the shape is right, the schema validates, and
   * the values are from an earlier render — and a wrong filter value looks exactly like a filter
   * value.
   *
   * It runs as the invoke step of an ordinary tool call, so it is raced against cancellation and a
   * getter that hangs cannot hang an agent.
   */
  readonly getState: () => unknown;
}

/**
 * Declares one state surface for the lifetime of the calling component.
 *
 * Publishes exactly one tool, `<name>.get_state`, as an ORDINARY Level 1 registration in the
 * document's shared tool registry — never an entry in the built-in table. That table exists precisely
 * because Level 2 and Level 3 tools must never sit in a registry every page script can reach; a Level
 * 1 entry in it would make its own stated reason false. **The consequence, which an author must know:
 * the state tool is callable by any script on the page, exactly like every other Level 1 tool — a
 * capability governs this library's bridge and not the page
 * (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page).**
 *
 * A state CHANGE sends nothing to the agent. That is not a rule this hook remembers but a consequence
 * of what it does: the change signal is driven by the registry and the ownership record, and
 * `getState`'s return value writes to neither. There is no `notifications/state_changed` in the
 * negotiated `2025-11-25` era — an agent learns new state by calling again.
 */
export function useMcpState(definition: McpStateDefinition): void {
  // **Refused synchronously, during render, before anything is enqueued** — the same position as the
  // reserved-prefix refusal and for the same reason: a declaration this incoherent should be answered
  // where it was written, not after an await that could reorder it behind an unrelated failure.
  //
  // Loud in BOTH builds, unlike a duplicate name, and the difference is what kind of mistake each is.
  // A duplicate is an ENVIRONMENTAL collision — another component or script holds the name, the page
  // runs correctly without that one tool, and tearing it down would be worse than the collision. This
  // is an INCOHERENT DECLARATION: there is no version of the page where it is right, TypeScript
  // rejects it at compile time, and it reaches a production build only through untyped consumption.
  if (definition.schema === undefined || definition.schema === null) {
    throw new AgentMcpReactError(
      REACT_REFUSED.stateSchemaMissing,
      `useMcpState("${definition.name}") was declared with no schema, so it was not registered. A state surface's return value IS its contract: declare a JSON Schema for what getState returns. The schema is validated exactly as you write it — it is a contract, not a redactor, and it does not stop an undeclared field reaching the agent.`,
    );
  }

  // The whole composition. Note what is NOT passed and why:
  //
  //   inputSchema  — a read takes no arguments, so validation is *not applicable* to this tool rather
  //                  than skipped for it, and those are not the same thing.
  //   permissions  — deliberately not offered by this surface. Nothing asks for it, `available: false`
  //                  on a read has no demonstrated use, and a field added ahead of a use is what
  //                  this project does not build ahead of a demonstrated need. The policy gate still runs; this tool simply
  //                  declares nothing for it, which means available.
  //
  // The definition object is rebuilt every render and `useMcpTool` compares it by CONTENT, so the new
  // handler identity below costs nothing — which is the entire reason this hook can be spelled this
  // simply.
  const tool: McpToolDefinition = {
    name: stateToolName(definition.name),
    description: definition.description,
    outputSchema: definition.schema,
    handler: () => definition.getState(),
  };
  useMcpTool(tool);
}
