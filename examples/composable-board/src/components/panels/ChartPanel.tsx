import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { actionName, PANEL_ACTION } from '../../catalog/kinds.ts';
import {
  CHART_SHAPE,
  CHART_SHAPES,
  isChartShape,
  type PANEL_KIND,
} from '../../catalog/vocabulary.ts';
import { columnsOf, measuresOf, rowsOf } from '../../data/sources.ts';
import type { Panel } from '../../state/board.ts';
import { updateSettings } from '../../state/board.ts';

// A bar or line chart of its bound source's first numeric column, drawn as hand-written SVG.
//
// **No charting library, deliberately.** The feature under test is composition, not charting. A charting
// dependency in a demonstrator is another thing that can break the build and teaches an embedder nothing
// about this library — and Proportionate Engineering asks for the simplest design that satisfies the
// spec, which for two shapes over at most twelve points is sixty lines of SVG.
//
// What this component owns: the drawing, and (from user story 3) the action that switches its shape. It
// owns no data and no board state.

export type ChartPanelModel = Extract<Panel, { kind: typeof PANEL_KIND.chart }>;

const WIDTH = 640;
const HEIGHT = 180;
const PAD = 24;

export function ChartPanel({ panel }: { readonly panel: ChartPanelModel }): ReactNode {
  // This chart's own action. The id is in the NAME and never an argument, and the descriptor depends
  // only on `panel.id` — so switching shape changes the drawing and touches the registry not at all.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_shape),
    title: `Change how ${panel.id} is drawn`,
    description: `Switches the "${panel.id}" chart between a bar chart and a line chart.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['shape'],
      properties: { shape: { type: 'string', enum: CHART_SHAPES as readonly string[] } },
    },
    handler: async (input, context) => {
      const requested = input.shape;
      // The guard is not redundant with the declared `enum`: it turns a validated string into the union
      // type without an `as`-cast onto a type that does not admit it.
      if (typeof requested !== 'string' || !isChartShape(requested)) {
        throw new Error(
          `"${String(requested)}" is not a chart shape — use: ${CHART_SHAPES.join(', ')}`,
        );
      }
      updateSettings<typeof PANEL_KIND.chart>(panel.id, { shape: requested });
      await context.afterRender();
      return { shape: requested };
    },
  });

  const rows = rowsOf(panel.source);
  const [label] = columnsOf(panel.source);
  const [measure] = measuresOf(panel.source);
  const key = measure?.key ?? 'value';
  const labelKey = label?.key ?? 'name';

  const values = rows.map((row) => Number(row[key] ?? 0));
  // Guarded rather than assumed: an empty source would make `max` be `-Infinity` and every coordinate
  // `NaN`, which renders as a blank panel with no indication that anything went wrong.
  const max = values.length === 0 ? 0 : Math.max(...values);
  const scale = max === 0 ? 0 : (HEIGHT - PAD * 2) / max;
  const step = values.length === 0 ? 0 : (WIDTH - PAD * 2) / values.length;

  const points = values
    .map((value, index) => {
      const x = PAD + step * index + step / 2;
      const y = HEIGHT - PAD - value * scale;
      return `${String(Math.round(x))},${String(Math.round(y))}`;
    })
    .join(' ');

  return (
    <div className="panel chart" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>
          {key} by {labelKey}
        </h3>
        <span className="panel-id">{panel.id}</span>
        <span className="count" data-testid={`shape-${panel.id}`}>
          {panel.settings.shape}
        </span>
      </div>
      <div className="panel-body">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          role="img"
          aria-label={`${key} chart`}
        >
          <line className="grid" x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} />
          {panel.settings.shape === CHART_SHAPE.bar
            ? values.map((value, index) => (
                <rect
                  key={String(rows[index]?.[labelKey] ?? index)}
                  className="bar"
                  x={PAD + step * index + step * 0.15}
                  y={HEIGHT - PAD - value * scale}
                  width={Math.max(step * 0.7, 1)}
                  height={Math.max(value * scale, 0)}
                />
              ))
            : points === '' || <polyline className="line" points={points} />}
          {rows.map((row, index) => (
            <text
              key={String(row[labelKey] ?? index)}
              className="label"
              x={PAD + step * index + step / 2}
              y={HEIGHT - PAD + 12}
              textAnchor="middle"
            >
              {String(row[labelKey] ?? '')}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
