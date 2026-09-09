// What happened to one tool call, as data an application can be handed
// (`docs/observing-tool-calls.md`).
//
// This file owns the VOCABULARY and nothing else: it decides no admission, performs no I/O, imports no
// React and touches no socket. `src/runtime/observation.ts` builds records from it; two instrumentation
// sites fill them in; `src/react/` hands them to an application; `src/devtools/` renders them.
//
// **Why a record exists at all.** A call has to be explainable after the fact — which tool, admitted
// or denied by WHICH STEP, and what the application then did. A refusal an observer cannot attribute
// to a specific step is an unexplainable state, and an unexplainable state is indistinguishable from a
// wrong one.

import type { RuntimeFailureCode } from './errors.ts';
import { GATE_CHAIN } from './gate-chain.ts';
import { RESOLUTION, type Resolution } from './resolution.ts';

/**
 * What ONE step did, for ONE call.
 *
 * **Deliberately not `GATE_STEP_STATE`, and a case asserts the two stay disjoint.** That set —
 * `built` | `unbuilt` | `elsewhere` — is a property of the BUILD: it answers "has this repository
 * implemented that step", and it is identical for every call that ever runs. This one is a property of
 * a single call. A call arriving through the page's own registry route skips a step that is fully
 * `built`; recording that as `unbuilt` would claim the repository had not implemented it, which is a
 * category error that reads as a tidy reuse.
 */
export const GATE_OUTCOME = {
  /**
   * The step executed and did not refuse.
   *
   * Covers "checked and admitted" AND "executed with nothing to check" — a tool that declared no input
   * schema passes `validate`. That is not a conflation being hidden: whether a schema was declared is
   * visible in the tool's own descriptor, and a tool that declares one with no validator installed is
   * not registered at all, so "passed with nothing to check" is never ambiguous in practice.
   */
  passed: 'passed',
  /** The step executed and refused this call. At most one step per call is ever `refused`. */
  refused: 'refused',
  /**
   * The step did not execute for this call.
   *
   * Two absences, deliberately one member: a step outside this route's path, and every step AFTER a
   * refusal. Both are "no verdict was reached here", and the alternative — omitting the step — reads
   * to a consumer as a pass, which is the failure this member exists to prevent: a step that
   * reached no verdict must never be indistinguishable from one that admitted the call.
   */
  notRun: 'notRun',
} as const;

export type GateOutcome = (typeof GATE_OUTCOME)[keyof typeof GATE_OUTCOME];

/** Membership derived from the dictionary, so a new outcome cannot be half-added. */
const GATE_OUTCOMES: ReadonlySet<string> = new Set(Object.values(GATE_OUTCOME));

export function isGateOutcome(value: string): value is GateOutcome {
  return GATE_OUTCOMES.has(value);
}

/**
 * How the call reached the tool.
 *
 * **Required on every record, never inferred from an absence.** A consumer that had to deduce the
 * route from a missing field would deduce it wrongly the first time a field was added.
 *
 * It says only HOW, and never WHO. A JavaScript call carries no trustworthy caller identity — a
 * widget, a browser extension and the application's own code are indistinguishable at the callback —
 * so naming a caller would be presenting a guess as a fact. A stated absence is the honest record;
 * a guess dressed as evidence is not.
 */
export const CALL_ROUTE = {
  /** The agent's `tools/call` over the socket. Passes all six built steps. */
  bridge: 'bridge',
  /**
   * Any script in the page, through the document's shared tool registry.
   *
   * Gated by the declared schema and by nothing else: no capability step, no availability policy and
   * no confirmation, because those govern this library's BRIDGE and not the page
   * (`docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page`). A tool
   * marked `available: false` still runs here — which is the consequence this route being
   * observable exists to make visible rather than leave as a documentation paragraph.
   */
  registry: 'registry',
} as const;

export type CallRoute = (typeof CALL_ROUTE)[keyof typeof CALL_ROUTE];

const CALL_ROUTES: ReadonlySet<string> = new Set(Object.values(CALL_ROUTE));

export function isCallRoute(value: string): value is CallRoute {
  return CALL_ROUTES.has(value);
}

/**
 * Which point in a call's life this record describes.
 *
 * **A required discriminant rather than an optional timestamp.** Distinguishing a start from a
 * terminal by whether `settledAt` is present produces a union that cannot be narrowed and a shape a
 * consumer reads wrongly — and the two terminal kinds could not be told apart at all.
 */
export const CALL_PHASE = {
  start: 'start',
  result: 'result',
  error: 'error',
} as const;

export type CallPhase = (typeof CALL_PHASE)[keyof typeof CALL_PHASE];

const CALL_PHASES: ReadonlySet<string> = new Set(Object.values(CALL_PHASE));

export function isCallPhase(value: string): value is CallPhase {
  return CALL_PHASES.has(value);
}

/**
 * What an event may carry.
 *
 * `metadata` is the default in EVERY build, development included. A build flag is not consent to
 * capture sensitive data, and a default that differed by build would mean the shape an author develops
 * against is not the shape they ship — leaving the production shape the one never exercised.
 */
export const OBSERVED_PAYLOADS = {
  /** An allowlist of library-owned facts. Never a value the caller sent, and never anything derived from one. */
  metadata: 'metadata',
  /** The above, plus a bounded detached snapshot of arguments and result. Explicit opt-in only. */
  values: 'values',
} as const;

export type ObservedPayloads = (typeof OBSERVED_PAYLOADS)[keyof typeof OBSERVED_PAYLOADS];

const OBSERVED_PAYLOAD_MODES: ReadonlySet<string> = new Set(Object.values(OBSERVED_PAYLOADS));

export function isObservedPayloads(value: string): value is ObservedPayloads {
  return OBSERVED_PAYLOAD_MODES.has(value);
}

/**
 * The resolution cases that are a REFUSAL, derived from `RESOLUTION` by excluding the two that succeed.
 *
 * `RESOLUTION` has five members and only three of them can end a call: `builtIn` and `owned` are
 * successful resolutions, and a record never carries them as a cause. Derived rather than re-spelled,
 * so a sixth member added there cannot be silently missing here — the dictionary stays the one
 * owner of the set.
 */
export type ResolutionRefusal = Exclude<
  Resolution,
  typeof RESOLUTION.builtIn | typeof RESOLUTION.owned
>;

const RESOLUTION_REFUSALS: ReadonlySet<string> = new Set(
  Object.values(RESOLUTION).filter(
    (member) => member !== RESOLUTION.builtIn && member !== RESOLUTION.owned,
  ),
);

export function isResolutionRefusal(value: string): value is ResolutionRefusal {
  return RESOLUTION_REFUSALS.has(value);
}

/**
 * Which closed vocabulary a failure code came from.
 *
 * **Three sources, not one, and pretending otherwise would misattribute a failure.** The bridge route
 * refuses with `RuntimeFailureCode`; the page's registry route refuses with the React module's own
 * codes; and an application handler that throws may carry NO code at all. Giving that third case a
 * borrowed code would tell an operator a check refused the call when the application simply failed.
 */
export const FAILURE_VOCABULARY = {
  /** `RuntimeFailureCode` — a refusal or failure produced by the runtime, on the bridge route. */
  runtime: 'runtime',
  /**
   * The route's own refusal vocabulary.
   *
   * Typed by the caller rather than named here: `src/runtime/` may not import `src/react/`, because
   * the dependency arrow runs `react/ ──▶ runtime/` and inverting it — even for a type — is the
   * layering inversion that makes the runtime untestable without a renderer.
   */
  route: 'route',
  /** An application handler threw something carrying no code of ours. Reported as uncoded, never given one. */
  uncoded: 'uncoded',
} as const;

export type FailureVocabulary = (typeof FAILURE_VOCABULARY)[keyof typeof FAILURE_VOCABULARY];

const FAILURE_VOCABULARIES: ReadonlySet<string> = new Set(Object.values(FAILURE_VOCABULARY));

export function isFailureVocabulary(value: string): value is FailureVocabulary {
  return FAILURE_VOCABULARIES.has(value);
}

/**
 * Why a call ended, tagged with which vocabulary names it.
 *
 * Generic in the route's code so `src/react/` can publish a precise type (`ObservedFailure<
 * ReactRefusedCode>`) without this file naming a React code. The default keeps the runtime's own use
 * simple; the precision is free where it is available.
 */
export type ObservedFailure<TRouteCode extends string = string> =
  | { readonly vocabulary: typeof FAILURE_VOCABULARY.runtime; readonly code: RuntimeFailureCode }
  | { readonly vocabulary: typeof FAILURE_VOCABULARY.route; readonly code: TRouteCode }
  | { readonly vocabulary: typeof FAILURE_VOCABULARY.uncoded };

/** The name of a step in the chain, as a literal union — which is why `GATE_CHAIN` uses `satisfies`. */
export type GateStepName = (typeof GATE_CHAIN)[number]['name'];

/** What one step did, paired with which step it was. */
export interface ObservedGate {
  readonly step: GateStepName;
  readonly outcome: GateOutcome;
}

/**
 * One record. A start, or one of the two terminals.
 *
 * **A terminal describes the call's FINAL outcome, never merely that the handler settled.** After a
 * handler resolves, the runtime can still fail the call — an unserializable result, a violated output
 * schema, or a cancellation landing inside asynchronous output validation. Instrumentation that
 * emitted on handler resolution would produce a SECOND terminal for each of those, and would look
 * correct in every test that only exercised a plain success.
 */
export interface ObservedCall<TRouteCode extends string = string> {
  readonly phase: CallPhase;
  /**
   * Correlates a start with its terminal.
   *
   * Monotonic from 1, and unique **within one emitting module instance** — not "per document". Two
   * bundled copies of this library each hold their own counter, and a copy that mounts after another
   * unmounts starts again at 1. That residue is not fixable with a well-known symbol, because the
   * emitter would still be per-copy: an inspector imported from one copy sees nothing from the other
   * regardless. The narrower promise is the true one.
   *
   * It is NOT an identity and NOT a credential — it is enumerable by design and grants nothing — and
   * it must never be presented where it could be read as the page instance's id, which is separately
   * minted and separately owned.
   */
  readonly callId: number;
  /** The tool's name. An identifier the caller already holds, so always present. */
  readonly name: string;
  readonly route: CallRoute;
  readonly startedAt: number;
  /** Present on a terminal only. */
  readonly settledAt?: number;
  /** One entry per step of the chain, in the chain's order. */
  readonly gates: readonly ObservedGate[];
  /** Present only when the resolve step refused. */
  readonly resolution?: ResolutionRefusal;
  /** Present only on an `error` phase. */
  readonly failure?: ObservedFailure<TRouteCode>;
  /** Present only under `OBSERVED_PAYLOADS.values`, as a bounded detached snapshot. */
  readonly arguments?: unknown;
  /** Present only under `OBSERVED_PAYLOADS.values`, as a bounded detached snapshot. */
  readonly result?: unknown;
}

/**
 * The counter behind `callId`.
 *
 * Module-level rather than provider-scoped **because a remount must not restart it**: two records in
 * one retained ring sharing an identity is a correlation that is wrong, and a wrong correlation looks
 * exactly like a right one.
 *
 * It needs no source of randomness, which is the point — `src/page-identity.ts` is the only file
 * permitted to name the platform's unique-value source, and a second mint site is a second chance to
 * add a fallback that cannot be told from success. A counter names none.
 *
 * **It advances for every call the emitter opens, and the emitter opens none when nobody is
 * listening.** So the ordinal means "how many OBSERVED calls preceded this one", not "how many calls".
 * Stated because the two readings differ the moment an application supplies no callbacks, and a reader
 * who assumed the wider one would misread a gap as a lost record.
 */
let issued = 0;

export function nextCallId(): number {
  issued += 1;
  return issued;
}

/**
 * The ordinal most recently issued, WITHOUT issuing one.
 *
 * Exists so a subscriber can fix the point it attached at — it receives calls that began after it, and
 * nothing earlier, because a terminal whose start a consumer never saw is an unpairable record and a
 * consumer cannot tell an unpairable record from a lost one.
 *
 * A reader rather than a second counter: two counters answering "where are we" would be two owners
 * of one truth, and they would drift the first time one of them was advanced alone.
 */
export function currentCallId(): number {
  return issued;
}

/**
 * Every step recorded as `notRun`, as the starting point a site refines.
 *
 * Built from the chain rather than listed, so a step added to `GATE_CHAIN` appears here automatically
 * and a record cannot silently omit one.
 */
export function allStepsNotRun(): readonly ObservedGate[] {
  // The callback parameter is deliberately NOT annotated `GateStep`. Annotating it would widen `name`
  // back to `string` and force an `as` cast here — re-creating, one line later, exactly the erasure
  // that `satisfies` on the chain exists to prevent.
  return GATE_CHAIN.map((step) => ({ step: step.name, outcome: GATE_OUTCOME.notRun }));
}
