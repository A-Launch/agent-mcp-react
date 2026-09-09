import { IS_DEVELOPMENT } from '../build-mode.ts';
import {
  type AgentCapabilities,
  admitsAvailability,
  admitsLevel,
  CONFIRMATION,
  type ConfirmationResolver,
  type ControlLevel,
  type DeclaredPermissions,
  type DomAuthority,
  isConfirmationDecision,
  LEVEL_CAPABILITY,
  needsConfirmation,
} from '../security/index.ts';
import { FAILURE_VOCABULARY, GATE_OUTCOME } from './call-record.ts';
import { CANCELLED_BY, type Cancellation, composeCancellation, sequence } from './cancellation.ts';
import {
  HANDLER_REPORTABLE,
  isRuntimeFailureCode,
  RUNTIME_FAILURE,
  RuntimeError,
  type RuntimeFailureCode,
} from './errors.ts';
import type { CallObservation } from './observation.ts';
import type { ToolCallContext, ToolHandler } from './ownership.ts';
import { type CompiledSchema, check, VALIDATION } from './validation.ts';

// Steps 3 and 7 of the gate chain: deciding whether this connection may reach the tool at all, and
// then calling the handler and making sure something reaches the agent whatever it does.
//
// The capability gate is HERE rather than in `src/security/`, which decides it. A module that decides
// whether it may run is a module that can be imported past its own check — the same reason the DOM
// gate will not live in `src/dom/`. It runs before validation and before the handler, in one place
// that both call routes into the runtime share.
//
// Four invariants live in this file, and all four protect against failures that are silent rather
// than loud. Each was measured against the SDK, not assumed:
//
//   1. The handler is invoked DIRECTLY, from the ownership record — never through the tool registry's
//      own execution entry point. That path is callable by any script on the page and passes none of
//      this library's checks, and it serializes results to a string, which destroys the difference
//      between a tool returning an object and one returning a JSON string as its actual value.
//   2. A handler that throws must not throw out of here. Uncaught, the SDK delivers it to the agent as
//      a PROTOCOL error — the wrong kind, since a tool error says the tool ran and failed, which is
//      what a model needs in order to react — and it carries the application's own error message,
//      which is not ours to publish.
//   3. A result that cannot be serialized must be caught HERE. Measured: the response is otherwise
//      never sent at all — no frame, no error response, no unhandled rejection — and the agent blocks
//      on that request until its own timeout, then diagnoses a slow page.
//   4. A call whose signal aborted never reports success, whatever the handler went on to return —
//      and it SETTLES, whether or not the handler cooperates.
//
//      Those are two claims and the second one costs something. A handler that awaits a promise which
//      never settles and ignores `context.signal` cannot be stopped by any amount of checking at
//      resumption points: control never comes back. Measured against the requirement rather than
//      against taste — a withdrawn call must still produce a frame, and an agent
//      whose request never settles waits until its own timeout with nothing to diagnose.
//
//      So the handler is RACED against the cancellation. What that trades away is stated rather than
//      hidden: a handler that ignores its signal may still be running, and may still mutate the
//      application, after its call has been reported as cancelled. This library cannot kill a running
//      function, and the alternative — no outcome at all — is worse than an outcome that arrives while
//      uncooperative work is still in flight.
//
//      The race also settles a subtler question correctly. `Promise.race` resolves with whichever side
//      settled FIRST, in queue order — so a handler that completed and a component that unmounted an
//      instant later in the same stack resolve as the handler completing, which is what the rule against a false refusal
//      requires. Reading `signal.aborted` after resuming cannot distinguish those two, because
//      settlement and resumption are separated by a microtask.

/**
 * What the agent receives for one call.
 *
 * Text always; structure only when the tool declared an output schema and what it returned matched.
 * Structure is never invented for a tool that did not declare one — an agent handed a shape nobody
 * guaranteed would treat it as a contract, and the first handler that returned something different
 * would break it silently.
 *
 * Deliberately not `readonly`. This value is handed straight to the protocol layer, whose own types
 * are mutable — marking it readonly here would only force a copy at the boundary that says nothing
 * true about ownership.
 */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  /**
   * The result as data, present only when the tool declared an output schema and the result matched it.
   *
   * Additional to `content`, never instead of it (`docs/design.md#tool-results`): a client that
   * does not read structured content must still receive something it can use.
   */
  structuredContent?: unknown;
  isError?: boolean;
  /** The protocol's result type is open. Declared so this satisfies it without a cast. */
  [key: string]: unknown;
}

/**
 * Calls one tool and returns something the agent can always be given.
 *
 * Never throws. Every failure becomes a tool error result, because a throw from here is a protocol
 * error and the two are not interchangeable.
 */
export async function invoke(
  name: string,
  entry: InvocationTarget,
  args: Record<string, unknown>,
  call: InvocationInputs,
): Promise<ToolCallResult> {
  // Composed HERE rather than by the caller, so there is one owner of an invocation's cancellation and
  // it is the file that decides the invocation's outcome.
  const cancellation = composeCancellation(call.requestSignal, entry.lifetime);
  // Shared with `run` so the outer race can say whether the handler had already finished. It is the
  // difference between telling an agent nothing happened and telling it the call was cut short after
  // the application had already changed, and only one of those is true at a time.
  const progress: Progress = {};
  try {
    return await run(name, entry, args, call, cancellation, progress);
  } finally {
    // The listeners this composition installed are released whatever the outcome. `AbortSignal.any`'s
    // source relationships are weak, but a dependent signal with live abort listeners is retained
    // while its sources are — and the declaration lifetime outlives every call under it, so leaving
    // them attached would retain one composition per call for the tool's whole life.
    cancellation.dispose();
  }
}

/** Marks the cancellation side of a bounded await. A symbol, so no real value can impersonate it. */
const CANCELLED_HERE: unique symbol = Symbol('cancelled before this step finished');

/**
 * Awaits something that could take forever, giving up if the call is cancelled first.
 *
 * **Every await in an invocation is bounded, not only the handler's.** A compiled schema's `validate`
 * is supplied by the embedder, so it is application-adjacent code exactly as a handler is: one that
 * never settles hangs a call the same way, and the agent has no more to diagnose in one case than the
 * other. Each site is bounded separately rather than the whole invocation at once, because what a
 * cancellation MEANS differs by where it lands — before the handler nothing happened, after it the
 * application may already have changed — and one race around everything cannot tell those apart.
 */
async function bounded<T>(
  work: Promise<T>,
  cancellation: Cancellation,
): Promise<T | typeof CANCELLED_HERE> {
  return await Promise.race([
    work,
    cancellation.cancelled.then((): typeof CANCELLED_HERE => CANCELLED_HERE),
  ]);
}

/**
 * What an invocation has managed to do so far.
 *
 * One field, and it is the only thing the outer race needs to know: did the handler finish? A
 * cancellation before that means nothing happened; after it means the application may already have
 * changed, and an agent told the wrong one of those either retries a completed mutation or believes a
 * change it never made.
 */
interface Progress {
  /** When the handler settled, on the cancellation clock. Absent while it is still running. */
  completedAt?: number;
}

/**
 * What an invocation needs to know about the TOOL — whichever table it was found in.
 *
 * Deliberately not `OwnershipEntry`, and the narrowing is the point rather than tidiness. There are
 * now two sources of callable tools: the ownership record, which holds what an application registered,
 * and the built-in table, which holds what this library ships and never registers anywhere. An
 * invocation must treat them identically — the same gates, the same cancellation, the same guarantee
 * that something reaches the agent — and a signature naming one of the two sources would have made a
 * built-in call a second code path with its own copy of all of it.
 *
 * `OwnershipEntry` satisfies this structurally, so nothing about the registered route changed.
 */
export interface InvocationTarget {
  /**
   * The function to call, read at invocation so it sees current state rather than the render that
   * registered it (`docs/design.md#stable-handlers`).
   */
  readonly handler: ToolHandler;
  /**
   * What a PERSON is shown when asked to approve a call to this tool.
   *
   * Assembled by the dispatcher from whichever table the tool came from, rather than read off an
   * ownership entry — a built-in has no declaration, and a target that only some sources could satisfy
   * would make the confirmation gate a second code path for the privileged tools.
   *
   * The title is what a person should read; the name is what the agent said. They are both here
   * because a dialog that shows only `invoice.mark_paid` is asking somebody to approve an identifier.
   */
  readonly title?: string;
  readonly description: string;
  /**
   * Aborts when the tool stops being DECLARED, composed into this call's signal.
   *
   * Absent for a built-in, and that is correct rather than a gap: a built-in is declared for the whole
   * life of the runtime, so the only things that can end one of its calls are the agent cancelling and
   * the channel ending — both of which arrive on the request signal.
   */
  readonly lifetime?: AbortSignal;
  /** The compiled schemas that gate it, or nothing when it declared none. */
  readonly validators?: {
    readonly input?: CompiledSchema;
    readonly output?: CompiledSchema;
  };
}

/** What one invocation needs from its caller. The context a handler sees is built from it, not passed in. */
export interface InvocationInputs {
  /**
   * The MCP protocol layer's per-request signal.
   *
   * Composed with the tool's declaration lifetime to produce what the handler holds. Never a signal
   * this library created, which would not learn that the client cancelled.
   */
  readonly requestSignal: AbortSignal;
  /** Waits for the application to commit. Supplied by whoever bound a renderer to this runtime. */
  readonly afterRender: () => Promise<void>;
  /**
   * What this connection may reach, read **now**.
   *
   * A function rather than a value, and that is the invariant rather than a style: the capability set
   * is read live at the gate. A copy taken when the runtime was built would keep admitting calls after
   * an operator withdrew a capability, and it is what would make the confirmation step's recheck a
   * lie — it would recheck a snapshot against itself.
   */
  readonly capabilities: () => AgentCapabilities;
  /**
   * The control level of the tool being called. The three levels are separate layers and one
   * confers nothing on another (`docs/reference-capabilities.md#the-three-levels`).
   *
   * Supplied by the DISPATCHER, because the level is a property of **which table the name resolved
   * in** — never of the name itself. A registry entry is Level 1 by construction; a built-in carries
   * the level its table declares. Deriving it here from a prefix would make a naming convention into
   * the control boundary, which is the one thing that separation forbids outright.
   */
  readonly level: ControlLevel;
  /**
   * Which half of the DOM capability a Level 2 tool needs. Meaningless at any other level.
   *
   * Absent is not a grant: a Level 2 tool that did not say is refused by both halves.
   */
  readonly domAuthority?: DomAuthority;
  /**
   * What the application currently declares about reaching this tool — read at each gate.
   *
   * A supplier, for the same reason the capability set is one: a confirmation is human-scale, so a
   * value captured when the call arrived would be minutes stale by the time the recheck reads it, and
   * the recheck would be comparing a snapshot with itself. It reads through the ownership record, so
   * it sees whatever the last `refresh` wrote.
   *
   * What it supplies is a DECLARED value, never a predicate this gate calls. A callback would be
   * application code running inside a gate, and authority may only narrow: it could not be prevented
   * from widening by side effect, since one that performed the action and returned "deny" would leave
   * the application changed and the agent told it was refused; it would emit no change signal, so an
   * agent would list
   * a tool, the value would flip, and the next call would be refused against a list nothing could have
   * told it was stale; and it is the one check the shared-registry route does not share, so a domain
   * rule moved into it would stop applying to every script in the page.
   */
  readonly permissions: () => DeclaredPermissions | undefined;
  /**
   * How an operator is asked to approve a call, or nothing.
   *
   * A supplier of a resolver rather than a resolver, so an application that swaps its dialog is not
   * still being asked through the old one. Its absence is not a permission: a tool that requires
   * confirmation and finds nobody to ask is REFUSED.
   */
  readonly confirmationResolver?: () => ConfirmationResolver | undefined;
  /**
   * The call's open observation, or nothing when no one is watching.
   *
   * Opened by the DISPATCHER, because a call's life begins there — a name that resolves to nothing is
   * refused before this function is ever entered. What happens here is the middle of a record that
   * already exists.
   *
   * This function NOTES failures and records step outcomes; it never settles. The dispatcher settles
   * once, from the value actually returned, which is what keeps "exactly one terminal" true across the
   * many return points below — including the three that run after a handler has already resolved.
   */
  readonly observation?: CallObservation;
}

async function run(
  name: string,
  entry: InvocationTarget,
  args: Record<string, unknown>,
  call: InvocationInputs,
  cancellation: Cancellation,
  progress: Progress,
): Promise<ToolCallResult> {
  const context = contextFor(call, cancellation);

  // **Before validation, not after.** A call that was already over must not be told its arguments were
  // wrong: nothing ran, so there is nothing to correct, and in the withdrawal case the agent is still
  // waiting and would be sent off fixing arguments for a tool that no longer exists.
  if (cancellation.by() !== undefined)
    return cancelled(name, cancellation, progress, call.observation);

  // **Step 3 of the gate chain: capability.**
  //
  // Before validation and before the handler. The order is not cosmetic — telling an agent
  // its arguments were wrong for a tool it may not reach at all describes a contract it was never
  // going to be held to, and it reveals the shape of a tool the connection was refused.
  //
  // Read live through `call.capabilities()`, never from a value captured when the runtime was built.
  // Invariant: **one level confers nothing on another**, which is decided in `src/security/` and
  // enforced here — a module that decided whether it may run is a module importable past its own
  // check.
  const admission = admitsLevel(call.capabilities(), call.level, call.domAuthority);
  call.observation?.gate(
    'capability',
    admission.admitted ? GATE_OUTCOME.passed : GATE_OUTCOME.refused,
  );
  if (!admission.admitted) {
    call.observation?.noteFailure({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.capabilityDenied,
    });
    // **Named down to the AUTHORITY, not just the level.** A Level 2 refusal that said only "dom"
    // would send an operator to grant the wrong half — the read-only profile has `dom.inspect` and not
    // `dom.interact`, and "you were not granted dom" is false in exactly that configuration. Both
    // halves of the name come from dictionaries; neither is spelled here.
    const member = LEVEL_CAPABILITY[call.level];
    const needed =
      member === undefined
        ? undefined
        : call.domAuthority === undefined
          ? member
          : `${member}.${call.domAuthority}`;
    return refusal(
      call.observation,
      RUNTIME_FAILURE.capabilityDenied,
      needed === undefined
        ? `the tool "${name}" has a control level this connection's capabilities do not admit`
        : `the tool "${name}" needs the "${needed}" capability, which this connection was not granted`,
    );
  }

  // **Step 4 of the gate chain: per-tool policy, which in this build means availability.**
  //
  // After capability and before validation. The order matters in both directions: an agent refused a
  // tool it may not reach at all should not be told its arguments were wrong, and an agent refused an
  // unavailable tool should not be sent off correcting arguments for a tool that would have taken them.
  //
  // The cause is distinct from a capability denial on purpose. A capability is an operator's decision
  // about the whole connection; availability is the application's decision about one tool right now,
  // and it usually tracks state the agent can change. An agent told the wrong one either gives up on a
  // tool that is about to work, or retries one that never will.
  const offered = admitsAvailability(call.permissions());
  call.observation?.gate('policy', offered.admitted ? GATE_OUTCOME.passed : GATE_OUTCOME.refused);
  if (!offered.admitted) {
    call.observation?.noteFailure({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.toolUnavailable,
    });
    return refusal(
      call.observation,
      RUNTIME_FAILURE.toolUnavailable,
      `the tool "${name}" is currently unavailable — the application is not offering it right now`,
    );
  }

  // **Step 5 of the gate chain, and it runs before the handler is entered at all.**
  //
  // Not inside the handler, where every application re-implements it and one of them gets it wrong —
  // and where the mistake is silent: an unchecked value is written into state, the tool reports
  // success, and the page is wrong in a way that reads as the model's fault.
  const inputSchema = entry.validators?.input;
  if (inputSchema !== undefined) {
    const outcome = await bounded(check(inputSchema, args), cancellation);
    if (outcome === CANCELLED_HERE)
      return cancelled(name, cancellation, progress, call.observation);
    if (outcome.verdict !== VALIDATION.valid) {
      // Both non-valid verdicts refuse at this step. Only the CODE is noted — never `outcome.reason`,
      // which a custom validator may have built by quoting the offending value. That string is the
      // single likeliest leak path in this feature, and it is closed by the record having nowhere to
      // put it rather than by anyone remembering not to pass it.
      call.observation?.gate('validate', GATE_OUTCOME.refused);
    }
    if (outcome.verdict === VALIDATION.invalid) {
      return refusal(
        call.observation,
        RUNTIME_FAILURE.argumentsInvalid,
        `the tool "${name}" was called with arguments that do not match its declared schema: ${outcome.reason}`,
      );
    }
    if (outcome.verdict === VALIDATION.unusable) {
      // The validator broke. NOT reported as invalid arguments: that would send an agent off correcting
      // arguments that may be perfectly good, and it would keep doing it. The handler does not run
      // either — a contract that cannot be checked is not a contract that passed.
      return refusal(
        call.observation,
        RUNTIME_FAILURE.argumentsInvalid,
        `the tool "${name}" could not be called because its schema could not be checked: ${outcome.reason}`,
      );
    }
  }

  // Reached only when nothing above refused. A tool that declared no input schema passes this step —
  // it executed and had nothing to check, which is not the same as having been skipped.
  call.observation?.gate('validate', GATE_OUTCOME.passed);

  // **Step 6 of the gate chain: confirmation.**
  //
  // After validation, and that order is a kindness with a security edge: nobody should be shown a
  // dialog about a call that was never going to run, and a person asked to approve arguments the
  // runtime has already rejected is being asked to approve something that will not happen.
  //
  // Resolved BEFORE the handler — authorize before invoking, never after — and the shape that rule
  // forbids is the tempting one: run the handler, ask, undo on refusal. There is no undo: the handler
  // is an application transition, it may have written to a server, and "we did it and then took it
  // back" is not what a person approving an action believes they are deciding.
  if (needsConfirmation(call.permissions())) {
    const confirmed = await confirm(name, entry, args, call, cancellation);
    if (confirmed !== undefined) {
      // **Only a DECLINE is a refusal at this step.** `confirm` also returns when the call was
      // cancelled while a person was being asked — and a cancellation is not a verdict: nobody
      // declined it, the caller stopped waiting. Marking the step refused there would put a decision
      // on the record that was never made, which is the same mistake the panel made when it rendered
      // a cancelled call as "refused at unknown step".
      //
      // Distinguished by what `cancelled()` already noted, rather than by re-deriving it here.
      if (cancellation.by() === undefined) call.observation?.gate('confirm', GATE_OUTCOME.refused);
      return confirmed;
    }
  }
  call.observation?.gate('confirm', GATE_OUTCOME.passed);

  // Again, because validation is asynchronous and a cancellation can land inside it. The handler's
  // whole purpose is to mutate the application, and performing a mutation for a call nobody is waiting
  // for is the one outcome worse than reporting the wrong thing about it.
  if (cancellation.by() !== undefined)
    return cancelled(name, cancellation, progress, call.observation);

  const RACE_LOST = Symbol('cancelled before the handler settled');
  let produced: unknown;

  // **When the handler finished, on the same clock the cancellation is latched on.**
  //
  // Latched in the handler's own continuation, which is the only place that runs at the moment it
  // settles. Reading `cancellation.by()` afterwards cannot order the two: an abort listener runs
  // synchronously and a promise continuation runs a microtask later, so a handler that completed and
  // an abort queued behind it would both look "already cancelled" from a later vantage point. That is
  // The case where the handler finished first, and it is decidable — it just has to be recorded rather than inferred.
  const stamp = <T>(value: T): T => {
    progress.completedAt ??= sequence();
    return value;
  };

  try {
    // The race, and the reason a handler's cooperation is optional: a handler that never returns
    // cannot hold an agent's request open.
    // `Promise.resolve` because a handler may return a plain value: the stamp has to be attached to a
    // promise whichever it did, and a synchronous return still needs an ordering point.
    produced = await Promise.race([
      Promise.resolve(entry.handler(args, context)).then(
        (value) => stamp(value),
        (cause: unknown) => {
          stamp(undefined);
          throw cause;
        },
      ),
      cancellation.cancelled.then(() => RACE_LOST),
    ]);
  } catch (cause) {
    // **Classified from the latch, never from the thrown value.** An aborted `fetch` rejects with an
    // `AbortError`, and so does an application that constructed one for its own reasons — reaching
    // a verdict by reading a thrown value's name is deciding from a string instead of from the
    // closed vocabulary, and here it would report a genuine application failure as a cancellation.
    if (cancelledFirst(cancellation, progress))
      return cancelled(name, cancellation, progress, call.observation);
    // **A handler naming a failure it is genuinely the authority on keeps that name.** A stale DOM
    // reference reported as an execution failure would tell an agent the tool broke, when what is true
    // is that it should take another snapshot — and the two codes exist precisely so an agent can tell
    // those apart. Restricted to a closed subset (`HANDLER_REPORTABLE`), because a handler that could
    // name any member could claim a gate refused a call the gate in fact admitted, on the one surface
    // an operator uses to answer "why was this refused".
    //
    // **By CODE, never by `instanceof`.** `errors.ts` states the rule and the reason: an `instanceof`
    // test breaks the moment two copies of this library are bundled onto one page — and that is not
    // hypothetical here, because a built-in arrives through the application's own import of the Level
    // 2 subpath, which is exactly the seam a second copy comes in on. The failure would be silent: a
    // stale-reference refusal quietly demoted to an execution error, in the one configuration nobody
    // tests.
    const reported = reportableCode(cause);
    if (reported !== undefined) {
      call.observation?.gate('invoke', GATE_OUTCOME.refused);
      call.observation?.noteFailure({ vocabulary: FAILURE_VOCABULARY.runtime, code: reported });
      return toolError(new RuntimeError(reported, describeReportable(cause), name));
    }
    // The handler RAN and threw. The step is `refused` in the sense that it did not produce a result —
    // and the code says the tool failed, never that a check refused it, because an operator sent to
    // read a gate that admitted the call would be looking in the wrong place.
    call.observation?.gate('invoke', GATE_OUTCOME.refused);
    call.observation?.noteFailure({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.toolExecutionFailed,
    });
    return toolError(
      new RuntimeError(
        RUNTIME_FAILURE.toolExecutionFailed,
        `the tool "${name}" failed while running`,
        name,
      ),
      cause,
    );
  }

  // **Two mechanisms, because neither is sufficient alone.** The race guarantees the call SETTLES; the
  // ORDER decides the verdict, because the race cannot — promise resolution follows microtask depth,
  // not real time, so a handler that aborted its own call on its first line and returned one microtask
  // later still wins the race.
  //
  // Comparing stamps rather than asking "is it cancelled now?" is what stops a completed call being reported as cancelled: a handler
  // that completed before the abort was latched reports its result, even though by the time this line
  // runs the signal is aborted. A tie — both stamped in the same synchronous stack — goes to the
  // cancellation, because a stale success is the one outcome a cancelled call must never produce,
  // while a cancellation reported for a mutation that did land is wrong in the direction an agent
  // can recover from.
  if (produced === RACE_LOST || cancelledFirst(cancellation, progress)) {
    return cancelled(name, cancellation, progress, call.observation);
  }

  // **From here the outcome is decided, and a later cancellation does not change it.**
  //
  // The handler completed, so the application may already have changed. Everything below — proving the
  // result can cross a wire, checking it against the declared output schema — is describing something
  // that HAPPENED. An abort landing during that work does not turn it into a call that never ran, and
  // reporting one would tell the agent nothing happened and invite it to perform the mutation twice.
  //
  // Stated here because the absence of a check is otherwise indistinguishable from a forgotten one,
  // and because output validation is asynchronous: there is a real window, and it is deliberately not
  // guarded. Never reporting a false refusal wins over the absolute reading of "authorize before
  // invoking", on purpose.

  // Proven before the protocol layer sees it, not after. This is the check whose absence produces
  // silence rather than an error, which is why it is a step of its own rather than part of the catch
  // above: a handler can succeed completely and still return something that cannot cross a wire.
  const normalized = normalize(produced);
  if (normalized === undefined) {
    // **After the handler already resolved.** One of the three paths that would each become a SECOND
    // terminal if a site settled on handler resolution rather than on the value actually returned.
    call.observation?.gate('invoke', GATE_OUTCOME.refused);
    call.observation?.noteFailure({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.resultNotSerializable,
    });
    return toolError(
      new RuntimeError(
        RUNTIME_FAILURE.resultNotSerializable,
        `the tool "${name}" returned a value that cannot be sent to the agent`,
        name,
      ),
    );
  }

  const outputSchema = entry.validators?.output;
  if (outputSchema === undefined) {
    // No declared output schema, so no structured content. Structure is NEVER invented for a tool
    // that did not promise one: an agent that received it would treat a shape nobody guaranteed as a
    // contract, and the first handler that returned something different would break it silently.
    call.observation?.gate('invoke', GATE_OUTCOME.passed);
    return { content: [{ type: 'text', text: normalized.text }] };
  }

  // **Validated against the NORMALIZED value, not what the handler returned.** Serialization omits
  // and transforms things — a `Date` becomes a string, `undefined` disappears, a class instance
  // becomes a plain object — so validating the raw value would be validating something other than
  // what is sent. The agent would receive data that does not match the schema it was validated
  // against, which is the exact failure the schema exists to make impossible.
  const outcome = await bounded(check(outputSchema, normalized.value), cancellation);
  // The handler ran and the application may already have changed, so the message says so. There is no
  // validated result to send — that is what was lost — but an outcome that arrives beats one that does
  // not, and an agent told only "cancelled" would believe nothing happened.
  if (outcome === CANCELLED_HERE) return cancelled(name, cancellation, progress, call.observation);
  if (outcome.verdict !== VALIDATION.valid) {
    // Its own code, and never the input one. The handler ALREADY RAN and may already have mutated the
    // application; an agent told its arguments were refused would believe nothing happened and retry,
    // performing the mutation twice.
    // The second of the three post-handler paths. Its own code, never the input one: the handler ALREADY
    // RAN and may have mutated the application, and an agent told its arguments were refused would
    // believe nothing happened and retry — performing the mutation twice.
    call.observation?.gate('invoke', GATE_OUTCOME.refused);
    call.observation?.noteFailure({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.resultViolatesOutputSchema,
    });
    // **The validator's reason is NOT sent, and this is the one refusal in the chain where that is
    // right.** Every other step refuses something the AGENT supplied, so naming a field, an expected
    // type or a permitted set is corrective — it is an identifier the agent already holds and can act
    // on.
    //
    // An output violation is the application's own defect. The agent cannot fix it, cannot retry into
    // success, and has nothing to correct. What the diagnostic WOULD carry is application-derived: Ajv
    // names the offending property for an `additionalProperties` failure, and an object's keys are
    // routinely identifiers — `{ "user_8f3a...": … }`, `{ "tenant-secret-42": … }`. The adapter's own
    // comment called that "a name the agent itself chose and already knows", which is true of an
    // ARGUMENT and false of a RESULT.
    //
    // Withholding it also closes the free-form `reason` path for a validator an embedder supplies,
    // which is the one leak this library cannot otherwise constrain. The detail is not lost to the
    // people who need it: it reaches the application through the observability surface and the
    // inspector, where the defect actually is.
    return refusal(
      call.observation,
      RUNTIME_FAILURE.resultViolatesOutputSchema,
      `the tool "${name}" ran, but what it returned does not match its declared output schema`,
    );
  }

  call.observation?.gate('invoke', GATE_OUTCOME.passed);
  return {
    content: [{ type: 'text', text: normalized.text }],
    // Additional, never instead of: human-readable content is not optional, because a client that
    // does not read structured content must still receive something it can use.
    structuredContent: normalized.value,
  };
}

/**
 * Asks for approval, and returns a refusal when the call must not proceed — or `undefined` when it may.
 *
 * **Everything after the await is the interesting part**, and each line is a way the obvious version is
 * wrong:
 *
 *   - The await is BOUNDED against cancellation, so a resolver that never answers cannot hold an
 *     agent's request open forever. A confirmation is human-scale by design, so there is no timeout
 *     here: inventing one would be this library setting a policy on an operator's behalf, silently.
 *   - Cancellation is RE-READ afterwards, not only bounded during. A resolver that settles a moment
 *     before a cancellation latches wins the race, and without this re-read the handler would start
 *     for a call nobody is waiting for.
 *   - Capability and availability are RECHECKED, against live values. A confirmation can be open for
 *     minutes; an operator can withdraw a capability and an application can close a tool while it is.
 *     Approving a call and then running it under authority that has since been taken away is exactly
 *     the widening this whole feature exists to prevent.
 *
 * A decision cannot be replayed onto another call and cannot be given twice: the resolver is invoked
 * once per invocation and a promise settles once. Those are properties of the contract's shape rather
 * than rules enforced here, which is why there is no guard for them to be missing.
 */
async function confirm(
  name: string,
  entry: InvocationTarget,
  args: Record<string, unknown>,
  call: InvocationInputs,
  cancellation: Cancellation,
): Promise<ToolCallResult | undefined> {
  const resolver = call.confirmationResolver?.();
  if (resolver === undefined) {
    // Not a permission. An application declared that a person must approve this and supplied nobody to
    // ask, which is a deployment fact an operator can fix — and the tool stays listed, because what is
    // true is "it cannot be approved here", not "it does not exist".
    return refusal(
      call.observation,
      RUNTIME_FAILURE.confirmationUnavailable,
      `the tool "${name}" requires confirmation and this page has no confirmation resolver, so nobody could approve the call`,
    );
  }

  const request = {
    tool: name,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    description: entry.description ?? '',
    // **Detached AND deeply frozen, which are two different protections.** Detached means whatever the
    // resolver does to what it was shown cannot reach the handler. Frozen means it cannot change what
    // it is showing a person between the render and the answer. A shallow freeze provides neither for
    // a nested value, and a nested value is where the amount lives.
    arguments: deeplyFrozen(structuredClone(args)) as Readonly<Record<string, unknown>>,
    signal: cancellation.signal,
  };

  // Invoked inside the try, because a resolver that throws SYNCHRONOUSLY is as ordinary as one that
  // rejects, and a throw escaping here would reach the agent as a protocol error carrying an
  // application's own message.
  let decision: unknown;
  try {
    decision = await bounded(Promise.resolve(resolver(request)), cancellation);
  } catch {
    // **Nothing the resolver produced is carried anywhere.** Its message is application text and this
    // is a socket; and the agent has no business learning about the inside of a dialog. A throw and a
    // decline are one outcome — nobody approved this call — and telling them apart would invite a
    // model to retry a crash where it must not retry a refusal.
    return refusal(
      call.observation,
      RUNTIME_FAILURE.confirmationRefused,
      `the tool "${name}" was not confirmed, so it was not called`,
    );
  }

  if (decision === CANCELLED_HERE) return cancelled(name, cancellation, {}, call.observation);

  // **Re-read, not merely bounded**. A resolver that answers a moment before a cancellation
  // latches wins the race, and the decision would otherwise carry a call nobody is waiting for into
  // the handler.
  //
  // Measured, and recorded because the obvious reading of a green suite is wrong: `run` performs the
  // same check on the line immediately after this function returns, so removing EITHER one alone
  // leaves every case green. Removing both reddens the case built for exactly this interleaving. They
  // are kept apart because they cover different ground in general — that one also catches a
  // cancellation landing inside validation — and because a `confirm` that is correct only by virtue of
  // its caller is a function whose next caller gets it wrong.
  if (cancellation.by() !== undefined) return cancelled(name, cancellation, {}, call.observation);

  // Live, not the values this call arrived with.
  const readmitted = admitsLevel(call.capabilities(), call.level, call.domAuthority);
  if (!readmitted.admitted) {
    return refusal(
      call.observation,
      RUNTIME_FAILURE.capabilityDenied,
      `the tool "${name}" stopped being admitted by this connection's capabilities while the confirmation was open`,
    );
  }
  if (!admitsAvailability(call.permissions()).admitted) {
    return refusal(
      call.observation,
      RUNTIME_FAILURE.toolUnavailable,
      `the tool "${name}" stopped being offered by the application while the confirmation was open`,
    );
  }

  if (!isConfirmationDecision(decision) || decision !== CONFIRMATION.approved) {
    // One branch for "declined" and "returned something that is not a decision", because they are one
    // outcome. A resolver that returned `undefined` from a dismissed dialog, or `true` from an author
    // who assumed a boolean, has not approved anything — and a check that asked "is it truthy" would
    // have read the second as consent.
    return refusal(
      call.observation,
      RUNTIME_FAILURE.confirmationRefused,
      `the tool "${name}" was not confirmed, so it was not called`,
    );
  }

  return undefined;
}

/**
 * Freezes a value and everything reachable from it.
 *
 * Deep, because the shallow version passes a top-level test and fails the case that matters: a person
 * approves `{ transfer: { amount: 10 } }` and a resolver — or anything it handed the object to —
 * rewrites the amount before the handler runs.
 *
 * It walks plain objects and arrays, which is everything a validated argument can be: these values
 * came from JSON on a socket and were cloned through `structuredClone`.
 */
function deeplyFrozen<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deeplyFrozen(nested);
  return Object.freeze(value);
}

/**
 * Did the cancellation happen before the handler finished?
 *
 * `undefined` completion means the handler never finished, so any cancellation precedes it. Equal
 * stamps are impossible — the clock always advances — but `<=` is used anyway so that a future change
 * which stamps both from one event still resolves the tie toward the cancellation.
 */
function cancelledFirst(cancellation: Cancellation, progress: Progress): boolean {
  const at = cancellation.at();
  if (at === undefined) return false;
  return progress.completedAt === undefined || at <= progress.completedAt;
}

/**
 * The context the handler receives.
 *
 * Built here rather than handed in — one owner of an invocation's cancellation — so the signal a
 * handler holds and the latch this file reaches its verdict from cannot describe different things.
 *
 * Its render barrier gives up when the call is cancelled. Invariant: **a handler awaiting a render
 * never outlives its call.** Without it, a handler waiting for a commit on a page that has gone quiet
 * waits forever — and the call settles nowhere, which is the zero-outcome silence this file exists to
 * prevent, arriving through a different door.
 *
 * Rejecting rather than resolving is deliberate: a handler that resumed normally would go on to read
 * state and return a result this file would then discard. Throwing unwinds it at the line that asked
 * to wait, the way an aborted `fetch` does.
 */
function contextFor(call: InvocationInputs, cancellation: Cancellation): ToolCallContext {
  const { signal } = cancellation;
  return {
    signal,
    afterRender: () =>
      new Promise<void>((resolve, reject) => {
        if (cancellation.by() !== undefined) {
          reject(cancelledWhileWaiting());
          return;
        }
        let settled = false;
        void cancellation.cancelled.then(() => {
          if (settled) return;
          settled = true;
          reject(cancelledWhileWaiting());
        });
        call.afterRender().then(
          () => {
            if (settled) return;
            settled = true;
            resolve();
          },
          (cause: unknown) => {
            if (settled) return;
            settled = true;
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          },
        );
      }),
  };
}

/**
 * What a handler awaiting the barrier is thrown when its call is cancelled.
 *
 * Its message is for a developer reading a stack, not for the agent: what the agent is told is composed
 * from this library's own vocabulary, and the verdict comes from the latch rather than from this value.
 */
function cancelledWhileWaiting(): Error {
  return new Error(
    'the call was cancelled while its handler was waiting for the application to render',
  );
}

/**
 * Builds the outcome for a call that was cancelled, and names WHICH cancellation it was.
 *
 * Invariant: **the source is the LATCHED first cause, not the state of a signal read afterwards.**
 * Both sources can abort, in either order, and sticky state answers "did this ever happen?" rather
 * than "what ended the call?" — so an agent that cancelled just before a route change would be
 * reported as the route change, and an operator would go looking for the wrong thing.
 *
 * The two causes carry opposite diagnoses, which is why they are two:
 *
 *   - `callAbandoned` — the tool stopped being declared while the call ran. The agent is **still
 *     waiting**, so this result is a frame that genuinely gets sent.
 *   - `callCancelled` — the agent cancelled, or the channel ended. Measured: the protocol layer
 *     discards the response to a cancelled request, so nothing reaches the agent and nothing needs to.
 */
function cancelled(
  name: string,
  cancellation: Cancellation,
  progress: Progress,
  observation?: CallObservation,
): ToolCallResult {
  // **Whether the handler had already run is part of the message, not a second code.**
  //
  // Telling an agent that nothing happened when the mutation landed is forbidden. The cases where
  // that matters and the cases where a cancellation is a cancellation are the same two codes with
  // different histories, so the history goes in the text rather than doubling a closed set that has to
  // stay small enough to reason about.
  //
  // It is reachable: post-handler work — proving the result can cross a wire, checking it against a
  // declared output schema — is asynchronous, and a validator is application-adjacent code that can
  // take arbitrarily long or never finish at all. Bounding it is why an outcome always arrives; saying
  // the handler already ran is why the outcome is not a lie.
  const already =
    progress.completedAt === undefined
      ? ''
      : ' — the tool had already run, so the application may have changed';

  // **Noted HERE, because this is the one funnel every cancellation return passes through.**
  //
  // A review found the terminal was reporting `uncoded` for a cancelled call — six return sites each
  // bypassed `noteFailure`, so the dispatcher's finalizer had nothing to settle with and fell back to
  // the default. That told an operator a call ended for no reason this library could name, when it
  // had ended for one of the two most specific reasons it has. Noting it at the funnel rather than at
  // six sites is also what stops the seventh from being forgotten.
  //
  // The two causes carry opposite diagnoses, which is why they stay two: a withdrawal means the tool
  // stopped being declared while running, and a cancellation means the caller gave up.
  const code =
    cancellation.by() === CANCELLED_BY.withdrawal
      ? RUNTIME_FAILURE.callAbandoned
      : RUNTIME_FAILURE.callCancelled;
  observation?.noteFailure({ vocabulary: FAILURE_VOCABULARY.runtime, code });

  return cancellation.by() === CANCELLED_BY.withdrawal
    ? refusal(
        observation,
        RUNTIME_FAILURE.callAbandoned,
        `the call to "${name}" was cancelled because the tool stopped being declared while it was running${already}`,
      )
    : refusal(
        observation,
        RUNTIME_FAILURE.callCancelled,
        `the call to "${name}" was cancelled before it completed${already}`,
      );
}

/**
 * Builds a refusal the agent receives as a tool error.
 *
 * Composed here from this library's vocabulary, like every other thing an agent is told.
 *
 * **The redaction rule, stated exactly, because "never echo the agent" is not what it says and every
 * refusal in this file has to be written against the real version:**
 *
 *   - A **value** the agent sent is never repeated. Not an argument, not a nested field, not one that
 *     failed validation. That rule was established by closing a live leak — a call carrying a
 *     password had the password sent back to the agent in the diagnostic — and it holds at every
 *     gate rather than only at the validator.
 *   - An **identifier the agent already holds** is repeated, deliberately: the tool's name, a field
 *     path, the permitted members of a declared enum. Every one of those came from the listing or from
 *     the schema the agent was given, so naming it discloses nothing and is the whole corrective value
 *     of a refusal. A message reduced to "a tool was refused" costs a model the ability to fix itself
 *     and buys nothing.
 *
 * The two are not the same distinction as "ours versus theirs". A tool name arrives in the request, so
 * it IS the agent's input — and it is still named, because it is an identifier the agent chose from a
 * list this library published.
 */
function refusal(
  observation: CallObservation | undefined,
  code: RuntimeError['code'],
  message: string,
): ToolCallResult {
  // **Recorded HERE, because this is the one funnel every refusal passes through.**
  //
  // Eight of the twelve refusal sites used to return without noting anything, so the dispatcher's
  // finalizer had nothing to settle with and fell back to `uncoded`. An operator watching the
  // inspector saw a confirmation a person had explicitly declined reported as a call that ended for
  // no reason this library could name — while the AGENT was correctly told
  // `MCP_TOOL_CONFIRMATION_REFUSED`. Two surfaces, one event, different stories.
  //
  // This is the same defect a review already found once for cancellation, fixed there by noting at
  // that function's funnel. Fixing it a second time by adding a ninth call would have left a tenth to
  // forget; taking the observation as a REQUIRED parameter means a refusal that records nothing is no
  // longer something this file can express.
  observation?.noteFailure({ vocabulary: FAILURE_VOCABULARY.runtime, code });
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}

/**
 * Renders a handler's return value as text, or reports that it cannot be.
 *
 * `undefined` means "not serializable" rather than being thrown, so the caller handles it on the same
 * footing as any other failure. A cycle, a live DOM node, a store reference or a `BigInt` all land
 * here — and every one of them is a plausible thing for an application handler to return by accident.
 *
 * A handler that returns nothing is not a failure: it produces an empty string, which is a legitimate
 * result for a tool whose whole effect was the mutation it performed.
 *
 * **Exported because BOTH call routes must normalize with the same code, not with two implementations
 * that agree today.** The registry route serializes a result to a JSON string too
 * (`docs/design.md#tool-results`), so a value checked before that round trip is not the value its
 * caller receives. Measured, in both directions:
 * `{ value: { toJSON: () => null } }` under a schema requiring an object passes a raw check and
 * arrives as `{"value":null}`; a `Date` under a string schema fails a raw check and arrives as a
 * perfectly valid string. Validating the raw value on that route produces exactly that defect.
 */
export function normalize(value: unknown): { text: string; value: unknown } | undefined {
  if (value === undefined) return { text: '', value: undefined };
  if (typeof value === 'string') return { text: value, value };
  try {
    const text = JSON.stringify(value);
    // `JSON.stringify` returns undefined rather than throwing for a function or a bare `undefined`
    // nested where a value was expected. Treated the same way: there is nothing to send.
    if (text === undefined) return { text: '', value: undefined };
    // Parsed back, so the value that gets validated and the value that gets sent are the SAME thing.
    // A `Date` that serialized to a string is now a string here, which is what the agent will see and
    // therefore what a declared output schema has to be true of.
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Builds the error result the agent receives.
 *
 * Invariant: **what the agent is told is composed here, from this library's vocabulary.** The
 * handler's own message is not passed through — an application's error text is not ours to publish
 * across a socket, and it is exactly where a credential or an internal identifier ends up.
 *
 * In a development build the underlying cause is attached, because that is where a developer reads it
 * and the agent is their own. In production it is not. The stack never crosses in either build: the
 * SDK serializes only an error's name, message and code, so the message is the whole exposure — which
 * is precisely why this function controls it.
 */
/**
 * The failure code a handler named for itself, when it named one it is allowed to name.
 *
 * Shape-based on purpose (see the call site): anything carrying a `code` that is a member of the
 * closed reportable subset. A thrown value with no code, an unknown code, or a code outside the subset
 * all yield nothing and are reported as an execution failure — which is the safe direction, because
 * the alternative lets a handler describe a gate outcome it did not decide.
 */
function reportableCode(cause: unknown): RuntimeFailureCode | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code !== 'string' || !isRuntimeFailureCode(code)) return undefined;
  return HANDLER_REPORTABLE.has(code) ? code : undefined;
}

/**
 * The message that travels with a handler-reported failure.
 *
 * Taken from the thrown value only when it is a string, and never from anything else — an object's
 * `toString` is application code, and this is a socket.
 */
function describeReportable(cause: unknown): string {
  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'the tool refused the call';
}

function toolError(failure: RuntimeError, cause?: unknown): ToolCallResult {
  const detail =
    IS_DEVELOPMENT && cause instanceof Error ? ` (${cause.name}: ${cause.message})` : '';
  return {
    content: [{ type: 'text', text: `${failure.code}: ${failure.message}${detail}` }],
    isError: true,
  };
}
