import { columnsOf, measuresOf } from '../data/sources.ts';
import {
  ACCOUNT_PLANS,
  type AccountPlan,
  type ActivityKind,
  CHART_SHAPE,
  type ChartShape,
  DATA_SOURCE,
  type DataSourceName,
  MAP_FOCUS,
  type MapFocus,
  PANEL_KIND,
  type PanelKind,
  type PipelineFocus,
  SORT_DIRECTION,
  type SortDirection,
  STAGE_ANY,
} from './vocabulary.ts';

// The closed, build-time catalog. Four kinds, each declaring what it is called, which sources it may
// bind to, and the settings it starts with.
//
// **This is the boundary the whole feature exists to demonstrate holding.** The agent instantiates FROM
// this catalog; it never extends it. There is no registry to add to at run time, no name lookup that
// falls through to a generic renderer, and no path by which markup, a component description, a layout
// tree or an expression supplied by the agent reaches the screen. Remote rendering is a named non-goal
// (docs/design.md#non-goals), and "let the agent build UI" is exactly the request that reads as an
// invitation to add one.
//
// **No settings are accepted when a panel is created.** A panel starts at its kind's defaults and is
// configured afterwards through its own actions. A settings object at creation would be polymorphic in
// `kind`, and the only honest schema for that is a discriminated union — the least reliably handled part
// of JSON Schema for tool consumers, and structurally the shape a generic mutation tool wears.
//
// What this module owns: the catalog and the per-kind settings shapes. It owns no state, no
// registration and no rendering. A kind added to `PANEL_KIND` and missing here fails to compile, because
// every record below is keyed by the full kind set.

/** What a table panel shows: an ordering and a free-text narrowing. */
export interface TableSettings {
  readonly column: string;
  readonly direction: SortDirection;
  readonly query: string;
}

/** What a metric tile totals. One numeric column of its bound source. */
export interface MetricSettings {
  readonly measure: string;
}

/** How a chart draws its series. */
export interface ChartSettings {
  readonly shape: ChartShape;
}

/** Where a map is looking, and which numeric column sizes its markers. */
export interface MapSettings {
  readonly focus: MapFocus;
  readonly measure: string;
}

/** How much of the activity stream a timeline shows, and which event kinds. An empty list means all. */
export interface TimelineSettings {
  readonly days: number;
  readonly kinds: readonly ActivityKind[];
}

/** Which stage column the pipeline is narrowed to. `all` is a member, not an absence. */
export interface PipelineSettings {
  readonly stage: PipelineFocus;
}

/** What a form currently holds. Keyed by field name; a secret field's value lives here and is never reported. */
export interface FormSettings {
  readonly values: Readonly<Record<string, string>>;
}

/** The settings shape of each kind, so a panel's settings type follows from its kind. */
export interface SettingsByKind {
  readonly [PANEL_KIND.table]: TableSettings;
  readonly [PANEL_KIND.metric]: MetricSettings;
  readonly [PANEL_KIND.chart]: ChartSettings;
  readonly [PANEL_KIND.form]: FormSettings;
  readonly [PANEL_KIND.map]: MapSettings;
  readonly [PANEL_KIND.timeline]: TimelineSettings;
  readonly [PANEL_KIND.pipeline]: PipelineSettings;
}

/** One input inside a form panel. The catalog declares these; the agent never supplies fields. */
export interface FormFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly type: 'text' | 'email' | 'enum';
  readonly options?: readonly string[];
  /**
   * Whether this field's value may ever be reported to an agent.
   *
   * Invariant: a secret field's value key is ABSENT from everything the agent receives — not `"***"`,
   * not `null`, not an empty string. A placeholder is itself a value that can be read back and echoed
   * into a fill, and it discloses that the field is set. Enforced at the disclosure boundary in
   * `Board.tsx`, because the library traverses nothing and injects nothing: `getState` is the only
   * place that decides.
   */
  readonly secret: boolean;
}

/** The account form's fields. Fixed: the agent chooses the panel, never the fields. */
export const ACCOUNT_FORM_FIELDS: readonly FormFieldSpec[] = [
  { name: 'name', label: 'Account name', type: 'text', secret: false },
  { name: 'owner_email', label: 'Owner email', type: 'email', secret: false },
  { name: 'plan', label: 'Plan', type: 'enum', options: ACCOUNT_PLANS, secret: false },
  { name: 'initial_password', label: 'Temporary password', type: 'text', secret: true },
];

interface KindSpec {
  readonly label: string;
  /** The sources this kind may bind to. A pair outside this list is refused before anything renders. */
  readonly sources: readonly DataSourceName[];
}

/** The catalog. Keyed by the full kind set, so adding a kind and forgetting an entry does not compile. */
export const CATALOG: Readonly<Record<PanelKind, KindSpec>> = {
  [PANEL_KIND.table]: {
    label: 'Table',
    sources: [
      DATA_SOURCE.accounts,
      DATA_SOURCE.revenue_by_region,
      DATA_SOURCE.deals,
      DATA_SOURCE.activity,
    ],
  },
  [PANEL_KIND.metric]: {
    label: 'Metric tile',
    sources: [
      DATA_SOURCE.accounts,
      DATA_SOURCE.revenue_by_region,
      DATA_SOURCE.signups_by_month,
      DATA_SOURCE.sites,
      DATA_SOURCE.deals,
    ],
  },
  [PANEL_KIND.chart]: {
    label: 'Chart',
    sources: [DATA_SOURCE.revenue_by_region, DATA_SOURCE.signups_by_month],
  },
  [PANEL_KIND.form]: {
    label: 'Form',
    sources: [DATA_SOURCE.accounts],
  },
  // The two sources a map can place. `sites` carries coordinates; `revenue_by_region` does not, and the
  // renderer holds a region centroid for each member — a build-time fact about five named regions, not a
  // geocoder.
  [PANEL_KIND.map]: {
    label: 'Map',
    sources: [DATA_SOURCE.sites, DATA_SOURCE.revenue_by_region],
  },
  [PANEL_KIND.timeline]: {
    label: 'Timeline',
    sources: [DATA_SOURCE.activity],
  },
  [PANEL_KIND.pipeline]: {
    label: 'Pipeline',
    sources: [DATA_SOURCE.deals],
  },
};

/**
 * The verbs a panel's own actions can take.
 *
 * Closed, and spelled here rather than at each declaration, because two places need to agree about it
 * and they are reached at different times: `board.add_panel` reports the actions a panel it just created
 * declares — before that panel has mounted and registered anything — and the panel component declares
 * them when it does mount. One dictionary, so a verb added to a panel and not to this list, or the
 * reverse, is a compile error rather than a create call that reports an action nobody registers.
 */
export const PANEL_ACTION = {
  set_sort: 'set_sort',
  set_filter: 'set_filter',
  set_measure: 'set_measure',
  set_shape: 'set_shape',
  fill: 'fill',
  submit: 'submit',
  set_focus: 'set_focus',
  set_window: 'set_window',
  set_kinds: 'set_kinds',
  focus_stage: 'focus_stage',
  advance_deal: 'advance_deal',
} as const;
export type PanelAction = (typeof PANEL_ACTION)[keyof typeof PANEL_ACTION];

/** Which verbs each kind declares. Keyed by the full kind set, so a new kind must answer this. */
export const ACTIONS_BY_KIND: Readonly<Record<PanelKind, readonly PanelAction[]>> = {
  [PANEL_KIND.table]: [PANEL_ACTION.set_sort, PANEL_ACTION.set_filter],
  [PANEL_KIND.metric]: [PANEL_ACTION.set_measure],
  [PANEL_KIND.chart]: [PANEL_ACTION.set_shape],
  [PANEL_KIND.form]: [PANEL_ACTION.fill, PANEL_ACTION.submit],
  // `set_measure` is shared with the metric tile on purpose: it is the same intent — choose which number
  // this panel is about — and a second verb meaning the same thing would be a vocabulary an agent has to
  // learn twice.
  [PANEL_KIND.map]: [PANEL_ACTION.set_focus, PANEL_ACTION.set_measure],
  [PANEL_KIND.timeline]: [PANEL_ACTION.set_window, PANEL_ACTION.set_kinds],
  [PANEL_KIND.pipeline]: [PANEL_ACTION.focus_stage, PANEL_ACTION.advance_deal],
};

/**
 * The tool name one panel's action is registered under.
 *
 * **The identifier is part of the NAME and never an argument.** A panel's action exists only while its
 * panel does, so addressing a panel that is gone is a tool that is not there rather than an argument
 * that fails validation — which is the lifecycle guarantee, that a tool is callable only once its
 * owner has committed and is gone the moment that owner unmounts, asserted in the shape of the API
 * instead of described in a comment.
 */
export function actionName(panelId: string, action: PanelAction): string {
  return `panel.${panelId}.${action}`;
}

/** Every action name one panel declares. What a create call reports back to the agent. */
export function actionNamesFor(kind: PanelKind, panelId: string): readonly string[] {
  return ACTIONS_BY_KIND[kind].map((action) => actionName(panelId, action));
}

/**
 * Whether a kind may bind to a source.
 *
 * The pair is checked, never each half independently: `chart` and `accounts` are both individually legal
 * and the combination is not, so validating them separately would admit a panel nobody declared.
 */
export function admitsSource(kind: PanelKind, source: DataSourceName): boolean {
  return CATALOG[kind].sources.includes(source);
}

/**
 * The source a kind binds to when nothing else has been chosen.
 *
 * **Throws rather than falling back to some other source.** A kind with an empty `sources` list is a
 * catalog that does not make sense, and quietly substituting a source the kind cannot render would
 * produce a panel bound to data it has no columns for — which looks like a rendering bug rather than a
 * catalog one, and is exactly the convenience default this project forbids: an unexpected state
 * fails loud rather than resolving into a plausible-looking one.
 */
export function firstSourceFor(kind: PanelKind): DataSourceName {
  const [first] = CATALOG[kind].sources;
  if (first === undefined) {
    throw new Error(`the catalog gives the "${kind}" kind no data source to bind to`);
  }
  return first;
}

/** The settings a new panel of this kind starts with, given the source it is bound to. */
export function defaultSettingsFor<K extends PanelKind>(
  kind: K,
  source: DataSourceName,
): SettingsByKind[K] {
  switch (kind) {
    case PANEL_KIND.table: {
      const [first] = columnsOf(source);
      const settings: TableSettings = {
        // A source always has at least one column, but `noUncheckedIndexedAccess` cannot know that, and
        // an empty string here would silently produce a table sorted by nothing rather than an error.
        column: first?.key ?? 'name',
        direction: SORT_DIRECTION.asc,
        query: '',
      };
      return settings as SettingsByKind[K];
    }
    case PANEL_KIND.metric: {
      const [first] = measuresOf(source);
      const settings: MetricSettings = { measure: first?.key ?? 'revenue' };
      return settings as SettingsByKind[K];
    }
    case PANEL_KIND.chart: {
      const settings: ChartSettings = { shape: CHART_SHAPE.bar };
      return settings as SettingsByKind[K];
    }
    case PANEL_KIND.map: {
      const [first] = measuresOf(source);
      // The same guarded read as the metric tile's: a source with no numeric column would otherwise
      // produce a map whose markers are all one size, with nothing to say why.
      const settings: MapSettings = { focus: MAP_FOCUS.world, measure: first?.key ?? 'revenue' };
      return settings as SettingsByKind[K];
    }
    case PANEL_KIND.timeline: {
      // Thirty days and every kind: a timeline that opened filtered would look like a timeline with
      // missing data.
      const settings: TimelineSettings = { days: 30, kinds: [] };
      return settings as SettingsByKind[K];
    }
    case PANEL_KIND.pipeline: {
      const settings: PipelineSettings = { stage: STAGE_ANY };
      return settings as SettingsByKind[K];
    }
    default: {
      const settings: FormSettings = { values: {} };
      return settings as SettingsByKind[K];
    }
  }
}

/** The plans the account form offers, as the form's own `enum` reads them. */
export type { AccountPlan };
