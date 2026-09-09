import {
  ACCOUNT_PLAN,
  ACTIVITY_KIND,
  type AccountPlan,
  type ActivityKind,
  ADVANCING_STAGES,
  DATA_SOURCE,
  type DataSourceName,
  DEAL_STAGE,
  type DealStage,
} from '../catalog/vocabulary.ts';

// The fixed collections a panel may be bound to, and the column metadata every panel reads to know what
// it can show and what it can be sorted by.
//
// There is no backend, no query language and no loading state. The demonstration is about composition,
// and a data layer would be a second thing to debug when a panel does not appear.
//
// **`accounts` and `deals` are the MUTABLE collections**, and that is a requirement rather than a
// convenience: the account form creates records and the pipeline advances deals, so "it happened" has to
// land somewhere a person and an agent can both see. Without a mutable owner, a successful submission
// would be a sentence with nothing behind it — the false-success shape this project treats as its
// characteristic defect. Every mutation goes through the one function that owns it, and a panel never
// writes to a collection directly.
//
// What this module owns: the demonstration data and its column metadata. It owns no schema, no state
// transition and no rendering.

/** One column of a source, as both a table renders it and a sort tool enumerates it. */
export interface ColumnSpec {
  readonly key: string;
  readonly label: string;
  /** Right-aligned and tabular when rendered; compared numerically when sorted. */
  readonly numeric: boolean;
}

// **Type aliases rather than interfaces, and that is load-bearing rather than a style choice.** A panel
// reads cells by column key, so every row shape has to be assignable to `Row`. TypeScript gives an
// object type ALIAS an implicit index signature and does not give an interface one, so declaring these
// as interfaces makes `rowsOf` need a double cast through `unknown` — which would silence the compiler
// on exactly the mismatch it is there to catch.

export type Account = {
  readonly name: string;
  readonly owner: string;
  readonly plan: AccountPlan;
  readonly region: string;
  readonly revenue: number;
  readonly health: string;
};

export type RegionRevenue = {
  readonly region: string;
  readonly revenue: number;
  readonly growth: number;
};

export type MonthlySignups = {
  readonly month: string;
  readonly signups: number;
};

/**
 * One place on the map.
 *
 * `lat` and `lon` are ordinary numeric cells, so a table bound to this source could show them and a
 * metric could total them. The map panel is the only thing that reads them as coordinates — projection
 * is a rendering concern and lives with the renderer, not in the data.
 */
export type Site = {
  readonly site: string;
  readonly region: string;
  readonly country: string;
  readonly lat: number;
  readonly lon: number;
  readonly accounts: number;
  readonly revenue: number;
};

/** One event in the activity stream, newest last. `at` is an ISO date, sorted as text and read as time. */
export type ActivityEvent = {
  readonly at: string;
  readonly kind: ActivityKind;
  readonly actor: string;
  readonly subject: string;
};

/** One deal in the pipeline. `stage` moves; nothing else about a deal changes. */
export type Deal = {
  readonly deal: string;
  readonly account: string;
  readonly stage: DealStage;
  readonly value: number;
  readonly owner: string;
};

/** Any row any source can hold. Panels read cells by column key and never by field name. */
export type Row = Readonly<Record<string, string | number>>;

const SEED_ACCOUNTS: readonly Account[] = [
  {
    name: 'Acme Industrial',
    owner: 'dana',
    plan: ACCOUNT_PLAN.enterprise,
    region: 'emea',
    revenue: 412_000,
    health: 'healthy',
  },
  {
    name: 'Bellweather Co',
    owner: 'ravi',
    plan: ACCOUNT_PLAN.business,
    region: 'amer',
    revenue: 188_500,
    health: 'watch',
  },
  {
    name: 'Corvid Labs',
    owner: 'mei',
    plan: ACCOUNT_PLAN.team,
    region: 'apac',
    revenue: 61_200,
    health: 'healthy',
  },
  {
    name: 'Dunlin Freight',
    owner: 'dana',
    plan: ACCOUNT_PLAN.business,
    region: 'emea',
    revenue: 231_900,
    health: 'at_risk',
  },
  {
    name: 'Everline Health',
    owner: 'sam',
    plan: ACCOUNT_PLAN.enterprise,
    region: 'amer',
    revenue: 508_400,
    health: 'healthy',
  },
  {
    name: 'Fernbrook Media',
    owner: 'ravi',
    plan: ACCOUNT_PLAN.team,
    region: 'emea',
    revenue: 44_800,
    health: 'watch',
  },
  {
    name: 'Glasswing Studio',
    owner: 'mei',
    plan: ACCOUNT_PLAN.free,
    region: 'apac',
    revenue: 0,
    health: 'watch',
  },
  {
    name: 'Harrow & Vale',
    owner: 'sam',
    plan: ACCOUNT_PLAN.business,
    region: 'emea',
    revenue: 176_300,
    health: 'healthy',
  },
  {
    name: 'Ironvale Mining',
    owner: 'dana',
    plan: ACCOUNT_PLAN.enterprise,
    region: 'amer',
    revenue: 621_000,
    health: 'at_risk',
  },
  {
    name: 'Juniper Analytics',
    owner: 'ravi',
    plan: ACCOUNT_PLAN.team,
    region: 'amer',
    revenue: 72_400,
    health: 'healthy',
  },
  {
    name: 'Kestrel Logistics',
    owner: 'mei',
    plan: ACCOUNT_PLAN.business,
    region: 'apac',
    revenue: 143_700,
    health: 'churning',
  },
  {
    name: 'Larkfield Energy',
    owner: 'sam',
    plan: ACCOUNT_PLAN.enterprise,
    region: 'emea',
    revenue: 389_200,
    health: 'healthy',
  },
  {
    name: 'Meadowgate Bank',
    owner: 'dana',
    plan: ACCOUNT_PLAN.enterprise,
    region: 'amer',
    revenue: 744_600,
    health: 'healthy',
  },
  {
    name: 'Northaven Retail',
    owner: 'ravi',
    plan: ACCOUNT_PLAN.business,
    region: 'emea',
    revenue: 205_100,
    health: 'watch',
  },
  {
    name: 'Orchid Robotics',
    owner: 'mei',
    plan: ACCOUNT_PLAN.team,
    region: 'apac',
    revenue: 88_900,
    health: 'healthy',
  },
  {
    name: 'Pelican Software',
    owner: 'sam',
    plan: ACCOUNT_PLAN.free,
    region: 'amer',
    revenue: 0,
    health: 'churning',
  },
  {
    name: 'Quarry Systems',
    owner: 'dana',
    plan: ACCOUNT_PLAN.business,
    region: 'apac',
    revenue: 159_400,
    health: 'healthy',
  },
  {
    name: 'Redshank Travel',
    owner: 'ravi',
    plan: ACCOUNT_PLAN.team,
    region: 'emea',
    revenue: 53_600,
    health: 'at_risk',
  },
  {
    name: 'Saltmarsh Foods',
    owner: 'mei',
    plan: ACCOUNT_PLAN.business,
    region: 'amer',
    revenue: 197_800,
    health: 'healthy',
  },
  {
    name: 'Thornbury Legal',
    owner: 'sam',
    plan: ACCOUNT_PLAN.team,
    region: 'emea',
    revenue: 66_100,
    health: 'watch',
  },
  {
    name: 'Umberfield Ltd',
    owner: 'dana',
    plan: ACCOUNT_PLAN.free,
    region: 'apac',
    revenue: 0,
    health: 'watch',
  },
  {
    name: 'Vantage Cloud',
    owner: 'ravi',
    plan: ACCOUNT_PLAN.enterprise,
    region: 'amer',
    revenue: 566_300,
    health: 'healthy',
  },
  {
    name: 'Westerly Marine',
    owner: 'mei',
    plan: ACCOUNT_PLAN.business,
    region: 'apac',
    revenue: 121_500,
    health: 'at_risk',
  },
  {
    name: 'Yarrow Textiles',
    owner: 'sam',
    plan: ACCOUNT_PLAN.team,
    region: 'emea',
    revenue: 49_700,
    health: 'healthy',
  },
];

/**
 * The live account list. Seeded from `SEED_ACCOUNTS` and appended to by the account form.
 *
 * Mutable module state, deliberately: this is the demonstration's one piece of application data that a
 * mutation has to be visible in. `accounts()` returns a snapshot so a renderer cannot hold a reference
 * that changes underneath it.
 */
let accounts: Account[] = [...SEED_ACCOUNTS];

/** A new identity for the account list, so `useSyncExternalStore` sees a changed snapshot. */
let accountsVersion = 0;

export function accountsSnapshotVersion(): number {
  return accountsVersion;
}

export function appendAccount(account: Account): void {
  accounts = [...accounts, account];
  accountsVersion += 1;
}

/** Restores the seed. Exists for tests, which must not inherit rows another case created. */
export function resetAccountsForTests(): void {
  accounts = [...SEED_ACCOUNTS];
  accountsVersion += 1;
}

const REVENUE_BY_REGION: readonly RegionRevenue[] = [
  { region: 'amer', revenue: 3_890_000, growth: 12 },
  { region: 'emea', revenue: 4_140_000, growth: 8 },
  { region: 'apac', revenue: 2_810_000, growth: 31 },
  { region: 'latam', revenue: 940_000, growth: 19 },
  { region: 'mea', revenue: 610_000, growth: 24 },
];

const SIGNUPS_BY_MONTH: readonly MonthlySignups[] = [
  { month: '2026-01', signups: 118 },
  { month: '2026-02', signups: 143 },
  { month: '2026-03', signups: 129 },
  { month: '2026-04', signups: 167 },
  { month: '2026-05', signups: 181 },
  { month: '2026-06', signups: 174 },
  { month: '2026-07', signups: 203 },
  { month: '2026-08', signups: 226 },
  { month: '2026-09', signups: 198 },
  { month: '2026-10', signups: 241 },
  { month: '2026-11', signups: 268 },
  { month: '2026-12', signups: 255 },
];

const SITES: readonly Site[] = [
  {
    site: 'San Francisco',
    region: 'amer',
    country: 'US',
    lat: 37.77,
    lon: -122.42,
    accounts: 6,
    revenue: 1_640_000,
  },
  {
    site: 'Austin',
    region: 'amer',
    country: 'US',
    lat: 30.27,
    lon: -97.74,
    accounts: 4,
    revenue: 780_000,
  },
  {
    site: 'Toronto',
    region: 'amer',
    country: 'CA',
    lat: 43.65,
    lon: -79.38,
    accounts: 3,
    revenue: 610_000,
  },
  {
    site: 'London',
    region: 'emea',
    country: 'GB',
    lat: 51.51,
    lon: -0.13,
    accounts: 7,
    revenue: 1_910_000,
  },
  {
    site: 'Berlin',
    region: 'emea',
    country: 'DE',
    lat: 52.52,
    lon: 13.4,
    accounts: 5,
    revenue: 1_120_000,
  },
  {
    site: 'Stockholm',
    region: 'emea',
    country: 'SE',
    lat: 59.33,
    lon: 18.07,
    accounts: 2,
    revenue: 430_000,
  },
  {
    site: 'Singapore',
    region: 'apac',
    country: 'SG',
    lat: 1.35,
    lon: 103.82,
    accounts: 5,
    revenue: 1_240_000,
  },
  {
    site: 'Sydney',
    region: 'apac',
    country: 'AU',
    lat: -33.87,
    lon: 151.21,
    accounts: 3,
    revenue: 690_000,
  },
  {
    site: 'Tokyo',
    region: 'apac',
    country: 'JP',
    lat: 35.68,
    lon: 139.69,
    accounts: 4,
    revenue: 880_000,
  },
  {
    site: 'São Paulo',
    region: 'latam',
    country: 'BR',
    lat: -23.55,
    lon: -46.63,
    accounts: 3,
    revenue: 540_000,
  },
  {
    site: 'Mexico City',
    region: 'latam',
    country: 'MX',
    lat: 19.43,
    lon: -99.13,
    accounts: 2,
    revenue: 400_000,
  },
  {
    site: 'Dubai',
    region: 'mea',
    country: 'AE',
    lat: 25.2,
    lon: 55.27,
    accounts: 2,
    revenue: 380_000,
  },
  {
    site: 'Cape Town',
    region: 'mea',
    country: 'ZA',
    lat: -33.92,
    lon: 18.42,
    accounts: 1,
    revenue: 230_000,
  },
];

const ACTIVITY: readonly ActivityEvent[] = [
  { at: '2026-08-04', kind: ACTIVITY_KIND.signup, actor: 'dana', subject: 'Meadowgate Bank' },
  { at: '2026-08-06', kind: ACTIVITY_KIND.ticket, actor: 'mei', subject: 'Kestrel Logistics' },
  { at: '2026-08-09', kind: ACTIVITY_KIND.upgrade, actor: 'sam', subject: 'Everline Health' },
  { at: '2026-08-11', kind: ACTIVITY_KIND.signup, actor: 'ravi', subject: 'Vantage Cloud' },
  { at: '2026-08-14', kind: ACTIVITY_KIND.ticket, actor: 'dana', subject: 'Dunlin Freight' },
  { at: '2026-08-16', kind: ACTIVITY_KIND.downgrade, actor: 'mei', subject: 'Glasswing Studio' },
  { at: '2026-08-18', kind: ACTIVITY_KIND.upgrade, actor: 'dana', subject: 'Ironvale Mining' },
  { at: '2026-08-20', kind: ACTIVITY_KIND.churn, actor: 'sam', subject: 'Pelican Software' },
  { at: '2026-08-22', kind: ACTIVITY_KIND.signup, actor: 'ravi', subject: 'Thornbury Legal' },
  { at: '2026-08-24', kind: ACTIVITY_KIND.ticket, actor: 'sam', subject: 'Westerly Marine' },
  { at: '2026-08-26', kind: ACTIVITY_KIND.upgrade, actor: 'ravi', subject: 'Corvid Labs' },
  { at: '2026-08-27', kind: ACTIVITY_KIND.churn, actor: 'mei', subject: 'Umberfield Ltd' },
  { at: '2026-08-28', kind: ACTIVITY_KIND.signup, actor: 'dana', subject: 'Harrow & Vale' },
  { at: '2026-08-29', kind: ACTIVITY_KIND.ticket, actor: 'ravi', subject: 'Northaven Retail' },
  { at: '2026-08-30', kind: ACTIVITY_KIND.upgrade, actor: 'sam', subject: 'Larkfield Energy' },
];

const SEED_DEALS: readonly Deal[] = [
  {
    deal: 'Meadowgate expansion',
    account: 'Meadowgate Bank',
    stage: DEAL_STAGE.proposal,
    value: 240_000,
    owner: 'dana',
  },
  {
    deal: 'Ironvale renewal',
    account: 'Ironvale Mining',
    stage: DEAL_STAGE.qualified,
    value: 180_000,
    owner: 'dana',
  },
  {
    deal: 'Everline platform',
    account: 'Everline Health',
    stage: DEAL_STAGE.proposal,
    value: 320_000,
    owner: 'sam',
  },
  {
    deal: 'Vantage migration',
    account: 'Vantage Cloud',
    stage: DEAL_STAGE.prospect,
    value: 95_000,
    owner: 'ravi',
  },
  {
    deal: 'Corvid pilot',
    account: 'Corvid Labs',
    stage: DEAL_STAGE.prospect,
    value: 42_000,
    owner: 'mei',
  },
  {
    deal: 'Kestrel fleet',
    account: 'Kestrel Logistics',
    stage: DEAL_STAGE.qualified,
    value: 130_000,
    owner: 'mei',
  },
  {
    deal: 'Larkfield upgrade',
    account: 'Larkfield Energy',
    stage: DEAL_STAGE.won,
    value: 210_000,
    owner: 'sam',
  },
  {
    deal: 'Glasswing retainer',
    account: 'Glasswing Studio',
    stage: DEAL_STAGE.lost,
    value: 28_000,
    owner: 'mei',
  },
];

/**
 * The deal list, MUTABLE for the same reason the account list is: `advance_deal` has to change something
 * a person can see, and a table bound to `deals` has to show the change the pipeline made.
 */
let deals: readonly Deal[] = [...SEED_DEALS];

/**
 * Moves one deal to the next stage.
 *
 * **The sequence comes from `ADVANCING_STAGES` and is not written down here.** A stage inserted into that
 * list changes what advancing means everywhere at once; a copy of the order in this function would be a
 * second authority that agrees until someone edits one of them.
 *
 * Throws rather than returning a partial result when the deal is unknown or already terminal — the
 * caller turns that into a refusal the agent can read.
 */
export function advanceDeal(name: string): { readonly from: DealStage; readonly to: DealStage } {
  const deal = deals.find((candidate) => candidate.deal === name);
  if (deal === undefined) {
    throw new Error(
      `there is no deal called "${name}" — try: ${deals.map((d) => d.deal).join(', ')}`,
    );
  }
  const at = ADVANCING_STAGES.indexOf(deal.stage);
  const next = at === -1 ? undefined : ADVANCING_STAGES[at + 1];
  if (next === undefined) {
    throw new Error(`"${name}" is ${deal.stage} and cannot be advanced any further`);
  }
  deals = deals.map((candidate) =>
    candidate.deal === name ? { ...candidate, stage: next } : candidate,
  );
  return { from: deal.stage, to: next };
}

/** Restores the seed. Exists for tests, which must not inherit a stage another case advanced. */
export function resetDealsForTests(): void {
  deals = [...SEED_DEALS];
}

const COLUMNS: Readonly<Record<DataSourceName, readonly ColumnSpec[]>> = {
  [DATA_SOURCE.accounts]: [
    { key: 'name', label: 'Account', numeric: false },
    { key: 'owner', label: 'Owner', numeric: false },
    { key: 'plan', label: 'Plan', numeric: false },
    { key: 'region', label: 'Region', numeric: false },
    { key: 'revenue', label: 'Revenue', numeric: true },
    { key: 'health', label: 'Health', numeric: false },
  ],
  [DATA_SOURCE.revenue_by_region]: [
    { key: 'region', label: 'Region', numeric: false },
    { key: 'revenue', label: 'Revenue', numeric: true },
    { key: 'growth', label: 'Growth %', numeric: true },
  ],
  [DATA_SOURCE.signups_by_month]: [
    { key: 'month', label: 'Month', numeric: false },
    { key: 'signups', label: 'Signups', numeric: true },
  ],
  [DATA_SOURCE.sites]: [
    { key: 'site', label: 'Site', numeric: false },
    { key: 'region', label: 'Region', numeric: false },
    { key: 'country', label: 'Country', numeric: false },
    { key: 'accounts', label: 'Accounts', numeric: true },
    { key: 'revenue', label: 'Revenue', numeric: true },
    // Coordinates are columns like any other. The map reads them as a position; nothing else has to.
    { key: 'lat', label: 'Latitude', numeric: true },
    { key: 'lon', label: 'Longitude', numeric: true },
  ],
  [DATA_SOURCE.activity]: [
    { key: 'at', label: 'When', numeric: false },
    { key: 'kind', label: 'Event', numeric: false },
    { key: 'actor', label: 'Owner', numeric: false },
    { key: 'subject', label: 'Account', numeric: false },
  ],
  [DATA_SOURCE.deals]: [
    { key: 'deal', label: 'Deal', numeric: false },
    { key: 'account', label: 'Account', numeric: false },
    { key: 'stage', label: 'Stage', numeric: false },
    { key: 'owner', label: 'Owner', numeric: false },
    { key: 'value', label: 'Value', numeric: true },
  ],
};

/** The columns a source exposes. Feeds both the table header and a sort tool's `enum`. */
export function columnsOf(source: DataSourceName): readonly ColumnSpec[] {
  return COLUMNS[source];
}

/** The numeric columns of a source — the ones a metric tile can measure. */
export function measuresOf(source: DataSourceName): readonly ColumnSpec[] {
  return COLUMNS[source].filter((column) => column.numeric);
}

/**
 * The current rows of a source.
 *
 * `accounts` is read live so a form submission is visible in every table bound to it; the other two are
 * constants. A snapshot is returned in every case — a renderer that held the backing array would show a
 * mutation it never rendered for.
 */
export function rowsOf(source: DataSourceName): readonly Row[] {
  // **Exhaustive, with the unreachable case typed `never`.** A source added to the vocabulary and not
  // given rows here fails to compile. The chain of `if`s this replaced ended in a fallback return, so a
  // new source would have silently rendered the signups table under someone else's column headers.
  switch (source) {
    case DATA_SOURCE.accounts:
      return accounts;
    case DATA_SOURCE.revenue_by_region:
      return REVENUE_BY_REGION;
    case DATA_SOURCE.signups_by_month:
      return SIGNUPS_BY_MONTH;
    case DATA_SOURCE.sites:
      return SITES;
    case DATA_SOURCE.activity:
      return ACTIVITY;
    case DATA_SOURCE.deals:
      return deals;
    default: {
      const unhandled: never = source;
      throw new Error(`no rows for data source ${JSON.stringify(unhandled)}`);
    }
  }
}
