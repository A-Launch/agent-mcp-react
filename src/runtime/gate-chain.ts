// The gate chain: the ordered steps every call passes before any application code runs, and a record
// of which of them this repository has actually built.
//
// Why this file exists at all, rather than a comment somewhere: the chain has seven steps and not all
// of them are built. An absence reads as a check that passed. A named step marked unbuilt reads as
// what it is — and it turns a case red the day someone lands one of the missing features without
// wiring its step in.
//
// **A step flips in the commit that builds it, never in a later tidying commit.** Under-claiming is
// safer than over-claiming and it is still wrong: this constant is the repository's answer to "is that
// checked yet?", and an answer that lags the code by four phases is one a reader learns to distrust.
//
// **An unbuilt step is not a pass-through.** It has no code path, participates in no decision, and
// there is no configuration in which it admits anything — because it does not take part in admitting.
// It is a description for a reader and a marker for a test. That distinction matters: a permissive
// placeholder inside a gate chain is worse than an absent one, because it looks like a gate.
//
// The order is a requirement rather than an implementation detail. Each step assumes the ones before
// it succeeded, so a later feature INSERTS its implementation at a fixed position rather than deciding
// where its check belongs.

/** Where a step's implementation lives, or will. */
export const GATE_STEP_STATE = {
  /** Implemented and running in this build. */
  built: 'built',
  /** Named, ordered, and not yet implemented. Admits nothing, because it decides nothing. */
  unbuilt: 'unbuilt',
  /** Enforced somewhere other than this chain, and listed so the chain is complete as a description. */
  elsewhere: 'elsewhere',
} as const;

export type GateStepState = (typeof GATE_STEP_STATE)[keyof typeof GATE_STEP_STATE];

export interface GateStep {
  /** Position in the chain. Fixed: a later feature inserts at its number, it does not choose one. */
  readonly order: number;
  readonly name: string;
  readonly state: GateStepState;
  /** What this step decides, stated so a reader knows what is missing when it is unbuilt. */
  readonly decides: string;
}

/**
 * The chain, in order.
 *
 * Exported so the built/unbuilt split is establishable from the repository alone — without running
 * anything and without reading a delivery plan. A reader asking "are arguments validated here?"
 * gets an answer from this constant.
 *
 * **`as const satisfies` rather than a `readonly GateStep[]` annotation, and the difference is not
 * cosmetic.** The annotation checked the shape and then widened `name` to `string`, so
 * `(typeof GATE_CHAIN)[number]['name']` was `string` and nothing could actually derive from this
 * constant — a record claiming to be keyed off the chain would compile with a step missing or a name
 * misspelled. `satisfies` keeps the same constraint checked while preserving the seven literals, which
 * is what makes "derived from the chain" enforcement rather than a comment: one owner of the closed
 * set, everything else derived from it.
 */
export const GATE_CHAIN = [
  {
    order: 1,
    name: 'authenticate',
    state: GATE_STEP_STATE.elsewhere,
    decides:
      'whether this connection may exist at all. Established at connection time by the gateway, before the socket handshake completes — never by this runtime, and identity only, never authorization',
  },
  {
    order: 2,
    name: 'resolve',
    state: GATE_STEP_STATE.built,
    decides:
      'whether the named tool is one this library registered. Unknown, foreign and diverged are each refused with their own cause',
  },
  {
    order: 3,
    name: 'capability',
    state: GATE_STEP_STATE.built,
    decides:
      "whether the tool's control level is admitted by the connection's capability set, read live at the moment of the call. One level confers nothing on another, and a denied tool is refused at invocation rather than hidden from the listing",
  },
  {
    order: 4,
    name: 'policy',
    state: GATE_STEP_STATE.built,
    decides:
      "per-tool permission, which in this build means AVAILABILITY: whether the application is currently offering the tool, read live from what it declared. Refused at invocation with its own cause, and excluded from the listing as well — the exclusion is for the agent's picture of the page, never the control. Risk is advertised and enforces nothing; confirmation is step 6",
  },
  {
    order: 5,
    name: 'validate',
    state: GATE_STEP_STATE.built,
    decides:
      'whether the arguments match the declared schema. In the runtime, never discovered inside a handler. A tool that declares a schema and has no validator installed is not registered at all, so there is no configuration in which this step is skipped rather than performed',
  },
  {
    order: 6,
    name: 'confirm',
    state: GATE_STEP_STATE.built,
    decides:
      'whether a tool declaring confirmation:"required" has been approved by a person, resolved BEFORE the handler runs rather than by undoing an applied effect afterwards. The resolver sees a detached, deeply frozen snapshot of the validated arguments; capability, availability and cancellation are all re-read when it answers, because a confirmation is human-scale and any of them can change while one is open. Anything that is not an approval denies, including a throw and a non-decision',
  },
  {
    order: 7,
    name: 'invoke',
    state: GATE_STEP_STATE.built,
    decides:
      'nothing — it is the call itself, through the handler held in the ownership record, read at invocation so it sees current state',
  },
] as const satisfies readonly GateStep[];

/**
 * The chain seen through the widened element type, for the two questions asked at RUNTIME.
 *
 * `GATE_CHAIN` preserves its literals so a record can derive a checked key union from it. That same
 * precision makes a runtime comparison against a state no step currently holds a compile error rather
 * than a `false` — TypeScript can see that nothing here is `unbuilt`, which is true today and is
 * exactly the fact `unbuiltSteps` exists to report when it stops being true. Asking through the
 * declared element type keeps both: the derivation stays exact, and the helpers keep asking a runtime
 * question that is allowed to have an empty answer.
 */
const STEPS: readonly GateStep[] = GATE_CHAIN;

/** The steps a call actually passes through in this build. */
export function builtSteps(): readonly GateStep[] {
  return STEPS.filter((step) => step.state === GATE_STEP_STATE.built);
}

/**
 * The steps that are named and not yet implemented.
 *
 * Nothing in the runtime branches on this. It exists so a test can assert the split, and so a reader
 * can see the gap without reconstructing it from a delivery plan.
 */
export function unbuiltSteps(): readonly GateStep[] {
  return STEPS.filter((step) => step.state === GATE_STEP_STATE.unbuilt);
}
