// Where a call record is built, redacted and delivered (`docs/observing-tool-calls.md`).
//
// One projector and one queue, shared by both instrumentation sites. That sharing is the point: the
// bridge route and the page's registry route are two different files that must not be able to describe
// the same call differently, and redaction that lived at each site would be redaction one site could
// forget.
//
// **Nothing here decides admission.** It observes. A gate's verdict arrives as a fact.
//
// **The bus is created by the provider, not held at module scope.** A module-level bus would be shared
// across provider lifetimes and across two bundled copies of this library, which produces three
// hazards that are all invisible: a provider whose document claim was REFUSED could still subscribe to
// the first provider's stream; an old call's terminal could reach a remounted provider; and an
// inspector imported from one copy would silently see nothing from the other. One bus per provider
// removes all three by construction rather than by a rule someone has to remember.

import {
  allStepsNotRun,
  CALL_PHASE,
  CALL_ROUTE,
  type CallRoute,
  currentCallId,
  FAILURE_VOCABULARY,
  GATE_OUTCOME,
  type GateOutcome,
  type GateStepName,
  nextCallId,
  OBSERVED_PAYLOADS,
  type ObservedCall,
  type ObservedFailure,
  type ObservedGate,
  type ObservedPayloads,
  type ResolutionRefusal,
} from './call-record.ts';

/** How many characters a snapshotted value may occupy before it is reported as too large. */
const SNAPSHOT_LIMIT = 4_096;

/** What a site knows when a call begins. Nothing derived from a value appears here. */
export interface CallFacts {
  readonly name: string;
  readonly route: CallRoute;
  readonly startedAt: number;
  /** The raw arguments. Read ONLY under `values`, and never traversed under `metadata`. */
  readonly arguments?: unknown;
}

/** Where a consumer's own failure goes. Never the agent; always the operator's destination. */
export type ConsumerFailureSink = (failure: {
  readonly cause: unknown;
  readonly callId?: number;
}) => void;

export interface ObservationBusOptions {
  /**
   * What events may carry. `metadata` unless an application explicitly asked otherwise.
   *
   * Read through a supplier rather than captured, so a provider whose prop changed does not keep
   * projecting under the mode it started with.
   */
  readonly payloads: () => ObservedPayloads;
  readonly onConsumerFailure: ConsumerFailureSink;
}

/**
 * One call being observed. Owns exactly one `start → terminal` transition.
 *
 * **A terminal is the call's FINAL outcome, never the handler settling.** After a handler resolves the
 * runtime can still fail the call — an unserializable result, a violated output schema, or a
 * cancellation landing inside asynchronous output validation. A site that settled on handler
 * resolution would emit a SECOND terminal for each of those, and would look correct in every test that
 * exercised only a plain success. `settle*` refuses a second call for that reason.
 */
export interface CallObservation {
  readonly callId: number;
  /** Records what one step did. Later steps stay `notRun` until a site says otherwise. */
  gate(step: GateStepName, outcome: GateOutcome): void;
  /** Records WHICH resolution refused, when the resolve step refused. */
  refusedResolution(cause: ResolutionRefusal): void;
  /**
   * Records the failure a step decided on, WITHOUT ending the call.
   *
   * The separation is what makes "exactly one terminal" structural rather than a rule every return
   * point has to obey. `invoke` has many returns and each knows its own code; if each also ended the
   * call, the three paths that run AFTER a handler resolves — an unserializable result, a violated
   * output schema, a cancellation inside output validation — would each add a second ending. Instead
   * they note, and one finalizer settles from the value the runtime actually returns.
   */
  noteFailure(failure: ObservedFailure): void;
  /** The call's one terminal: it produced a result. */
  finishResult(value: unknown): void;
  /** The call's one terminal. Uses the last noted failure when none is given. */
  finishError(failure?: ObservedFailure): void;
}

export interface ObservationBus {
  /**
   * Subscribes, and returns the function that unsubscribes.
   *
   * A subscriber only ever receives calls that BEGAN after it attached. Otherwise a consumer that
   * subscribed mid-call would receive a terminal whose start it never saw, which is an unpairable
   * record — and a consumer cannot tell an unpairable record from a dropped one.
   */
  subscribe(sink: (event: ObservedCall) => void): () => void;
  /**
   * Opens an observation, or returns nothing when no one is listening.
   *
   * **The single entry point both sites call, and the reason "is anyone listening?" cannot drift.**
   * The facts arrive as a THUNK: with no subscribers it is never invoked, so a page that supplies no
   * callbacks and mounts no inspector pays nothing — not a record, not an id, not a timestamp.
   */
  beginIfObserved(facts: () => CallFacts): CallObservation | undefined;
}

export function createObservationBus(options: ObservationBusOptions): ObservationBus {
  interface Subscription {
    readonly sink: (event: ObservedCall) => void;
    /** Which call ordinal this subscriber attached at. It receives nothing that began before. */
    readonly since: number;
  }

  const subscriptions = new Set<Subscription>();
  const queue: { readonly event: ObservedCall; readonly since: number }[] = [];
  let draining = false;

  // Delivery is DEFERRED, and the guarantee is stated narrowly because a wider one would be false.
  //
  // What is promised: a consumer is never awaited by the call, cannot change its outcome, and cannot
  // make it fail. What is NOT promised: that a consumer burning CPU leaves the call unaffected.
  // JavaScript is single-threaded and no scheduling primitive in a browser can promise that. This
  // project's characteristic defect is a guarantee stated more strongly than its mechanism supports,
  // so the weaker true claim is the one written down.
  //
  // A microtask rather than a timer: deterministic, testable with `await Promise.resolve()`, and it
  // keeps an inspector within a tick of current. A timer here would be a delay chosen to make
  // timing work out, which is the thing this repository never reaches for.
  function scheduleDrain(): void {
    if (draining) return;
    draining = true;
    queueMicrotask(drain);
  }

  function drain(): void {
    draining = false;
    // Spliced rather than iterated: a sink that emits while being delivered to must not extend the
    // walk it is inside, and must not be able to starve the loop.
    const pending = queue.splice(0, queue.length);
    for (const item of pending) {
      for (const subscription of subscriptions) {
        if (subscription.since > item.since) continue;
        try {
          subscription.sink(item.event);
        } catch (cause) {
          // Reported, never swallowed — and never allowed to stop delivery to the other
          // subscribers, because one application's logging bug is not another consumer's problem
          // and is certainly not the agent's.
          report(cause, item.event.callId);
        }
      }
    }
    if (queue.length > 0) scheduleDrain();
  }

  function report(cause: unknown, callId?: number): void {
    try {
      options.onConsumerFailure(callId === undefined ? { cause } : { cause, callId });
    } catch {
      // The destination for failures itself failed. There is nowhere further to report, and throwing
      // from a drain would take out delivery for every other subscriber. Deliberately terminal.
    }
  }

  function publish(event: ObservedCall, since: number): void {
    queue.push({ event: freezeRecord(event), since });
    scheduleDrain();
  }

  return {
    subscribe(sink) {
      // The next id that WILL be issued: this subscriber receives that call and everything after.
      const subscription: Subscription = { sink, since: currentCallId() + 1 };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },

    beginIfObserved(facts) {
      if (subscriptions.size === 0) return undefined;

      const opened = facts();
      const callId = nextCallId();
      const gates = new Map<GateStepName, GateOutcome>(
        allStepsNotRun().map((gate) => [gate.step, gate.outcome]),
      );
      // **`authenticate` is derived from the route, not set by a site.**
      //
      // It is the one step marked `elsewhere` in the chain: it is decided at the socket upgrade, by the
      // gateway, before a call exists at all. So a call that arrived over the bridge has ALREADY passed
      // it at the moment it begins — including on its start record, which is published before any gate
      // here has run — and a call through the page's own registry never met it, because no socket was
      // involved.
      //
      // Derived rather than recorded by each site so that neither can forget, and so that no site can
      // ever mark it `refused`: nothing that reaches this library can have failed a check the gateway
      // performs before the connection exists.
      gates.set(
        'authenticate',
        opened.route === CALL_ROUTE.bridge ? GATE_OUTCOME.passed : GATE_OUTCOME.notRun,
      );
      let settled = false;
      let resolution: ResolutionRefusal | undefined;

      const mode = options.payloads();
      const carriedArguments =
        mode === OBSERVED_PAYLOADS.values ? snapshot(opened.arguments) : undefined;

      publish(
        {
          phase: CALL_PHASE.start,
          callId,
          name: opened.name,
          route: opened.route,
          startedAt: opened.startedAt,
          gates: freezeGates(gates),
          ...(carriedArguments === undefined ? {} : { arguments: carriedArguments }),
        },
        callId,
      );

      function terminal(
        phase: typeof CALL_PHASE.result | typeof CALL_PHASE.error,
        extra: Partial<ObservedCall>,
      ): void {
        if (settled) {
          // A second terminal is a defect in the instrumentation, not in the application — so it is
          // reported rather than published. Publishing would hand a consumer two endings for one call
          // and make every count it keeps wrong.
          report(
            new Error(
              `a second terminal was reported for call ${callId} ("${opened.name}"); ` +
                'a terminal describes the FINAL outcome, not the handler settling',
            ),
            callId,
          );
          return;
        }
        settled = true;
        publish(
          {
            phase,
            callId,
            name: opened.name,
            route: opened.route,
            startedAt: opened.startedAt,
            settledAt: Date.now(),
            gates: freezeGates(gates),
            ...(resolution === undefined ? {} : { resolution }),
            ...(carriedArguments === undefined ? {} : { arguments: carriedArguments }),
            ...extra,
          },
          callId,
        );
      }

      let noted: ObservedFailure | undefined;

      return {
        callId,
        gate(step, outcome) {
          gates.set(step, outcome);
        },
        refusedResolution(cause) {
          resolution = cause;
        },
        noteFailure(failure) {
          noted = failure;
        },
        finishResult(value) {
          const carried = mode === OBSERVED_PAYLOADS.values ? snapshot(value) : undefined;
          terminal(CALL_PHASE.result, carried === undefined ? {} : { result: carried });
        },
        finishError(failure) {
          // An application handler that threw carries no code of ours, and borrowing one would tell an
          // operator a CHECK refused the call when the application simply failed.
          const cause = failure ?? noted ?? { vocabulary: FAILURE_VOCABULARY.uncoded };
          terminal(CALL_PHASE.error, { failure: cause });
        },
      };
    },
  };
}

/**
 * A bounded, detached copy of a value, for `values` mode only.
 *
 * **Deliberately not the runtime's result normalization, though they look alike.** That one prepares a
 * value to be SENT to an agent, where truncating would be a defect — a tool's result must arrive whole
 * or not at all. This one prepares a value to be OBSERVED, where a bound is the point: an application
 * that asked for values did not ask for an unbounded copy of every argument forever.
 *
 * Serializing also detaches: a cycle, a getter, a proxy, a live DOM node, a function and a class
 * instance all either fail here or arrive as plain data. A consumer therefore cannot reach back into
 * the application through an observation, and cannot mutate what a handler is about to receive.
 */
function snapshot(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { observed: 'unserializable' };
  }
  if (text === undefined) return { observed: 'unserializable' };
  if (text.length > SNAPSHOT_LIMIT) return { observed: 'tooLarge', limit: SNAPSHOT_LIMIT };
  return JSON.parse(text) as unknown;
}

/** The gate map as the ordered, frozen list a record carries. */
/**
 * Freezes a record all the way down before it is delivered.
 *
 * **One object reaches EVERY subscriber, so a mutable one is a channel between them.** A review found
 * the sequence: an application callback receives the record, mutates a field it is allowed to see —
 * `event.name = event.arguments.password` under `values` — and the next subscriber, which is supposed
 * to be metadata-only, reads the mutated field and passes it on. Freezing removes the channel rather
 * than relying on every subscriber being well behaved.
 *
 * Deep, because a shallow freeze leaves `failure` writable and that is enough to carry a value.
 */
function freezeRecord<T>(record: T): T {
  for (const value of Object.values(record as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) freezeRecord(value);
  }
  return Object.freeze(record);
}

function freezeGates(gates: ReadonlyMap<GateStepName, GateOutcome>): readonly ObservedGate[] {
  return Object.freeze(
    [...gates].map(([step, outcome]) => Object.freeze({ step, outcome }) as ObservedGate),
  );
}

/** Re-exported so a site never spells a vocabulary tag. */
export { FAILURE_VOCABULARY, GATE_OUTCOME };
