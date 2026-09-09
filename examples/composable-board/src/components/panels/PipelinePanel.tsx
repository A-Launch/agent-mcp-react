import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { actionName, PANEL_ACTION } from '../../catalog/kinds.ts';
import {
  DEAL_STAGES,
  isPipelineFocus,
  type PANEL_KIND,
  PIPELINE_FOCUSES,
  STAGE_ANY,
} from '../../catalog/vocabulary.ts';
import { advanceDeal, rowsOf } from '../../data/sources.ts';
import { notifyDataChanged, type Panel, updateSettings } from '../../state/board.ts';

// The deal pipeline as columns of cards, and the one panel here that CHANGES the data rather than the
// way it is displayed.
//
// **Advancing a deal is confirmation-required**, for the same reason submitting the account form is: it
// is a state change a person is accountable for, and `confirmation` resolves BEFORE the handler runs
// rather than undoing an effect afterwards. Narrowing to a stage is not — looking at something is not
// doing something, and asking a person to approve a filter would train them to click through the prompt
// that matters.
//
// **The same function serves the button and the tool.** `advanceDeal` in the data module owns the
// transition and the order it walks; this component has no second path for a person, which is what makes
// "the agent and the person do the same thing" true in the code rather than remembered as a rule.
//
// What this component owns: the columns, the human advance button, and its two actions. It owns neither
// the deal data nor the stage order.

export type PipelinePanelModel = Extract<Panel, { kind: typeof PANEL_KIND.pipeline }>;

interface DealCard {
  readonly deal: string;
  readonly account: string;
  readonly stage: string;
  readonly value: number;
  readonly owner: string;
}

const money = (value: number): string => `$${Math.round(value / 1000).toLocaleString('en-US')}k`;

export function PipelinePanel({ panel }: { readonly panel: PipelinePanelModel }): ReactNode {
  const cards: readonly DealCard[] = rowsOf(panel.source).map((row) => ({
    deal: String(row.deal ?? ''),
    account: String(row.account ?? ''),
    stage: String(row.stage ?? ''),
    value: Number(row.value ?? 0),
    owner: String(row.owner ?? ''),
  }));

  // Narrowing the view. No confirmation: it changes what is on screen and nothing else.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.focus_stage),
    title: `Narrow ${panel.id} to one stage`,
    description:
      `Shows only one stage column of the "${panel.id}" pipeline, or "${STAGE_ANY}" for every stage. ` +
      'This changes what is displayed and moves no deal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['stage'],
      properties: { stage: { type: 'string', enum: PIPELINE_FOCUSES as readonly string[] } },
    },
    handler: async (input, context) => {
      const requested = input.stage;
      if (!isPipelineFocus(requested)) {
        throw new Error(
          `"${String(requested)}" is not a stage — use: ${PIPELINE_FOCUSES.join(', ')}`,
        );
      }
      updateSettings<typeof PANEL_KIND.pipeline>(panel.id, { stage: requested });
      await context.afterRender();
      return { stage: requested };
    },
  });

  // **The mutation.** A person answers before the handler runs, and a domain refusal is RETURNED rather
  // than thrown — a thrown message is replaced with a generic `MCP_TOOL_EXECUTION_ERROR` outside a
  // development build, so "that deal is already won" would reach the agent as an unexplained failure.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.advance_deal),
    title: `Move a deal forward in ${panel.id}`,
    description:
      'Moves one deal to the next stage: prospect → qualified → proposal → won. A person must confirm ' +
      'this before it happens. A deal that is already won, or that is lost, returns `ok: false` with a ' +
      '`refused` message; so does a name that is not on the board.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['deal'],
      properties: {
        deal: { type: 'string', maxLength: 120, description: 'The deal name, exactly as listed' },
      },
    },
    permissions: { confirmation: 'required' },
    handler: async (input, context) => {
      const name = typeof input.deal === 'string' ? input.deal : '';
      try {
        const moved = advanceDeal(name);
        // The deal list changed under every panel bound to it, not just this one: a table of deals has
        // to repaint too, and only the store knows who is watching.
        notifyDataChanged();
        await context.afterRender();
        return { ok: true, deal: name, ...moved };
      } catch (cause) {
        return { ok: false, refused: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  const columns = panel.settings.stage === STAGE_ANY ? DEAL_STAGES : [panel.settings.stage];
  const total = cards
    .filter((card) => columns.some((stage) => stage === card.stage))
    .reduce((sum, card) => sum + card.value, 0);

  return (
    <div className="panel pipeline" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>deal pipeline</h3>
        <span className="panel-id">{panel.id}</span>
        <span className="count" data-testid={`stage-${panel.id}`}>
          {panel.settings.stage}
        </span>
        <span className="count" data-testid={`value-${panel.id}`}>
          {money(total)} in view
        </span>
      </div>
      <div className="panel-body">
        <div className="lanes">
          {columns.map((stage) => {
            const inStage = cards.filter((card) => card.stage === stage);
            return (
              <div className="lane" key={stage} data-testid={`lane-${panel.id}-${stage}`}>
                <div className="lane-head">
                  <strong>{stage}</strong>
                  <span className="count">{inStage.length}</span>
                </div>
                {inStage.map((card) => (
                  <div
                    className="card"
                    key={card.deal}
                    data-testid={`card-${panel.id}-${card.deal}`}
                  >
                    <strong>{card.deal}</strong>
                    <span className="muted">{card.account}</span>
                    <span className="row">
                      <span className="count">{money(card.value)}</span>
                      <span className="count">{card.owner}</span>
                      {/*
                        The person's path into the SAME function the tool calls. It carries no
                        confirmation of its own — a person clicking the button IS the confirmation, and a
                        second prompt in front of their own click would be theatre.
                      */}
                      <button
                        type="button"
                        data-testid={`advance-${panel.id}-${card.deal}`}
                        onClick={() => {
                          try {
                            advanceDeal(card.deal);
                            notifyDataChanged();
                          } catch {
                            // A terminal deal has no next stage. The button is the only caller that can
                            // see the card is already won, so there is nothing to report here.
                          }
                        }}
                      >
                        →
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
