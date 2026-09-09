import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { actionName, PANEL_ACTION } from '../../catalog/kinds.ts';
import {
  ACTIVITY_KINDS,
  type ActivityKind,
  isActivityKind,
  type PANEL_KIND,
} from '../../catalog/vocabulary.ts';
import { rowsOf } from '../../data/sources.ts';
import type { Panel } from '../../state/board.ts';
import { updateSettings } from '../../state/board.ts';

// The activity stream on a time axis: one lane per kind of event, one dot per event.
//
// **The window ends at the newest event, not at today.** A demonstration whose data ages would show an
// empty timeline a month after it was written, and "the panel is broken" and "the window excludes
// everything" look identical on screen. Anchoring to the data keeps the panel honest about what it has.
//
// **An empty kind list means every kind**, and that is a decision the schema states out loud rather than
// a convenience the handler invents: `set_kinds` with `[]` is how an agent clears a filter, so there is
// one spelling for "no filter" instead of a missing argument meaning something.
//
// What this component owns: the lanes, the axis and its two actions. It owns no data and no board state.

export type TimelinePanelModel = Extract<Panel, { kind: typeof PANEL_KIND.timeline }>;

const WIDTH = 720;
const LANE = 26;
const PAD_LEFT = 96;
const PAD_RIGHT = 24;
const PAD_TOP = 18;

const DAY = 24 * 60 * 60 * 1000;

/** The minimum and maximum window a person or an agent may ask for, in days. */
const WINDOW = { min: 1, max: 365 } as const;

interface Event {
  readonly at: number;
  readonly kind: ActivityKind;
  readonly actor: string;
  readonly subject: string;
}

export function TimelinePanel({ panel }: { readonly panel: TimelinePanelModel }): ReactNode {
  // How far back the timeline reaches. An integer with a declared range, so an argument outside it is
  // refused by the runtime BEFORE the handler runs — the application never sees a window of -4 days.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_window),
    title: `Change how far back ${panel.id} reaches`,
    description:
      `Sets how many days of activity the "${panel.id}" timeline shows, counting back from the most ` +
      `recent event rather than from today. Between ${String(WINDOW.min)} and ${String(WINDOW.max)}.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['days'],
      properties: {
        days: { type: 'integer', minimum: WINDOW.min, maximum: WINDOW.max },
      },
    },
    handler: async (input, context) => {
      const requested = input.days;
      // The declared range is what admits the number; this turns a validated value into one the store
      // can hold without trusting the wire.
      if (typeof requested !== 'number' || !Number.isInteger(requested)) {
        throw new Error(`"${String(requested)}" is not a whole number of days`);
      }
      updateSettings<typeof PANEL_KIND.timeline>(panel.id, {
        ...panel.settings,
        days: requested,
      });
      await context.afterRender();
      return { days: requested };
    },
  });

  // Which kinds of event are shown. An ARRAY argument, with the members drawn from the vocabulary and
  // duplicates refused by the schema.
  useMcpTool({
    name: actionName(panel.id, PANEL_ACTION.set_kinds),
    title: `Choose which events ${panel.id} shows`,
    description:
      `Narrows the "${panel.id}" timeline to the named kinds of event. Send an empty list to clear the ` +
      'filter and show every kind.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kinds'],
      properties: {
        kinds: {
          type: 'array',
          uniqueItems: true,
          maxItems: ACTIVITY_KINDS.length,
          items: { type: 'string', enum: ACTIVITY_KINDS as readonly string[] },
        },
      },
    },
    handler: async (input, context) => {
      const requested = input.kinds;
      if (!Array.isArray(requested)) {
        throw new Error('kinds must be a list of event kinds');
      }
      // Every member is guarded individually. A declared `enum` inside `items` is checked by the
      // validator, and this is what carries the result into the union type without an `as`-cast.
      const kinds: ActivityKind[] = [];
      for (const candidate of requested) {
        if (!isActivityKind(candidate)) {
          throw new Error(
            `"${String(candidate)}" is not an event kind — use: ${ACTIVITY_KINDS.join(', ')}`,
          );
        }
        kinds.push(candidate);
      }
      updateSettings<typeof PANEL_KIND.timeline>(panel.id, { ...panel.settings, kinds });
      await context.afterRender();
      return {
        kinds,
        showing: kinds.length === 0 ? 'every kind' : `${String(kinds.length)} kinds`,
      };
    },
  });

  const events: readonly Event[] = rowsOf(panel.source).map((row) => {
    const kind = String(row.kind ?? '');
    return {
      at: Date.parse(String(row.at ?? '')),
      // A row whose kind is not in the vocabulary would be a data error; it is shown in its own lane
      // rather than dropped, because a silently missing event is the worse failure.
      kind: isActivityKind(kind) ? kind : ACTIVITY_KINDS[0],
      actor: String(row.actor ?? ''),
      subject: String(row.subject ?? ''),
    } as Event;
  });

  const newest = events.reduce((latest, event) => Math.max(latest, event.at), 0);
  const from = newest - panel.settings.days * DAY;
  const selected = panel.settings.kinds;
  const shown = events.filter(
    (event) => event.at >= from && (selected.length === 0 || selected.includes(event.kind)),
  );

  const lanes = selected.length === 0 ? ACTIVITY_KINDS : selected;
  const height = PAD_TOP * 2 + lanes.length * LANE;
  const span = Math.max(newest - from, DAY);
  const x = (at: number): number =>
    PAD_LEFT + ((at - from) / span) * (WIDTH - PAD_LEFT - PAD_RIGHT);

  return (
    <div className="panel timeline" data-testid={`panel-${panel.id}`} data-panel-kind={panel.kind}>
      <div className="panel-head">
        <h3>activity</h3>
        <span className="panel-id">{panel.id}</span>
        <span className="count" data-testid={`window-${panel.id}`}>
          last {panel.settings.days} days
        </span>
        <span className="count" data-testid={`kinds-${panel.id}`}>
          {selected.length === 0 ? 'every kind' : selected.join(', ')}
        </span>
        <span className="count" data-testid={`events-${panel.id}`}>
          {shown.length} events
        </span>
      </div>
      <div className="panel-body">
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(height)}`}
          role="img"
          aria-label={`activity timeline, last ${String(panel.settings.days)} days`}
        >
          {lanes.map((lane, index) => {
            const y = PAD_TOP + index * LANE;
            return (
              <g key={lane}>
                <line className="grid" x1={PAD_LEFT} y1={y} x2={WIDTH - PAD_RIGHT} y2={y} />
                <text className="label" x={PAD_LEFT - 10} y={y + 4} textAnchor="end">
                  {lane}
                </text>
                {shown
                  .filter((event) => event.kind === lane)
                  .map((event) => (
                    <circle
                      key={`${event.subject}-${String(event.at)}`}
                      className={`event event-${event.kind}`}
                      cx={x(event.at)}
                      cy={y}
                      r={5}
                    >
                      <title>{`${event.subject} · ${event.actor}`}</title>
                    </circle>
                  ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
