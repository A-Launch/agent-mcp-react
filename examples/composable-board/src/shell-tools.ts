import type { ToolCallContext } from '@agent-mcp/react';
import { registerMcpTool } from '@agent-mcp/react/actions';
import { actionNamesFor, CATALOG } from './catalog/kinds.ts';
import {
  DATA_SOURCES,
  isDataSourceName,
  isPanelKind,
  MAX_PANELS,
  PANEL_KINDS,
  type PanelKind,
} from './catalog/vocabulary.ts';
import { addPanels, currentPanels, removePanel, reorderPanel } from './state/board.ts';

// The three composition tools, declared by the application SHELL at module scope — before React mounts,
// and outside every component (docs/tools-outside-react.md).
//
// **They are here rather than in a component because their owner is the document, not a screen.** The
// board exists before any panel does and outlives every one of them; a tool that appeared only once
// something rendered would be a tool that lies about being ready. That is also why the board store lives
// at module scope: a handler running at import time cannot read a React context.
//
// **This module must be imported for its SIDE EFFECT**, by the page's entry point and by any test
// harness that drives it. Nothing else references it. Forget the import and these three tools are never
// declared at all — and the symptom is an empty tool list rather than an error, which is the hidden
// unknown this project refuses.
//
// Every schema below is CLOSED. `additionalProperties: false` at the root and at each nested object,
// because JSON Schema admits undeclared properties by default: a schema without it advertises a contract
// the runtime does not enforce, and an agent's stray field would pass validation and then be ignored.
//
// What these tools do NOT accept, and it is the design decision the rest of the feature rests on:
// settings. A create call that took a per-kind settings object would be polymorphic in its own argument,
// and the only honest schema for that is a discriminated union — the shape a generic mutation tool
// wears. Panels start at their kind's defaults and are configured through their own actions.

/**
 * Wraps a handler so a refusal reaches the agent as a RESULT rather than as an exception.
 *
 * **This is a library contract, not a preference, and it was measured rather than assumed.** A handler
 * that throws has its message replaced with a generic `MCP_TOOL_EXECUTION_ERROR: the tool "…" failed
 * while running`; the original text is appended only when `NODE_ENV=development`. That suppression is
 * CORRECT — an exception can carry internals, a stack, or a value the agent was never meant to see, and
 * the library's security invariants forbid sending those from a production build
 * (docs/design.md#security-invariants).
 *
 * The consequence for an application is the part worth remembering: **guidance the agent should act on
 * has to be RETURNED.** "That kind does not accept that source, it accepts these" is information, not a
 * crash — the same distinction `tools/mock-agent`'s chat loop already draws when it feeds a failed tool
 * result back to the model instead of ending the turn. A refusal is something the application chooses
 * to disclose, exactly as `getState` is, and an exception is the thing it must not leak.
 *
 * Found by three cases in `board-compose.spec.tsx` that asserted on a message the agent never received.
 */
function refusing<T extends Record<string, unknown>>(
  handler: (input: Record<string, unknown>, context: ToolCallContext) => Promise<T>,
): (input: Record<string, unknown>, context: ToolCallContext) => Promise<Record<string, unknown>> {
  return async (input, context) => {
    try {
      return { ...(await handler(input, context)), ok: true };
    } catch (cause) {
      // Only the message, and only one the application wrote. No stack, no cause chain, no received
      // value — the store's refusals are authored to name the permitted set and nothing else.
      return { ok: false, refused: cause instanceof Error ? cause.message : String(cause) };
    }
  };
}

/** One created panel, as `board.add_panel` reports it. */
interface CreatedPanel {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly actions: readonly string[];
}

const CREATED_PANEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'source', 'actions'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    source: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const addPanelTool = registerMcpTool({
  name: 'board.add_panel',
  title: 'Add panels to the board',
  description:
    'Puts one or more panels on the board. Each entry names a panel KIND and the named DATA SOURCE ' +
    `it reads. Kinds: ${PANEL_KINDS.join(', ')}. Sources: ${DATA_SOURCES.join(', ')}. Not every kind ` +
    'accepts every source; a refusal names the ones it does. Panels start with sensible defaults and ' +
    'are configured afterwards through their own actions, which the result lists. You do not choose ' +
    'panel identifiers — the board mints them and reports them back. ' +
    `A board holds at most ${String(MAX_PANELS)} panels. ` +
    'When a request cannot be met this returns `ok: false` with a `refused` message naming what WOULD ' +
    'have been accepted — read it and adjust rather than repeating the call.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['panels'],
    properties: {
      panels: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PANELS,
        description: 'The panels to add. Either all of them are added or none is.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'source'],
          properties: {
            kind: { type: 'string', enum: PANEL_KINDS as readonly string[] },
            source: { type: 'string', enum: DATA_SOURCES as readonly string[] },
          },
        },
      },
      position: {
        type: 'integer',
        minimum: 0,
        description: 'Where the batch lands in the board order. Appended to the end when omitted.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      refused: { type: 'string' },
      created: { type: 'array', items: CREATED_PANEL_SCHEMA },
      order: { type: 'array', items: { type: 'string' } },
      panelCount: { type: 'integer' },
    },
  },
  handler: refusing(async (input, context) => {
    // No shape checks here. The declared schema is enforced in the runtime before this runs, and a
    // handler that re-checked it would be a second place for the two to disagree. What IS checked is
    // semantic: the kind/source pair, and the ceiling — neither of which a schema can express.
    const requested = input.panels as readonly { kind: string; source: string }[];
    const entries = requested.map((entry) => {
      // The guards are not redundant with the schema's `enum`: they are what turns two validated strings
      // into the union types the store takes, without an `as`-cast onto a type that does not admit them.
      if (!isPanelKind(entry.kind)) {
        throw new Error(
          `"${entry.kind}" is not a panel kind — this board offers: ${PANEL_KINDS.join(', ')}`,
        );
      }
      if (!isDataSourceName(entry.source)) {
        throw new Error(
          `"${entry.source}" is not a data source — this board offers: ${DATA_SOURCES.join(', ')}`,
        );
      }
      return { kind: entry.kind, source: entry.source };
    });

    const created = addPanels(entries, input.position as number | undefined);

    // **Resolves only once the panels are on screen.** Returning after the store call would report a
    // count the person cannot yet see, which is this system's characteristic defect.
    //
    // What this does NOT promise, and the comment is here so a future reader does not assume it: that
    // the actions listed below are callable yet. The barrier is about RENDERING. Each panel starts its
    // own registration in an effect during that commit, and `registerTool()` resolves asynchronously
    // afterwards. A call that arrives too early is refused as a missing tool, which is honest and
    // retryable. There is deliberately no poll, retry or timeout here to paper over the gap.
    await context.afterRender();

    const report: CreatedPanel[] = created.map((panel) => ({
      id: panel.id,
      kind: panel.kind,
      source: panel.source,
      actions: actionNamesFor(panel.kind, panel.id),
    }));

    return {
      created: report,
      order: currentPanels().map((panel) => panel.id),
      panelCount: currentPanels().length,
    };
  }),
});

export const removePanelTool = registerMcpTool({
  name: 'board.remove_panel',
  title: 'Remove a panel from the board',
  description:
    'Takes one panel off the board by its identifier. The identifiers are reported when a panel is ' +
    'created and by board.get_state. Removing a panel also takes away that panel’s own actions. ' +
    'Returns `ok: false` with a `refused` message naming the ids that ARE on the board when the one ' +
    'you named is not.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', description: 'The panel identifier, for example "table-1".' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      refused: { type: 'string' },
      removed: { type: 'string' },
      order: { type: 'array', items: { type: 'string' } },
      panelCount: { type: 'integer' },
    },
  },
  handler: refusing(async (input, context) => {
    const removed = removePanel(input.id as string);
    await context.afterRender();
    return {
      removed: removed.id,
      order: currentPanels().map((panel) => panel.id),
      panelCount: currentPanels().length,
    };
  }),
});

export const reorderPanelTool = registerMcpTool({
  name: 'board.reorder',
  title: 'Move a panel up or down the board',
  description:
    'Moves one panel to a new position in the board order. Position 0 is the top. This changes only ' +
    'the order — no panel is created or destroyed, and no panel’s actions change. Returns ' +
    '`ok: false` with a `refused` message when the panel you named is not on the board.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'position'],
    properties: {
      id: { type: 'string' },
      position: { type: 'integer', minimum: 0, description: '0 is the top of the board.' },
    },
  },
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      refused: { type: 'string' },
      order: { type: 'array', items: { type: 'string' } },
    },
  },
  handler: refusing(async (input, context) => {
    // **Registers and withdraws nothing.** Identity does not move with position — ids come from a
    // counter, and the rendered list is keyed by id — so the tool set after this call is byte-identical
    // to the one before it and no change notification fires. Both halves are required: a correct id with
    // an index key still lets React reuse one component instance for a different panel and rename its
    // actions underneath it.
    const order = reorderPanel(input.id as string, input.position as number);
    await context.afterRender();
    return { order };
  }),
});

/** Re-exported so a reader can see the closed kind set this module's schemas are built from. */
export type { PanelKind };
export { CATALOG };
