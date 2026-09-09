import type { Account } from '../domain/accounts.ts';
import {
  HEALTH,
  type Health,
  type Plan,
  type Region,
  type Segment,
  SORT_DIRECTION,
  SORT_FIELD,
  type SortDirection,
  type SortField,
} from '../domain/vocabulary.ts';

// The `is*` guards are no longer imported here, and that absence is the point. Every
// one of them was called by this module to check a tool argument against a closed vocabulary; the
// library now does that against the schema each tool declares, in the runtime, before the handler is
// entered. The guards themselves still exist and are still used where a value arrives from somewhere
// with no schema.

// The dashboard's query model and the pure functions that apply it.
//
// Everything here is a pure function of (accounts, filters, sort). Nothing reads React, nothing reads
// the registry, and nothing mutates its input — which is what lets the same code answer both "what
// should the table render" and "what should the `customers.list` tool return", instead of the table
// and the tool drifting into two different notions of what is on screen.
//
// Boundary: this module DECIDES nothing about who may ask. It has no idea an agent exists.

export interface Filters {
  /** Free text, matched against account name and owner. */
  readonly query: string;
  readonly segments: readonly Segment[];
  readonly regions: readonly Region[];
  readonly health: readonly Health[];
  readonly plans: readonly Plan[];
  /** Inclusive ARR bounds in whole dollars. `null` means unbounded on that side. */
  readonly arrMin: number | null;
  readonly arrMax: number | null;
  /** Keep only contracts renewing within this many days. `null` means every renewal date. */
  readonly renewalWithinDays: number | null;
  /** Keep only accounts with at least one open support ticket. */
  readonly openTicketsOnly: boolean;
}

export interface Sort {
  readonly field: SortField;
  readonly direction: SortDirection;
}

/**
 * Every field a filter request may name, as a closed set.
 *
 * Exists so `clear` can be an enum rather than free text: an agent that misspells a field name is
 * refused by the vocabulary instead of clearing nothing and reporting success. A closed set declared
 * once, with the enum each tool advertises derived from it.
 */
export const FILTER_FIELD = {
  query: 'query',
  segments: 'segments',
  regions: 'regions',
  health: 'health',
  plans: 'plans',
  arrMin: 'arrMin',
  arrMax: 'arrMax',
  renewalWithinDays: 'renewalWithinDays',
  openTicketsOnly: 'openTicketsOnly',
} as const;
export type FilterField = (typeof FILTER_FIELD)[keyof typeof FILTER_FIELD];

/** No filter applied. The state a cleared dashboard returns to, and the shape a reset writes. */
export const NO_FILTERS: Filters = {
  query: '',
  segments: [],
  regions: [],
  health: [],
  plans: [],
  arrMin: null,
  arrMax: null,
  renewalWithinDays: null,
  openTicketsOnly: false,
};

export const DEFAULT_SORT: Sort = {
  field: SORT_FIELD.arr,
  direction: SORT_DIRECTION.desc,
};

/** Ordering for the one column whose natural order is neither alphabetical nor numeric. */
const HEALTH_RANK: Readonly<Record<Health, number>> = {
  [HEALTH.churning]: 0,
  [HEALTH.at_risk]: 1,
  [HEALTH.watch]: 2,
  [HEALTH.healthy]: 3,
};

/** Whether one account survives the filter set. */
function matches(account: Account, filters: Filters): boolean {
  const query = filters.query.trim().toLowerCase();
  if (query !== '') {
    const haystack = `${account.name} ${account.owner}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (filters.segments.length > 0 && !filters.segments.includes(account.segment)) return false;
  if (filters.regions.length > 0 && !filters.regions.includes(account.region)) return false;
  if (filters.health.length > 0 && !filters.health.includes(account.health)) return false;
  if (filters.plans.length > 0 && !filters.plans.includes(account.plan)) return false;
  if (filters.arrMin !== null && account.arr < filters.arrMin) return false;
  if (filters.arrMax !== null && account.arr > filters.arrMax) return false;
  if (filters.renewalWithinDays !== null && account.renewalInDays > filters.renewalWithinDays) {
    return false;
  }
  if (filters.openTicketsOnly && account.openTickets === 0) return false;
  return true;
}

function compare(left: Account, right: Account, field: SortField): number {
  if (field === SORT_FIELD.name) return left.name.localeCompare(right.name);
  if (field === SORT_FIELD.health) return HEALTH_RANK[left.health] - HEALTH_RANK[right.health];
  return left[field] - right[field];
}

/**
 * The visible rows, in order.
 *
 * Sorts a copy: the caller's array is a fixture shared by everything on the page, and sorting in
 * place would reorder it for every other reader without anyone asking.
 */
export function selectRows(
  accounts: readonly Account[],
  filters: Filters,
  sort: Sort,
): readonly Account[] {
  const rows = accounts.filter((account) => matches(account, filters));
  const sign = sort.direction === SORT_DIRECTION.asc ? 1 : -1;
  return [...rows].sort((left, right) => sign * compare(left, right, sort.field));
}

export interface Totals {
  readonly matched: number;
  readonly total: number;
  readonly arr: number;
  readonly seats: number;
  readonly openTickets: number;
  readonly byHealth: Readonly<Record<Health, number>>;
}

/** The aggregates the summary bar shows and the `dashboard.describe` tool reports. One computation. */
export function summarize(rows: readonly Account[], total: number): Totals {
  const byHealth: Record<Health, number> = {
    [HEALTH.healthy]: 0,
    [HEALTH.watch]: 0,
    [HEALTH.at_risk]: 0,
    [HEALTH.churning]: 0,
  };
  let arr = 0;
  let seats = 0;
  let openTickets = 0;
  for (const row of rows) {
    byHealth[row.health] += 1;
    arr += row.arr;
    seats += row.seats;
    openTickets += row.openTickets;
  }
  return { matched: rows.length, total, arr, seats, openTickets, byHealth };
}

/** Which filters are actually narrowing the list, named for a person and for an agent alike. */
export function activeFilterNames(filters: Filters): string[] {
  const active: string[] = [];
  if (filters.query.trim() !== '') active.push('query');
  if (filters.segments.length > 0) active.push('segments');
  if (filters.regions.length > 0) active.push('regions');
  if (filters.health.length > 0) active.push('health');
  if (filters.plans.length > 0) active.push('plans');
  if (filters.arrMin !== null) active.push('arrMin');
  if (filters.arrMax !== null) active.push('arrMax');
  if (filters.renewalWithinDays !== null) active.push('renewalWithinDays');
  if (filters.openTicketsOnly) active.push('openTicketsOnly');
  return active;
}

/**
 * The value each narrowing filter is set to, omitting every filter that is not narrowing anything.
 *
 * The companion to `activeFilterNames`, and deliberately built from the SAME conditions in the same
 * order: `active` says which filters are on, this says what they are set to, and the two disagreeing
 * would be a state read that contradicts itself. Kept in one file for that reason — a second place
 * deciding what counts as "narrowing" is a second answer.
 *
 * Exists because a name alone cannot be verified against. An agent that applied `health: ['at_risk']`
 * and reads back `active: ['health']` learns only that SOME health filter is on, which is not enough
 * to confirm its own call landed — which is what exposing state is for (docs/exposing-state.md), and
 * what step 10 of the acceptance scenario (docs/design.md#the-acceptance-scenario) asks for.
 */
export function narrowingValues(filters: Filters): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (filters.segments.length > 0) values.segments = [...filters.segments];
  if (filters.regions.length > 0) values.regions = [...filters.regions];
  if (filters.health.length > 0) values.health = [...filters.health];
  if (filters.plans.length > 0) values.plans = [...filters.plans];
  if (filters.arrMin !== null) values.arrMin = filters.arrMin;
  if (filters.arrMax !== null) values.arrMax = filters.arrMax;
  if (filters.renewalWithinDays !== null) values.renewalWithinDays = filters.renewalWithinDays;
  if (filters.openTicketsOnly) values.openTicketsOnly = true;
  return values;
}

/**
 * Turns a validated filter request into a patch over the current filters.
 *
 * **This function used to validate, and no longer does.** Every field it checked — that `segments`
 * holds members of the segment vocabulary, that `arrMin` is a finite number, that `clear` names real
 * fields — is now checked by the library against this tool's declared `inputSchema`, in the runtime,
 * before the handler runs. Roughly a hundred lines went with that change, and the refusals got BETTER
 * rather than worse: the library names the rejected value and the permitted set, which is what these
 * checks did by hand and what the SDK's own validator adapter does not do.
 *
 * What remains is **normalization**, which no validator performs: `clear` names fields and this turns
 * each into the value that clears it. Deleting this along with the validation would have changed what
 * the tool does, not merely where it is checked.
 *
 * The arguments arriving here have already matched the schema, so nothing below re-checks a type.
 */
export function readFilterPatch(input: Record<string, unknown>): Partial<Filters> {
  const patch: Record<string, unknown> = {};

  if ('clear' in input) {
    // Normalization, not validation: the schema already established that every entry is one of the
    // nine field names. What is left is the domain step of turning a name into the value that clears
    // that field, which is knowledge only this module has.
    for (const field of input.clear as FilterField[]) {
      patch[field] = NO_FILTERS[field];
    }
  }

  for (const field of ['query', 'segments', 'regions', 'health', 'plans'] as const) {
    if (field in input) patch[field] = input[field];
  }
  for (const field of ['arrMin', 'arrMax', 'renewalWithinDays', 'openTicketsOnly'] as const) {
    if (field in input) patch[field] = input[field];
  }

  return patch as Partial<Filters>;
}

/**
 * Merges a sort request with the sort currently in force.
 *
 * Both fields are optional, so omitting one means "leave it alone" — a merge no validator performs and
 * the reason this function is still here while the type checks it used to run are not: the library
 * validates arguments against the declared schema in the runtime, before the handler is entered. The
 * values arriving here have already been checked against the declared enums.
 */
export function readSort(input: Record<string, unknown>, current: Sort): Sort {
  return {
    field: (input.field as SortField | undefined) ?? current.field,
    direction: (input.direction as SortDirection | undefined) ?? current.direction,
  };
}
