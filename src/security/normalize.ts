import {
  type AgentCapabilities,
  CAPABILITY_MEMBER,
  DOM_AUTHORITY,
  isCapabilityMember,
  isDomAuthority,
} from './vocabulary.ts';

// Turning what an application handed the provider into a capability set the gates can read — or
// refusing it by name.
//
// **Why a normalizer exists at all, when TypeScript already declares the shape.** The provider is a
// boundary: the value arrives from application code that may be JavaScript, may be JSON from a
// configuration service, and may have been widened by a cast. A type is a claim about the code that
// compiled; this is the check on the value that arrived — a closed set is validated at every boundary
// it crosses, never cast onto a type that does not admit it.
//
// **Two rules, and they point in opposite directions on purpose**:
//
//   - An **omitted** member is denied. Absent is not a question — authority only narrows, so an
//     unwritten member grants nothing — and a set that says nothing about `evaluate` gets
//     `evaluate: false` and no complaint.
//   - An **unknown** member is refused, loudly. `{ dom: true, storage: true }` is an author who
//     believes they granted something. Ignoring the extra key would leave them believing it, and would
//     make a future capability name silently inert on every page written before it existed.
//
// Nothing here decides whether a call may proceed — `resolve.ts` does that, and it is handed a set
// this file has already vouched for. This module does no I/O, holds no state, and **never throws** —
// including when reading the value runs application code, which it can: a getter can throw and a proxy
// can refuse to enumerate. Those become a named refusal rather than an exception, because a set that
// would not answer is a denial, and because whatever an application threw is not this library's to
// carry anywhere.

/** What is wrong with a supplied capability set. Closed, so a caller branches rather than parses. */
export const CAPABILITY_PROBLEM = {
  /** The set, or its `dom` member, is not an object — `null`, an array, a string, a boolean. */
  notAnObject: 'notAnObject',
  /** A key that is not a capability member, or a `dom` key that is not one of its two authorities. */
  unknownMember: 'unknownMember',
  /** A member is present and is not a boolean. */
  notABoolean: 'notABoolean',
  /**
   * A member could not be read at all — a getter that threw, a proxy that refused.
   *
   * Its own kind rather than folded into `notABoolean`, because the two say different things to an
   * author: one is a value of the wrong type, the other is an object that would not answer. Reported
   * rather than allowed to escape: whatever the getter threw is application code's, its message is
   * exactly where a credential ends up, and a set that could not be read is a denial rather than an
   * exception nobody expected from a capability prop.
   */
  unreadable: 'unreadable',
} as const;

export type CapabilityProblemKind = (typeof CAPABILITY_PROBLEM)[keyof typeof CAPABILITY_PROBLEM];

export interface CapabilityProblem {
  readonly problem: CapabilityProblemKind;
  /**
   * Where in the set, as a dotted path — `''` for the set itself, `dom.inspect` for a half.
   *
   * It names a **key**, never a value. A value is what an author typed and could be anything; a
   * message that repeated it would be the same leak the validation diagnostics had.
   */
  readonly at: string;
}

export type CapabilityNormalization =
  | { readonly ok: true; readonly capabilities: AgentCapabilities }
  | { readonly ok: false; readonly problems: readonly CapabilityProblem[] };

/**
 * The set that admits nothing.
 *
 * **Not a default profile.** There is no such thing here, and this is its opposite: the value a boundary holds
 * while it has no usable set, so that a gate consulted in that window denies rather than reading
 * `undefined` and deciding what to do about it. Nothing selects it as a convenience — the provider
 * refuses to start when it is in force.
 */
export const DENIES_EVERYTHING: AgentCapabilities = Object.freeze({
  application: false,
  dom: Object.freeze({ inspect: false, interact: false }),
  evaluate: false,
});

/**
 * Checks and completes a supplied capability set.
 *
 * Every problem is collected before returning, rather than the first one thrown: an author with two
 * typos should see two, not discover the second after fixing the first.
 */
export function normalizeCapabilities(input: unknown): CapabilityNormalization {
  // **Everything below is inside this guard, and the guard is not defensive padding.** Reading a
  // property can run application code: a getter can throw, and a proxy can refuse `ownKeys`. This
  // module's whole contract is that it decides and never throws — a throw here would escape into the
  // provider's render carrying an application's own error message, which is precisely where a
  // credential ends up and is not this library's to publish. A set that would not answer is a denial.
  try {
    return read(input);
  } catch {
    return { ok: false, problems: [{ problem: CAPABILITY_PROBLEM.unreadable, at: '' }] };
  }
}

function read(input: unknown): CapabilityNormalization {
  const record = asRecord(input);
  if (record === undefined) {
    return { ok: false, problems: [{ problem: CAPABILITY_PROBLEM.notAnObject, at: '' }] };
  }

  const problems: CapabilityProblem[] = [];

  for (const key of Object.keys(record)) {
    if (!isCapabilityMember(key)) {
      problems.push({ problem: CAPABILITY_PROBLEM.unknownMember, at: key });
    }
  }

  const application = readFlag(record, CAPABILITY_MEMBER.application, '', problems);
  const evaluate = readFlag(record, CAPABILITY_MEMBER.evaluate, '', problems);
  const dom = readDom(readMember(record, CAPABILITY_MEMBER.dom, problems), problems);

  // A single problem anywhere makes the whole set unusable, rather than yielding a partial one with
  // the good members kept. An unresolvable set denies. A set that was half-understood is exactly the
  // hidden unknown this library refuses to produce — the author would be running under capabilities
  // nobody wrote down.
  if (problems.length > 0) return { ok: false, problems };

  // **Frozen, and the freeze is a gate rather than hygiene.** The runtime reads the granted set LIVE
  // at every capability check — `capabilities: () => capabilitiesRef.current` — so whoever holds this
  // object holds the connection's authority. `useMcpCapabilities` publishes it to application code,
  // and without this an application could write `capabilities.evaluate = true` and reach Level 3 with
  // no operator anywhere in the story. That is the one change whose blast radius is the whole page,
  // and it is exactly the widening the model forbids: authority only narrows, and nothing below the
  // provider's set may widen it.
  //
  // Frozen HERE, at the single place the value is built, rather than at the hook that publishes it.
  // A copy made by the publisher would leave this object writable for every other holder — including
  // the gate's own reference — so the protection would cover the surface and not the authority, and
  // one owner for the freeze is the point. `dom` is frozen too; a shallow freeze leaves the nested
  // pair writable and `dom.interact` is a capability in its own right.
  return {
    ok: true,
    capabilities: Object.freeze({ application, dom: Object.freeze(dom), evaluate }),
  };
}

/**
 * A stable string that changes exactly when the granted set does.
 *
 * Exists so a renderer can depend on the *value* of a capability set rather than on the identity of
 * the object carrying it: `capabilities={{ ... }}` is a new object on every render, and an effect
 * keyed on it would fire on every render while a set that genuinely changed inside a memoized object
 * would fire on none.
 *
 * Written from the dictionaries in a fixed order, so key order in the author's literal cannot make two
 * identical sets look different.
 */
export function capabilitySignature(capabilities: AgentCapabilities): string {
  return [
    `${CAPABILITY_MEMBER.application}=${capabilities.application}`,
    `${CAPABILITY_MEMBER.dom}.${DOM_AUTHORITY.inspect}=${capabilities.dom.inspect}`,
    `${CAPABILITY_MEMBER.dom}.${DOM_AUTHORITY.interact}=${capabilities.dom.interact}`,
    `${CAPABILITY_MEMBER.evaluate}=${capabilities.evaluate}`,
  ].join(' ');
}

/** Renders problems as one sentence, naming keys and never values. */
export function describeProblems(problems: readonly CapabilityProblem[]): string {
  return problems
    .map(({ problem, at }) => {
      const where = at === '' ? 'the capability set' : `"${at}"`;
      if (problem === CAPABILITY_PROBLEM.notAnObject) return `${where} is not an object`;
      if (problem === CAPABILITY_PROBLEM.unknownMember) return `${where} is not a capability`;
      if (problem === CAPABILITY_PROBLEM.unreadable) return `${where} could not be read`;
      return `${where} is not a boolean`;
    })
    .join('; ');
}

/** Reads one own member's raw value, naming it if it will not be read. */
function readMember(
  record: Record<string, unknown>,
  key: string,
  problems: CapabilityProblem[],
): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  try {
    return record[key];
  } catch {
    problems.push({ problem: CAPABILITY_PROBLEM.unreadable, at: key });
    return undefined;
  }
}

/** An object that is not an array, or nothing. `null` and arrays are not capability sets. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Reads one boolean member. Absent is `false` and is not a problem; present and wrong is.
 *
 * **Own properties only, and the two halves of this file must agree about that.** The unknown-member
 * scan above walks `Object.keys`, which is own-and-enumerable. Reading with a plain index would follow
 * the prototype chain, so `Object.create({ evaluate: true })` would be GRANTED `evaluate` by a member
 * the scan never saw and never checked — a capability arriving from a place nothing validates.
 *
 * Reading own properties only makes an inherited member invisible to both halves: not scanned, not
 * granted, denied by absence. That is the safe direction and the consistent one.
 */
function readFlag(
  record: Record<string, unknown>,
  key: string,
  prefix: string,
  problems: CapabilityProblem[],
): boolean {
  if (!Object.hasOwn(record, key)) return false;

  // Per-member, so ONE unreadable getter names its own key instead of collapsing the whole set into
  // "could not be read". The outer guard still stands behind this: it catches what happens before any
  // member is reached, such as a proxy that refuses to enumerate.
  let value: unknown;
  try {
    value = record[key];
  } catch {
    problems.push({ problem: CAPABILITY_PROBLEM.unreadable, at: `${prefix}${key}` });
    return false;
  }

  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  problems.push({ problem: CAPABILITY_PROBLEM.notABoolean, at: `${prefix}${key}` });
  return false;
}

/** Reads the DOM pair. An absent `dom` grants neither half; a malformed one is refused. */
function readDom(value: unknown, problems: CapabilityProblem[]): AgentCapabilities['dom'] {
  if (value === undefined) return { inspect: false, interact: false };

  const record = asRecord(value);
  if (record === undefined) {
    // Including `dom: true`. A boolean cannot say which half it meant, and admitting it would grant
    // `interact` to an author who believed they were granting a read — the one confusion the pair
    // exists to make impossible.
    problems.push({ problem: CAPABILITY_PROBLEM.notAnObject, at: CAPABILITY_MEMBER.dom });
    return { inspect: false, interact: false };
  }

  const prefix = `${CAPABILITY_MEMBER.dom}.`;
  for (const key of Object.keys(record)) {
    if (!isDomAuthority(key)) {
      problems.push({ problem: CAPABILITY_PROBLEM.unknownMember, at: `${prefix}${key}` });
    }
  }

  return {
    inspect: readFlag(record, DOM_AUTHORITY.inspect, prefix, problems),
    interact: readFlag(record, DOM_AUTHORITY.interact, prefix, problems),
  };
}
