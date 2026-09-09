import type { ControlLevel, DeclaredPermissions, DomAuthority } from '../security/index.ts';
import type { ToolHandler } from './ownership.ts';
import type { CompiledSchema } from './validation.ts';

// The second source of callable tools: the ones this library ships rather than the ones an application
// registered.
//
// **Why a second table exists at all, when the document's registry already holds tools.** Levels 2 and
// 3 MUST NEVER be in that registry — a security invariant, listed in
// `docs/design.md#security-invariants` and explained for the DOM tools in `docs/dom-inspection.md`
// and for evaluation in `docs/javascript-evaluation.md`. It is shared with every script on the
// page, and anything in it is invokable by any of them with not one of this library's gates in the
// path. A `dom.click` sitting there would be a page-wide remote control that a capability could not
// take back. So the route for those tools bypasses the registry entirely — which means the runtime
// needs somewhere else to find them, and that is this.
//
// **A level comes from the table a tool was found in, never from its name.** `RESERVED_PREFIX` is a
// collision guard so the two namespaces stay legible to a reader; it is not the boundary, and a typo
// in a name cannot promote anything. A tool is Level 2 because it is in this table and says so.
//
// **This module ships no entries of its own**, and that is the deliverable rather than a gap: what
// ships here is the route, the level assignment and the gate over them. `src/dom/` supplies the Level
// 2 entries and `runtime.evaluate` the Level 3 one, each through the same door, and each must prove
// its own integration — the cases here drive a synthetic built-in and are not proof of theirs.

/**
 * One tool this library ships.
 *
 * It carries its own control level and, for a Level 2 tool, which half of the DOM capability it needs.
 * Both are declared by whoever writes the entry rather than derived from anything, because deriving
 * them is what would make a naming convention into the control boundary.
 */
export interface BuiltInTool {
  readonly name: string;
  /** Which control level admits it. Read by the capability gate; never inferred from the name. */
  readonly level: ControlLevel;
  /**
   * Which half of the DOM capability a Level 2 tool needs. Absent at any other level.
   *
   * A Level 2 entry that omits it is refused by BOTH halves rather than admitted by the weaker one —
   * so the failure of forgetting it is a tool nobody can call, not a tool everybody can.
   */
  readonly domAuthority?: DomAuthority;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  /**
   * The compiled schemas that gate it.
   *
   * Compiled by whoever builds the table, not here — this module holds no validator and reaching for
   * one would put a compilation step inside a constant. A built-in that declares a schema and arrives
   * with no matching validator is refused at construction: advertising a contract nothing checks is
   * exactly the condition runtime validation exists to end, and it applies to this library's own
   * tools exactly as it applies to an application's.
   */
  readonly validators?: {
    readonly input?: CompiledSchema;
    readonly output?: CompiledSchema;
  };
  /**
   * What this library declares about reaching it, beyond its level.
   *
   * A built-in can require confirmation — `runtime.evaluate` is the obvious candidate — and it reaches
   * the same gate an application's tool does, through the same supplier. It is a constant here rather
   * than something that changes: a built-in's permissions are a property of the build, not of
   * application state.
   */
  readonly permissions?: DeclaredPermissions;
  readonly handler: ToolHandler;
}

/** The table, keyed by name, so resolution is a lookup rather than a scan on every call. */
export type BuiltInTable = ReadonlyMap<string, BuiltInTool>;

/**
 * Builds the table, refusing anything that would be callable under a contract nothing enforces.
 *
 * Throws rather than reporting, because a malformed entry is THIS LIBRARY'S bug in a build-time
 * constant — not an application's mistake and not a runtime condition. There is no destination for it
 * that an embedder could act on, and there is no state in which shipping it would be better than
 * refusing to start.
 */
export function buildBuiltInTable(tools: readonly BuiltInTool[]): BuiltInTable {
  const table = new Map<string, BuiltInTool>();

  for (const tool of tools) {
    if (table.has(tool.name)) {
      throw new Error(`two built-in tools are named "${tool.name}"`);
    }
    if (tool.inputSchema !== undefined && tool.validators?.input === undefined) {
      throw new Error(
        `the built-in tool "${tool.name}" declares an input schema with no compiled validator, so the contract it advertises would not be checked`,
      );
    }
    if (tool.outputSchema !== undefined && tool.validators?.output === undefined) {
      throw new Error(
        `the built-in tool "${tool.name}" declares an output schema with no compiled validator, so the contract it advertises would not be checked`,
      );
    }
    table.set(tool.name, tool);
  }

  return table;
}
