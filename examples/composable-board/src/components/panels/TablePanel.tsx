import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { actionName, PANEL_ACTION } from '../../catalog/kinds.ts';
import {
  isSortDirection,
  type PANEL_KIND,
  SORT_DIRECTION,
  SORT_DIRECTIONS,
} from '../../catalog/vocabulary.ts';
import { columnsOf, type Row, rowsOf } from '../../data/sources.ts';
import { type Panel, updateSettings } from '../../state/board.ts';

// A table of whatever its bound source holds, ordered and narrowed by its own settings.
//
// What this component owns: rendering rows, and (from user story 3) declaring the two actions that
// change how they are ordered and narrowed. It owns no data and no board state — it reads the source
// live so a row another part of the page created is visible here without anything being told about it.

export type TablePanelModel = Extract<Panel, { kind: typeof PANEL_KIND.table }>;

/**
 * The rows this table is currently showing, in the order it is showing them.
 *
 * Derived on every render rather than stored. A stored projection is a second copy of the truth, and it
 * is the copy that goes stale when a form appends an account.
 */
export function visibleRows(panel: TablePanelModel): readonly Row[] {
  const columns = columnsOf(panel.source);
  const spec = columns.find((column) => column.key === panel.settings.column);
  const query = panel.settings.query.trim().toLowerCase();

  const filtered =
    query === ''
      ? rowsOf(panel.source)
      : rowsOf(panel.source).filter((row) =>
          Object.values(row).some((cell) => String(cell).toLowerCase().includes(query)),
        );

  const direction = panel.settings.direction === SORT_DIRECTION.desc ? -1 : 1;
  const key = panel.settings.column;

  return [...filtered].sort((left, right) => {
    const a = left[key];
    const b = right[key];
    if (a === undefined || b === undefined) return 0;
    if (spec?.numeric === true) return (Number(a) - Number(b)) * direction;
    return String(a).localeCompare(String(b)) * direction;
  });
}

export function TablePanel({ panel }: { readonly panel: TablePanelModel }): ReactNode {
  const columns = columnsOf(panel.source);
  const rows = visibleRows(panel);
  const sortable = columns.map((column) => column.key);

  // **This panel's own two actions, named from its own identifier.**
  //
  // The id is part of the NAME and is never an argument: the tool exists only while this component is
  // mounted, so addressing a panel that has been removed is a tool that is not there rather than an
  // argument that fails validation. That is the lifecycle guarantee — callable only after commit, gone
  // at unmount — asserted in the shape of the API.
  //
  // **Every part of both descriptors depends only on `panel.id` and `panel.source`, both immutable for
  // this panel's life.** Nothing here reads `panel.settings`. A descriptor that moved with a setting
  // would make each sort a withdraw-and-register cycle — a tool-list-change storm, and a window in which
  // the tool does not exist — which is the failure the library's descriptor comparison exists to avoid
  // and which an application can reintroduce from the outside.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_sort),
    title: `Sort ${panel.id}`,
    description:
      `Orders the rows of the "${panel.id}" table. Columns come from its bound source ` +
      `(${panel.source}). Returns how many rows are showing afterwards.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['column'],
      properties: {
        column: { type: 'string', enum: sortable },
        direction: { type: 'string', enum: SORT_DIRECTIONS as readonly string[] },
      },
    },
    handler: async (input, context) => {
      const column = input.column as string;
      const requested = input.direction;
      const direction =
        typeof requested === 'string' && isSortDirection(requested)
          ? requested
          : SORT_DIRECTION.asc;

      const updated = updateSettings<typeof PANEL_KIND.table>(panel.id, {
        ...panel.settings,
        column,
        direction,
      });
      await context.afterRender();
      return {
        column,
        direction,
        rowCount: visibleRows(updated as TablePanelModel).length,
      };
    },
  });

  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_filter),
    title: `Filter ${panel.id}`,
    description:
      `Narrows the "${panel.id}" table to rows containing the given text in any cell. Pass ` +
      '`clear: true` to drop the filter. Returns how many rows are showing afterwards.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 100 },
        clear: { type: 'boolean' },
      },
    },
    handler: async (input, context) => {
      const query = input.clear === true ? '' : ((input.query as string | undefined) ?? '');
      const updated = updateSettings<typeof PANEL_KIND.table>(panel.id, {
        ...panel.settings,
        query,
      });
      await context.afterRender();
      return { query, rowCount: visibleRows(updated as TablePanelModel).length };
    },
  });

  return (
    <div className="panel" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>{panel.source.replace(/_/g, ' ')}</h3>
        <span className="panel-id">{panel.id}</span>
        <span className="count" data-testid={`rows-${panel.id}`}>
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
        <span className="count" data-testid={`sort-${panel.id}`}>
          sorted by {panel.settings.column} {panel.settings.direction}
        </span>
        {panel.settings.query === '' ? null : (
          <span className="panel-id" data-testid={`filter-${panel.id}`}>
            “{panel.settings.query}”
          </span>
        )}
      </div>
      <div className="panel-body">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.numeric ? 'numeric' : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // Keyed by the row's first cell plus its index: the demonstration data has unique names,
              // and the index keeps a filtered view stable when two rows share one.
              <tr key={`${String(row[columns[0]?.key ?? 'name'] ?? '')}-${String(index)}`}>
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'numeric' : undefined}>
                    {column.numeric
                      ? Number(row[column.key] ?? 0).toLocaleString('en-US')
                      : String(row[column.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
