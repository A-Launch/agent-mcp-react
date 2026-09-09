import {
  HEALTH,
  type Health,
  PLAN,
  type Plan,
  REGION,
  type Region,
  SEGMENT,
  type Segment,
} from './vocabulary.ts';

// The dashboard's dataset: forty-eight customer accounts, generated once at module load from a fixed
// seed.
//
// Generated rather than hand-written so the file stays readable, and **deterministic** rather than
// random so the demonstration reproduces: a screenshot, a transcript and a test all describe the same
// forty-eight accounts. `Math.random()` here would mean every reload told a different story and no
// recorded agent session could be checked against the page it ran on.
//
// This is a fixture, not a store. It is never mutated — the dashboard keeps its own overrides for the
// two fields a person or an agent can change, so "the data as loaded" stays available to compare
// against.

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly segment: Segment;
  readonly region: Region;
  readonly plan: Plan;
  /** Annual recurring revenue, whole dollars. */
  readonly arr: number;
  readonly seats: number;
  /** Days until the contract renews. Negative means it has already lapsed. */
  readonly renewalInDays: number;
  readonly openTickets: number;
  readonly owner: string;
  readonly health: Health;
}

/**
 * A tiny linear congruential generator.
 *
 * Present so the fixture is reproducible; the numbers only have to look plausible, and nothing here
 * depends on them being well distributed.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const PREFIX = [
  'Northwind',
  'Cobalt',
  'Meridian',
  'Harborview',
  'Silverline',
  'Ardent',
  'Foxglove',
  'Bluepeak',
  'Ironwood',
  'Lumen',
  'Kestrel',
  'Sandpiper',
  'Verdant',
  'Basalt',
  'Tessera',
  'Halyard',
] as const;

const SUFFIX = ['Labs', 'Systems', 'Health', 'Logistics', 'Analytics', 'Robotics'] as const;

const OWNER = ['R. Okonkwo', 'M. Delacroix', 'S. Haruna', 'J. Vasquez', 'A. Lindqvist'] as const;

const SEGMENTS = Object.values(SEGMENT);
const REGIONS = Object.values(REGION);
const PLANS = Object.values(PLAN);
const HEALTHS = Object.values(HEALTH);

function build(): Account[] {
  const random = seeded(20_260_823);
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)] as T;
  const between = (low: number, high: number): number =>
    low + Math.floor(random() * (high - low + 1));

  const accounts: Account[] = [];
  const used = new Set<string>();

  // Bounded, not `while (accounts.length < 48)`. The name space is finite, and a generator that could
  // spin forever on an exhausted one is a page that hangs at import with no error anywhere.
  for (let attempt = 0; accounts.length < 48 && attempt < 1_000; attempt += 1) {
    const name = `${pick(PREFIX)} ${pick(SUFFIX)}`;
    // A collision would produce two rows a person could not tell apart, and an agent asked to open
    // "Cobalt Labs" would have no way to say which. Skipped rather than de-duplicated with a suffix.
    if (used.has(name)) continue;
    used.add(name);

    const segment = pick(SEGMENTS);
    const seats =
      segment === SEGMENT.enterprise
        ? between(400, 4_000)
        : segment === SEGMENT.midmarket
          ? between(60, 400)
          : between(3, 60);

    accounts.push({
      id: `acct_${String(accounts.length + 1).padStart(3, '0')}`,
      name,
      segment,
      region: pick(REGIONS),
      plan: pick(PLANS),
      // Priced off seats so the table's two numeric columns correlate the way a real one would, which
      // is what makes a sort by ARR tell a different story from a sort by seats.
      arr: seats * between(90, 260),
      seats,
      renewalInDays: between(-20, 330),
      openTickets: between(0, 14),
      owner: pick(OWNER),
      health: pick(HEALTHS),
    });
  }

  if (accounts.length < 48) {
    throw new Error(
      `the fixture generator produced only ${String(accounts.length)} distinct account names`,
    );
  }

  return accounts;
}

/** The fixture, as loaded. Never mutated; the dashboard layers its edits on top. */
export const ACCOUNTS: readonly Account[] = build();
