// The dashboard's closed vocabularies: every value a filter, a column or a tool argument may take.
//
// One exported `as const` dictionary per set, with the type and the membership test derived from it
// and never re-spelled anywhere else. Nothing in this example spells one of these as a string
// literal, and no tool
// casts a received string onto one of these types without passing it through the matching guard —
// an agent sends whatever it likes, and the argument that arrives is untrusted text until a guard
// says otherwise.
//
// What this module owns: the vocabulary and its guards. It owns no data, no state and no rendering.

/** Commercial tier. Drives pricing expectations and who owns the relationship. */
export const SEGMENT = {
  enterprise: 'enterprise',
  midmarket: 'midmarket',
  startup: 'startup',
} as const;
export type Segment = (typeof SEGMENT)[keyof typeof SEGMENT];

/** Sales region. */
export const REGION = {
  amer: 'amer',
  emea: 'emea',
  apac: 'apac',
} as const;
export type Region = (typeof REGION)[keyof typeof REGION];

/** How the relationship is doing. The one field a person or an agent changes by hand. */
export const HEALTH = {
  healthy: 'healthy',
  watch: 'watch',
  at_risk: 'at_risk',
  churning: 'churning',
} as const;
export type Health = (typeof HEALTH)[keyof typeof HEALTH];

/** Subscription plan. */
export const PLAN = {
  free: 'free',
  team: 'team',
  business: 'business',
  scale: 'scale',
} as const;
export type Plan = (typeof PLAN)[keyof typeof PLAN];

/** Every column the table can be ordered by. */
export const SORT_FIELD = {
  name: 'name',
  arr: 'arr',
  seats: 'seats',
  health: 'health',
  renewalInDays: 'renewalInDays',
  openTickets: 'openTickets',
} as const;
export type SortField = (typeof SORT_FIELD)[keyof typeof SORT_FIELD];

export const SORT_DIRECTION = {
  asc: 'asc',
  desc: 'desc',
} as const;
export type SortDirection = (typeof SORT_DIRECTION)[keyof typeof SORT_DIRECTION];

/**
 * Who caused a transition.
 *
 * Provenance, and deliberately NOT a second code path: both actors call the same function and the
 * value only records which one did. A design where the agent had its own transition would be the
 * defect this whole library exists to prevent, and it would be invisible in a screenshot — which is
 * exactly why the activity log prints this field.
 */
export const ACTOR = {
  person: 'person',
  agent: 'agent',
} as const;
export type Actor = (typeof ACTOR)[keyof typeof ACTOR];

/** Builds a membership test over a dictionary's values. The one place that logic is written. */
function memberOf<T extends Record<string, string>>(
  dictionary: T,
): (value: unknown) => value is T[keyof T] {
  const values = new Set<string>(Object.values(dictionary));
  return (value: unknown): value is T[keyof T] => typeof value === 'string' && values.has(value);
}

export const isSegment = memberOf(SEGMENT);
export const isRegion = memberOf(REGION);
export const isHealth = memberOf(HEALTH);
export const isPlan = memberOf(PLAN);
export const isSortField = memberOf(SORT_FIELD);
export const isSortDirection = memberOf(SORT_DIRECTION);

/** Human labels for the values above. Presentation only — never parsed back into a value. */
export const LABEL: Readonly<Record<string, string>> = {
  [SEGMENT.enterprise]: 'Enterprise',
  [SEGMENT.midmarket]: 'Mid-market',
  [SEGMENT.startup]: 'Startup',
  [REGION.amer]: 'AMER',
  [REGION.emea]: 'EMEA',
  [REGION.apac]: 'APAC',
  [HEALTH.healthy]: 'Healthy',
  [HEALTH.watch]: 'Watch',
  [HEALTH.at_risk]: 'At risk',
  [HEALTH.churning]: 'Churning',
  [PLAN.free]: 'Free',
  [PLAN.team]: 'Team',
  [PLAN.business]: 'Business',
  [PLAN.scale]: 'Scale',
  [SORT_FIELD.name]: 'Account',
  [SORT_FIELD.arr]: 'ARR',
  [SORT_FIELD.seats]: 'Seats',
  [SORT_FIELD.health]: 'Health',
  [SORT_FIELD.renewalInDays]: 'Renewal',
  [SORT_FIELD.openTickets]: 'Tickets',
};
