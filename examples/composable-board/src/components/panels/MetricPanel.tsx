import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { actionName, PANEL_ACTION } from '../../catalog/kinds.ts';
import type { PANEL_KIND } from '../../catalog/vocabulary.ts';
import { measuresOf, rowsOf } from '../../data/sources.ts';
import type { Panel } from '../../state/board.ts';
import { updateSettings } from '../../state/board.ts';

// One number: the total of a numeric column across everything its bound source holds.
//
// What this component owns: the total and its caption, and (from user story 3) the action that changes
// which column it measures. It owns no data and no board state.

export type MetricPanelModel = Extract<Panel, { kind: typeof PANEL_KIND.metric }>;

/** The measured total. Derived on every render, so a row appended elsewhere is counted here. */
export function measuredTotal(panel: MetricPanelModel): number {
  return rowsOf(panel.source).reduce(
    (total, row) => total + Number(row[panel.settings.measure] ?? 0),
    0,
  );
}

export function MetricPanel({ panel }: { readonly panel: MetricPanelModel }): ReactNode {
  const total = measuredTotal(panel);
  const spec = measuresOf(panel.source).find((column) => column.key === panel.settings.measure);
  const measurable = measuresOf(panel.source).map((column) => column.key);

  // This tile's own action. The id is in the NAME and never an argument, and every part of the
  // descriptor depends only on `panel.id` and `panel.source` — both immutable for this panel's life, so
  // changing the measure does not touch the registry.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_measure),
    title: `Change what ${panel.id} measures`,
    description:
      `Chooses which numeric column the "${panel.id}" tile totals. The options come from its bound ` +
      `source (${panel.source}). Returns the new total.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['measure'],
      properties: { measure: { type: 'string', enum: measurable } },
    },
    handler: async (input, context) => {
      const measure = input.measure as string;
      const updated = updateSettings<typeof PANEL_KIND.metric>(panel.id, { measure });
      await context.afterRender();
      return { measure, value: measuredTotal(updated as MetricPanelModel) };
    },
  });

  return (
    <div className="panel" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>{spec?.label ?? panel.settings.measure}</h3>
        <span className="panel-id">{panel.id}</span>
      </div>
      <div className="panel-body">
        <div className="metric-value" data-testid={`metric-${panel.id}`}>
          {total.toLocaleString('en-US')}
        </div>
        <div className="metric-caption">
          total {panel.settings.measure} across {panel.source.replace(/_/g, ' ')}
        </div>
      </div>
    </div>
  );
}
