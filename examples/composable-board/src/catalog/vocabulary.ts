// The board's closed vocabularies: every value a panel kind, a data source or a tool argument may take.
//
// One exported `as const` dictionary per set, with the type and the membership test derived from it
// and never re-spelled anywhere else. Nothing else in this example spells one of these as a string
// literal — the schema
// enums, the refusal messages, the renderer switch and the toolbar's buttons are all built from these
// objects, so a member added here and missed somewhere else fails to compile rather than going quietly
// unhandled.
//
// The guards matter as much as the types. An agent sends whatever it likes; an argument that arrives is
// untrusted text until a guard says otherwise, and nothing here is `as`-cast onto one of these types.
//
// What this module owns: the vocabulary and its guards. It owns no data, no state, no schema and no
// rendering.

/**
 * The panel kinds this application can render. **Fixed at build time and not extensible at run time by
 * anything, including the agent** — there is no registry to add to and no name lookup that falls through
 * to a generic renderer. This dictionary is the whole catalog's key space.
 */
export const PANEL_KIND = {
  table: 'table',
  metric: 'metric',
  chart: 'chart',
  form: 'form',
  map: 'map',
  timeline: 'timeline',
  pipeline: 'pipeline',
} as const;
export type PanelKind = (typeof PANEL_KIND)[keyof typeof PANEL_KIND];

export const PANEL_KINDS: readonly PanelKind[] = Object.values(PANEL_KIND);

export function isPanelKind(value: unknown): value is PanelKind {
  return typeof value === 'string' && (PANEL_KINDS as readonly string[]).includes(value);
}

/** The named collections a panel may be bound to. A panel names one; it never carries data itself. */
export const DATA_SOURCE = {
  accounts: 'accounts',
  revenue_by_region: 'revenue_by_region',
  signups_by_month: 'signups_by_month',
  sites: 'sites',
  activity: 'activity',
  deals: 'deals',
} as const;
export type DataSourceName = (typeof DATA_SOURCE)[keyof typeof DATA_SOURCE];

export const DATA_SOURCES: readonly DataSourceName[] = Object.values(DATA_SOURCE);

export function isDataSourceName(value: unknown): value is DataSourceName {
  return typeof value === 'string' && (DATA_SOURCES as readonly string[]).includes(value);
}

/**
 * Subscription plans an account can be on.
 *
 * Here rather than beside the data because it feeds a SCHEMA — the account form's `plan` field declares
 * its `enum` from this dictionary, so a plan added here and not handled elsewhere fails to compile
 * instead of becoming a value the agent may send and nothing accepts.
 */
export const ACCOUNT_PLAN = {
  free: 'free',
  team: 'team',
  business: 'business',
  enterprise: 'enterprise',
} as const;
export type AccountPlan = (typeof ACCOUNT_PLAN)[keyof typeof ACCOUNT_PLAN];

export const ACCOUNT_PLANS: readonly AccountPlan[] = Object.values(ACCOUNT_PLAN);

/** Which way a table is ordered. */
export const SORT_DIRECTION = {
  asc: 'asc',
  desc: 'desc',
} as const;
export type SortDirection = (typeof SORT_DIRECTION)[keyof typeof SORT_DIRECTION];

export const SORT_DIRECTIONS: readonly SortDirection[] = Object.values(SORT_DIRECTION);

export function isSortDirection(value: unknown): value is SortDirection {
  return typeof value === 'string' && (SORT_DIRECTIONS as readonly string[]).includes(value);
}

/** How a chart panel draws its series. */
export const CHART_SHAPE = {
  bar: 'bar',
  line: 'line',
} as const;
export type ChartShape = (typeof CHART_SHAPE)[keyof typeof CHART_SHAPE];

export const CHART_SHAPES: readonly ChartShape[] = Object.values(CHART_SHAPE);

export function isChartShape(value: unknown): value is ChartShape {
  return typeof value === 'string' && (CHART_SHAPES as readonly string[]).includes(value);
}

/**
 * Where a map panel is looking. `world` plus one member per region, so a focus is a member of a closed
 * set rather than a bounding box the agent computes — a viewport is a rendering detail, and handing an
 * agent four numbers to get right would make "show me EMEA" a calculation instead of an intent.
 */
export const MAP_FOCUS = {
  world: 'world',
  amer: 'amer',
  emea: 'emea',
  apac: 'apac',
  latam: 'latam',
  mea: 'mea',
} as const;
export type MapFocus = (typeof MAP_FOCUS)[keyof typeof MAP_FOCUS];

export const MAP_FOCUSES: readonly MapFocus[] = Object.values(MAP_FOCUS);

export function isMapFocus(value: unknown): value is MapFocus {
  return typeof value === 'string' && (MAP_FOCUSES as readonly string[]).includes(value);
}

/** The kinds of event the activity stream records, and what a timeline panel can filter to. */
export const ACTIVITY_KIND = {
  signup: 'signup',
  upgrade: 'upgrade',
  downgrade: 'downgrade',
  ticket: 'ticket',
  churn: 'churn',
} as const;
export type ActivityKind = (typeof ACTIVITY_KIND)[keyof typeof ACTIVITY_KIND];

export const ACTIVITY_KINDS: readonly ActivityKind[] = Object.values(ACTIVITY_KIND);

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/**
 * The stages a deal moves through, IN ORDER.
 *
 * The order is the data: advancing a deal means the next member of this list, so a stage inserted here
 * changes what "advance" does everywhere at once, and no component holds its own copy of the sequence.
 * `won` and `lost` are terminal — `advance` refuses at `won`, and `lost` is reachable only by a person.
 */
export const DEAL_STAGE = {
  prospect: 'prospect',
  qualified: 'qualified',
  proposal: 'proposal',
  won: 'won',
  lost: 'lost',
} as const;
export type DealStage = (typeof DEAL_STAGE)[keyof typeof DEAL_STAGE];

/** The pipeline's columns, in order. `lost` is deliberately outside the advance path. */
export const DEAL_STAGES: readonly DealStage[] = [
  DEAL_STAGE.prospect,
  DEAL_STAGE.qualified,
  DEAL_STAGE.proposal,
  DEAL_STAGE.won,
  DEAL_STAGE.lost,
];

/** The stages `advance_deal` walks, in order. Terminal stages are absent by construction. */
export const ADVANCING_STAGES: readonly DealStage[] = [
  DEAL_STAGE.prospect,
  DEAL_STAGE.qualified,
  DEAL_STAGE.proposal,
  DEAL_STAGE.won,
];

/**
 * The pipeline's "every stage" member, spelled once.
 *
 * A filter that can be off still has to name the off position, and a bare `'all'` written into a schema
 * here and a comparison there is exactly the hardcoded member of a closed set this project forbids: a
 * closed set is declared once and derived from, never spelled again at a boundary.
 */
export const STAGE_ANY = 'all';
export type PipelineFocus = DealStage | typeof STAGE_ANY;

export const PIPELINE_FOCUSES: readonly PipelineFocus[] = [STAGE_ANY, ...DEAL_STAGES];

export function isPipelineFocus(value: unknown): value is PipelineFocus {
  return typeof value === 'string' && (PIPELINE_FOCUSES as readonly string[]).includes(value);
}

export function isDealStage(value: unknown): value is DealStage {
  return typeof value === 'string' && (DEAL_STAGES as readonly string[]).includes(value);
}

/**
 * The board's hard ceiling on panels.
 *
 * **Chosen from tool-count reasoning, not from layout.** Each panel declares up to two tools of its own
 * and the shell declares four, so twelve panels is at most twenty-eight entries in one `tools/list` —
 * still readable by a person watching the demo and still inside what a model handles reliably in one
 * listing. Because a panel's tools are registered per instance, this number is the ONLY thing bounding
 * the size of the agent's reachable action set; a ceiling picked for column widths would have left the
 * real constraint unbounded.
 */
export const MAX_PANELS = 12;
