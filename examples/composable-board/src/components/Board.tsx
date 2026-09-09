import { CONNECTION_STATUS, useMcpConnection, useMcpState, useMcpTabId } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';
import { admitsSource, CATALOG, firstSourceFor } from '../catalog/kinds.ts';
import {
  type DataSourceName,
  PANEL_KIND,
  PANEL_KINDS,
  type PanelKind,
} from '../catalog/vocabulary.ts';
import {
  addPanels,
  currentPanels,
  getSnapshot,
  type Panel,
  removePanel,
  reorderPanel,
  subscribe,
} from '../state/board.ts';
import { ChartPanel } from './panels/ChartPanel.tsx';
import { FORM_FIELDS, FormPanel } from './panels/FormPanel.tsx';
import { MapPanel } from './panels/MapPanel.tsx';
import { MetricPanel } from './panels/MetricPanel.tsx';
import { PipelinePanel } from './panels/PipelinePanel.tsx';
import { TablePanel } from './panels/TablePanel.tsx';
import { TimelinePanel } from './panels/TimelinePanel.tsx';

// The right pane: whatever is currently on the board.
//
// It SUBSCRIBES to the board store rather than owning it. The store lives at module scope because the
// composition tools are declared at import time, before React mounts, and a handler cannot read a value
// that only exists inside a component tree.
//
// What this component owns: rendering the board and, later, the human controls that change it. It owns
// no state and declares no composition tool — those belong to the shell, whose lifetime is the
// document's rather than a component's.

/** Whether the agent can reach this page at all, named member by member. */
function ConnectionIndicator(): ReactNode {
  const connection = useMcpConnection();
  // **The page's own identity, published so a test can address THIS page rather than guess.** It is
  // metadata and never a credential — the gateway reads it only after redeeming a ticket, so nothing
  // is authorized by holding it — and it already travels in the URL this page dials. An attribute
  // rather than visible text: a person has no use for it, and a harness that has to infer which tab
  // is its own from a global list is a harness that addresses somebody else's page.
  const tabId = useMcpTabId();

  // Every member named rather than a default that renders the raw word: the status set widens over time,
  // and a bare string is a valid thing to render, so the compiler cannot catch the omission.
  const label =
    connection.status === CONNECTION_STATUS.error
      ? `not connected — ${connection.error.message}`
      : connection.status === CONNECTION_STATUS.reconnecting
        ? `reconnecting — attempt ${String(connection.attempt)}`
        : connection.status;

  return (
    <p
      className={`connection connection-${connection.status}`}
      data-testid="connection"
      data-tab-id={tabId}
    >
      <span className="dot" aria-hidden="true" />
      agent connection: <strong>{label}</strong>
    </p>
  );
}

/**
 * Renders one panel as its kind.
 *
 * **No default branch.** The switch is exhaustive over `PANEL_KIND` and the unreachable case is typed
 * `never`, so a kind added to the dictionary and not given a renderer fails to compile — rather than
 * rendering as nothing, which is what a `default: return null` would have done.
 */
function renderPanel(panel: Panel): ReactNode {
  switch (panel.kind) {
    case PANEL_KIND.table:
      return <TablePanel panel={panel} />;
    case PANEL_KIND.metric:
      return <MetricPanel panel={panel} />;
    case PANEL_KIND.chart:
      return <ChartPanel panel={panel} />;
    case PANEL_KIND.form:
      return <FormPanel panel={panel} />;
    case PANEL_KIND.map:
      return <MapPanel panel={panel} />;
    case PANEL_KIND.timeline:
      return <TimelinePanel panel={panel} />;
    case PANEL_KIND.pipeline:
      return <PipelinePanel panel={panel} />;
    default: {
      const unhandled: never = panel;
      throw new Error(`no renderer for panel kind ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The human controls for composing the board.
 *
 * **Every one of these calls the same store function the agent's tool calls** — `addPanels`,
 * `removePanel`, `reorderPanel` — never an equivalent second path. That is the one-path rule held in the
 * code rather than remembered as a rule, and it is what makes "a board built half by hand and half by
 * chat is one board" checkable: the two routes cannot diverge because there is only one route.
 */
function Toolbar(): ReactNode {
  const [kind, setKind] = useState<PanelKind>(PANEL_KIND.table);
  const [source, setSource] = useState<DataSourceName>(firstSourceFor(PANEL_KIND.table));
  const [refusal, setRefusal] = useState('');

  const add = (): void => {
    try {
      addPanels([{ kind, source }]);
      setRefusal('');
    } catch (cause) {
      // Shown, never swallowed. A person clicking Add on a pair the catalog does not admit gets the
      // same message the agent gets, from the same check.
      setRefusal(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="toolbar">
      <label className="sr-only" htmlFor="add-kind">
        Panel kind
      </label>
      <select
        id="add-kind"
        data-testid="add-kind"
        value={kind}
        onChange={(event) => {
          const next = event.target.value as PanelKind;
          setKind(next);
          // Keep the pair legal as the kind changes, rather than letting the toolbar offer a
          // combination the store will refuse.
          if (!admitsSource(next, source)) setSource(firstSourceFor(next));
        }}
      >
        {PANEL_KINDS.map((option) => (
          <option key={option} value={option}>
            {CATALOG[option].label}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="add-source">
        Data source
      </label>
      <select
        id="add-source"
        data-testid="add-source"
        value={source}
        onChange={(event) => setSource(event.target.value as DataSourceName)}
      >
        {CATALOG[kind].sources.map((option) => (
          <option key={option} value={option}>
            {option.replace(/_/g, ' ')}
          </option>
        ))}
      </select>

      <button type="button" className="primary" data-testid="add-panel" onClick={add}>
        Add panel
      </button>
      <span className="spacer" />
      {refusal === '' ? null : (
        <span className="count" data-testid="toolbar-refusal">
          {refusal}
        </span>
      )}
    </div>
  );
}

/** Per-panel human controls, beside each panel rather than inside it. */
function PanelControls({
  panel,
  index,
  total,
}: {
  readonly panel: Panel;
  readonly index: number;
  readonly total: number;
}): ReactNode {
  return (
    <div className="panel-head">
      <button
        type="button"
        data-testid={`up-${panel.id}`}
        disabled={index === 0}
        onClick={() => reorderPanel(panel.id, index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        data-testid={`down-${panel.id}`}
        disabled={index === total - 1}
        onClick={() => reorderPanel(panel.id, index + 1)}
      >
        ↓
      </button>
      <button
        type="button"
        data-testid={`remove-${panel.id}`}
        onClick={() => removePanel(panel.id)}
      >
        Remove
      </button>
    </div>
  );
}

/**
 * What a read of the board reports.
 *
 * **This function IS the disclosure boundary.** The library traverses nothing and injects nothing, and
 * the declared schema is a CONTRACT rather than a redactor — it is validated exactly as authored and an
 * undeclared field would cross to the agent unchanged. So nothing else can protect a secret field, and
 * there is exactly one place to get this wrong.
 *
 * A non-secret field carries its current value: an agent that cannot read back what it filled cannot
 * check its own work. A secret field's `value` KEY IS ABSENT — not `"***"`, not `null`, not an empty
 * string. A placeholder is itself a value that can be read back and echoed into a fill, and it discloses
 * that the field is set. `filled` is the one fact about it that is safe to share.
 */
function describeBoard(): unknown {
  return {
    panels: currentPanels().map((panel) => ({
      id: panel.id,
      kind: panel.kind,
      source: panel.source,
      settings:
        panel.kind === PANEL_KIND.form
          ? {
              fields: FORM_FIELDS.map((field) => {
                const held = panel.settings.values[field.name] ?? '';
                const common = {
                  name: field.name,
                  label: field.label,
                  type: field.type,
                  filled: held !== '',
                };
                // Spread rather than assigning `value: undefined`: with
                // `exactOptionalPropertyTypes` the key would still be present in the emitted JSON,
                // which is the placeholder this is here to avoid.
                return field.secret ? common : { ...common, value: held };
              }),
            }
          : panel.settings,
    })),
    panelCount: currentPanels().length,
  };
}

export function Board(): ReactNode {
  const board = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Published as `board.get_state` — an ORDINARY Level 1 registration, reachable by any page script
  // exactly like every other Level 1 tool. The hook is a composition over `useMcpTool`, not a second
  // registration path.
  useMcpState({
    name: 'board',
    description:
      'What is currently on the board: every panel in order, with its identifier, kind, data source ' +
      'and settings. Form panels report their fields; a field marked secret reports whether it is ' +
      'filled and never its value.',
    schema: {
      type: 'object',
      required: ['panels', 'panelCount'],
      properties: {
        panels: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'kind', 'source'],
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              source: { type: 'string' },
              settings: { type: 'object' },
            },
          },
        },
        panelCount: { type: 'integer' },
      },
    },
    getState: describeBoard,
  });

  return (
    <section className="pane pane-board" aria-label="Board">
      <div className="pane-head">
        <h2>Board</h2>
        <ConnectionIndicator />
        <span className="count" data-testid="panel-count">
          {board.panels.length} panel{board.panels.length === 1 ? '' : 's'}
        </span>
      </div>
      <Toolbar />
      <div className="pane-body">
        {board.panels.length === 0 ? (
          <p className="board-empty" data-testid="board-empty">
            No panels yet. Describe what you want to see, or add one from the toolbar.
          </p>
        ) : (
          <div className="board" data-testid="board">
            {/*
              **Keyed by `panel.id`, never by index, and that is not a lint nicety here.** A panel
              declares its own tools under a name built from its id. With an index key React reuses one
              component instance for a DIFFERENT panel across a reorder, so that instance's tool names
              change underneath it — a withdraw-and-register cycle produced by a correct id and an
              incorrect key. The position-independent id in the store is necessary and this is the other
              half of it.
            */}
            {board.panels.map((panel, index) => (
              <div key={panel.id}>
                <PanelControls panel={panel} index={index} total={board.panels.length} />
                {renderPanel(panel)}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
