// The runtime's failure vocabulary.
//
// Invariant this file enforces: **every failure this module produces is a member of the closed set
// below.** The dictionary is the one owner of that set: membership is derived from it, never
// re-listed as string literals somewhere else, and no error's class or message is ever read to
// reach a verdict.
//
// The set is many members rather than one "call failed" because the responses genuinely differ. An
// application author fixes one of these, an operator escalates another, and a third means a script
// outside this library's control holds a name. A single cause would hide which they are facing —
// which is the same reasoning that gave the registry boundary five availability causes.

/**
 * Why a request was refused, or a call failed.
 *
 * The first three are the resolution outcomes that are not `owned`; the rest are what can go wrong
 * once a name has resolved.
 */
export const RUNTIME_FAILURE = {
  /**
   * The name exists nowhere — not in the registry, not in the ownership record.
   *
   * Reported rather than allowed through. The SDK validates nothing: a name that appeared in no
   * listing is delivered straight to the call handler, so without this the agent reaches whatever the
   * handler does under a name nobody registered.
   */
  toolNotFound: 'MCP_TOOL_NOT_FOUND',
  /**
   * The name is in the registry but this library did not put it there.
   *
   * Distinct from `toolNotFound` because the application cannot resolve this by fixing its own code:
   * another script, a widget or an extension holds the name. It is not ours to shadow, rename around
   * or remove — and it is never bridged, because we never declared it, never validated it and cannot
   * gate it.
   */
  nameHeldByForeignOwner: 'MCP_TOOL_NAME_HELD_BY_FOREIGN_OWNER',
  /**
   * The name is in the ownership record but not in the registry.
   *
   * We believe we registered something that is not there. Unlike the case above — which is the normal
   * condition of a registry shared with every script on the page — this is a broken invariant, so it
   * is refused AND reported. Scoped to the one name: the runtime keeps serving everything else,
   * because a diagnosable condition must not become an outage.
   */
  ownershipDiverged: 'MCP_REGISTRY_OWNERSHIP_DIVERGED',
  /**
   * The handler threw, rejected, or returned something that could not be carried.
   *
   * Converted into a tool error result rather than allowed to escape. An uncaught throw reaches the
   * agent as a protocol error — the wrong kind, since a tool error says the tool ran and failed, which
   * is what a model needs in order to react — and it publishes the application's own error message,
   * which is not this library's to send.
   */
  toolExecutionFailed: 'MCP_TOOL_EXECUTION_ERROR',
  /**
   * What the handler returned cannot be serialized.
   *
   * Its own cause rather than folded into execution failure, because the fix is different: the handler
   * ran correctly and returned a live object, a cycle or something else that cannot cross a wire.
   *
   * Named separately for a second reason. Without the check that raises it, the response is never
   * sent at all — no frame, no error, no rejection — and the agent blocks until its own timeout. A
   * cause that exists is how that silence became something a reader can find.
   */
  resultNotSerializable: 'MCP_TOOL_RESULT_NOT_SERIALIZABLE',
  /**
   * A request arrived before the runtime was connected, or after it was shut down.
   *
   * Refused rather than queued. Holding it would mean an agent believing a call was accepted while it
   * waits for a connection that may never come.
   */
  runtimeNotServing: 'MCP_REACT_NOT_CONNECTED',
  /**
   * The agent could not be told that the page's tool set changed.
   *
   * Its own cause because of what it costs: the agent keeps whatever listing it last read, and every
   * call it makes from that point is reasoned from a page that no longer exists. Nothing in the
   * request path reveals it — a stale listing answers questions perfectly well — so a send that fails
   * while the runtime genuinely believed it was connected is the only place it can be noticed.
   *
   * A send skipped because the connection had already gone is NOT this. An unmount is not an anomaly,
   * and reporting one here would teach an operator to ignore the channel that carries the real thing.
   */
  toolListNotificationFailed: 'MCP_TOOL_LIST_NOTIFICATION_FAILED',
  /**
   * The arguments did not match the tool's declared input schema.
   *
   * Refused before the handler ran. This is the whole point of declaring a schema: without it the
   * value is written into application state, the tool reports success, and the page is wrong in a way
   * that reads as the model's mistake rather than a missing check.
   */
  argumentsInvalid: 'MCP_TOOL_ARGUMENTS_INVALID',
  /**
   * The handler's result did not match the tool's declared output schema.
   *
   * **Distinct from `argumentsInvalid`, and the distinction is not cosmetic: the handler ALREADY RAN.**
   * Whatever it changed is changed. An agent told "your arguments were refused" would believe nothing
   * happened and retry, performing the mutation twice. This says the opposite — the call was made and
   * what came back cannot be trusted.
   */
  resultViolatesOutputSchema: 'MCP_TOOL_RESULT_VIOLATES_OUTPUT_SCHEMA',
  /**
   * A declared schema could not be compiled — it is not valid JSON Schema, or it uses a keyword the
   * configured dialect does not admit.
   *
   * Raised at DECLARATION, not at invocation. An author who misspells a keyword finds out when they
   * wrote it, rather than through a refusal of a correct agent call much later.
   */
  schemaNotCompilable: 'MCP_TOOL_SCHEMA_NOT_COMPILABLE',
  /**
   * A tool declared a schema and no validator is available to enforce it.
   *
   * The tool is NOT registered. Advertising a contract nothing checks would make the schema
   * documentation again, which is the state this feature exists to end — and "we ran it unvalidated
   * but told you so" is observability of an absence rather than the validation that was asked for.
   */
  validatorMissing: 'MCP_TOOL_VALIDATOR_MISSING',
  /**
   * The tool's control level is not admitted by this connection's capability set.
   *
   * Refused at INVOCATION, and that is the whole point — not merely omitted from `tools/list`,
   * because absence from a listing is not an access control. A Level 1 tool stays listed when
   * `application` is withheld, because a list that shrank would look to an agent like an
   * application that unmounted its features, and a named refusal tells it what actually happened.
   *
   * Its own code rather than folded into `toolNotFound`. The two are opposite diagnoses: one says
   * nobody declared this, the other says somebody did and this connection may not reach it. An
   * operator resolves the second by changing a capability, and would never find it under the first.
   */
  capabilityDenied: 'MCP_TOOL_CAPABILITY_DENIED',
  /**
   * The application currently declares this tool unavailable.
   *
   * **Distinct from `capabilityDenied`, and from `toolNotFound`, because all three are different
   * answers to "why can I not call this".** A capability is an operator's decision about a whole
   * connection; availability is the APPLICATION's decision about one tool, right now, and it usually
   * tracks state an agent can change — a workflow step that is not reachable yet, a record that is
   * already paid. An agent told the right one of these can wait and retry; told the wrong one it
   * either gives up on a tool that is about to work or hammers one that never will.
   *
   * Refused at INVOCATION. An unavailable tool is also excluded from the listing, and that exclusion is
   * not the control: an agent holding a listing from a moment ago, or guessing a name, is exactly
   * the case a control exists for.
   *
   * It does NOT mean the tool was withdrawn. The registration is still in the document's registry and
   * any script in the page still reaches it — availability governs this library's bridge and not
   * the page (`docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page`).
   */
  toolUnavailable: 'MCP_TOOL_DISABLED',
  /**
   * The tool requires an operator's approval and there is nobody to ask.
   *
   * The tool is still LISTED. This is a deployment fact rather than a property of the tool — an
   * application declared that a person must approve this action and did not supply the surface that
   * asks one — so hiding it would tell an agent the action does not exist, when what is true is that
   * it cannot be approved here. An operator reading this fixes it by supplying a resolver.
   */
  confirmationUnavailable: 'MCP_TOOL_CONFIRMATION_UNAVAILABLE',
  /**
   * The confirmation was not given.
   *
   * Covers a person declining, and every way a resolver can fail to produce a decision: throwing,
   * rejecting, or returning something that is not a member of the decision set. They are one cause
   * because they are one outcome — **nobody approved this call** — and because the alternative leaks:
   * an agent told "your approval attempt crashed" learns about the inside of a dialog it has no
   * business seeing, and a model would reasonably retry a crash where it must not retry a refusal.
   *
   * Whatever the resolver produced is never included, for the same reason a handler's message is not:
   * it is application text, and this is a socket.
   */
  confirmationRefused: 'MCP_TOOL_CONFIRMATION_REFUSED',
  /**
   * The capability set handed to the provider could not be understood.
   *
   * Nothing runs under it: no registry is resolved, no document claim is taken, no tool is registered
   * and no socket is opened. An unknown member means an author believes they granted something, and a
   * page that had already exposed itself by the time anyone objected would be exposed under
   * capabilities nobody wrote. An unreadable capability set fails loud here; it never
   * falls back to a convenient default.
   *
   * Development throws this to the author; production reports it here and serves nothing.
   */
  capabilitiesUnusable: 'MCP_CAPABILITIES_UNUSABLE',
  /**
   * The call was cancelled by the agent, or the channel carrying it ended.
   *
   * **Nothing is wrong.** An agent is entitled to change its mind, and a socket is entitled to drop.
   * It is a failure cause only in the sense that the call did not complete — which is the one thing
   * that must never be reported as a success.
   *
   * Measured, and the reason this code is mostly for the page's own record rather than for the agent:
   * the protocol layer discards the response to a request the client cancelled. The client has already
   * rejected its own call by the time this is composed.
   */
  callCancelled: 'MCP_TOOL_CALL_CANCELLED',
  /**
   * The call was cancelled because the tool stopped being declared while it was running.
   *
   * Distinct from `callCancelled` because the diagnosis is the opposite one. Here the AGENT still
   * wants the call and is still waiting for it — so unlike a client cancellation, this result is a
   * frame that actually gets sent, and failing to send it leaves an agent blocked until its own
   * timeout. What an operator is looking at is a route change or an unmount racing a tool call.
   *
   * Not raised by a descriptor change. A tool whose description or schema was replaced is still
   * declared by the same component, and the handler running is the current one — collapsing that into
   * a withdrawal would cancel calls a rerender should cost nothing, and a rerender must cost
   * nothing.
   */
  callAbandoned: 'MCP_TOOL_CALL_ABANDONED',
  /**
   * A DOM reference this document issued is no longer usable.
   *
   * **An instruction rather than a failure**: the agent was correctly told something and it has
   * stopped being true, so the message tells it to take another snapshot. Nothing is broken and there
   * is nothing for an operator to fix (`docs/dom-inspection.md`).
   *
   * Raised by any of five conditions — a newer snapshot replaced the table, the element left the
   * document, the page navigated, the element no longer matches the role and name it was PUBLISHED
   * under, or the application invalidated references explicitly. The fourth is the one no reader
   * predicts and the one that matters most: React reuses a row's DOM node across a data change, so
   * a reference can point at a connected element, at an unchanged URL, that is now showing somebody
   * else's record.
   * Measured in this repository.
   *
   * Distinct from `domRefNotFound` because an agent acts on them differently, which is the whole
   * reason there are two.
   */
  domRefStale: 'MCP_DOM_REF_STALE',
  /**
   * A DOM reference this document never issued.
   *
   * Invented, mistyped, or carried over from another tab — references are per-document state, and a
   * token minted in one page instance means nothing in another (`docs/design.md#page-identity`).
   *
   * **It deliberately does NOT tell the agent to re-snapshot.** Re-snapshotting cannot conjure a token
   * nobody minted, so sending an agent round that loop would turn a wrong argument into a retry
   * storm. What is wrong is the token.
   *
   * Decidable with no memory of retired tokens, because references are minted from one monotonic
   * counter and never reused: an ordinal at or below the highest ever minted was issued, and anything
   * above it — or unparseable — was not.
   */
  domRefNotFound: 'MCP_DOM_REF_NOT_FOUND',
  /**
   * The element a Level 2 write tool was asked to operate cannot be operated.
   *
   * It is not perceivable, or it — or an ancestor — declares it unavailable: `disabled`,
   * `aria-disabled`, `inert`, or `pointer-events: none`. A fill adds `readOnly`.
   *
   * **Decided by this library BEFORE anything is dispatched, because the platform is unreliable in
   * both directions, and that was measured rather than assumed.** A programmatic click on a
   * `disabled` element is silently swallowed, so without this the tool reports success for a call that
   * did nothing. A programmatic click on an `inert` element, or one under `pointer-events: none`, goes
   * straight through — a synthetic click skips hit-testing — so without this an agent does something
   * no person at the same page could do.
   *
   * **Distinct from a stale reference, and the diagnosis is the opposite one.** A stale reference says
   * the page moved on and the agent should look again. This says the agent is looking at the right
   * element and the page will not let it be touched — re-snapshotting changes nothing, and what an
   * agent should do is find another route or report that it cannot proceed.
   *
   * **What it does NOT cover, and the limit is deliberate:** an element that is zero-sized, clipped, or
   * covered by an overlay. Deciding that needs layout, and layout is unreadable in the environment most
   * of this repository's cases run in — a check for it would pass vacuously in the suites while looking
   * correct in a browser, which is the shape of a guard that reports success.
   */
  domNotInteractable: 'MCP_DOM_NOT_INTERACTABLE',
  /**
   * A Level 3 expression could not be compiled — it is not valid JavaScript.
   *
   * **Raised before anything runs.** A function body's syntax is checked at CONSTRUCTION rather than at
   * call, which is what lets this be a distinct answer instead of an execution failure: nothing
   * executed, nothing changed, and what needs fixing is the expression.
   *
   * Distinct from the cause below, which is the opposite diagnosis — there the expression may be
   * perfect and the PAGE forbids evaluating anything at all.
   */
  evaluateNotCompilable: 'MCP_RUNTIME_EVALUATE_SYNTAX',
  /**
   * The page's own content security policy forbids evaluating code.
   *
   * A `script-src` without `unsafe-eval` makes function construction throw. **This is a correct
   * configuration for a security-conscious application, not a malfunction**, and it must not reach an
   * operator as an execution failure that reads like a bug in their expression. What they are being
   * told is that their page's policy forbids this — which is an answer, and arguably the right one.
   */
  evaluateForbiddenByPolicy: 'MCP_RUNTIME_EVALUATE_FORBIDDEN',
  /**
   * The expression returned something that cannot cross a wire, and the agent is told WHAT.
   *
   * Its own cause rather than the general serialization failure, because the fix is different and
   * because the failure is otherwise SILENT. Measured: a function and `undefined` both serialize to
   * nothing, indistinguishably — so an agent that evaluated `() => doThing()`, forgetting to call it,
   * would receive an empty success and conclude the page returned nothing.
   *
   * The message names the kind of value that came back. It does NOT name the value: the result is
   * whatever the operator's expression produced, and this is a socket.
   */
  evaluateResultNotCarriable: 'MCP_RUNTIME_EVALUATE_RESULT_NOT_CARRIABLE',
} as const;

export type RuntimeFailureCode = (typeof RUNTIME_FAILURE)[keyof typeof RUNTIME_FAILURE];

/**
 * The failures a HANDLER may name for itself, rather than having its throw reported as an execution
 * failure.
 *
 * **Why this set exists at all.** A handler that throws is reported as `MCP_TOOL_EXECUTION_ERROR` —
 * the tool ran and failed — and that is right for an application's handler, whose internal error is
 * not this library's to publish and whose vocabulary this library does not know. It is WRONG for a
 * built-in whose refusal this vocabulary already gives a name to: a stale DOM reference reported as
 * an execution failure tells an agent the tool broke, when what is true is that the agent should
 * take another snapshot. The distinction is the entire value of having two codes.
 *
 * **Why it is a closed SUBSET rather than "preserve whatever was thrown".** A handler is code this
 * library did not write, and a handler that could name any member could claim
 * `MCP_TOOL_CAPABILITY_DENIED` — falsifying the record of a gate that in fact admitted the call, on
 * the one surface an operator uses to answer "why was this refused". Membership here is the narrow
 * permission to report a condition the handler is genuinely the authority on, and nothing else.
 *
 * Levels 2 and 3 each contribute their own members, and each one below says why the handler is the
 * authority on the condition it names.
 */
export const HANDLER_REPORTABLE: ReadonlySet<RuntimeFailureCode> = new Set([
  RUNTIME_FAILURE.domRefStale,
  RUNTIME_FAILURE.domRefNotFound,
  // The handler is genuinely the authority on this one: whether an element can be operated is a fact
  // about the page at the instant of the call, not a property of the request — so it cannot be a
  // gate-chain step without making the chain read the DOM, which is what keeps `src/runtime/` testable
  // without a document.
  RUNTIME_FAILURE.domNotInteractable,
  // All three are conditions the Level 3 handler is the authority on: two are discovered while
  // constructing the function, before anything runs, and the third is a property of what the
  // expression returned.
  RUNTIME_FAILURE.evaluateNotCompilable,
  RUNTIME_FAILURE.evaluateForbiddenByPolicy,
  RUNTIME_FAILURE.evaluateResultNotCarriable,
]);

/** Membership derived from the dictionary, so a new cause cannot be half-added. */
const RUNTIME_FAILURE_CODES: ReadonlySet<string> = new Set(Object.values(RUNTIME_FAILURE));

export function isRuntimeFailureCode(value: string): value is RuntimeFailureCode {
  return RUNTIME_FAILURE_CODES.has(value);
}

/**
 * Every failure this module raises.
 *
 * One class, because a caller distinguishes cases by `code` — a value from the closed set above —
 * rather than by `instanceof`, which is the test that breaks the moment two copies of this library are
 * bundled onto one page.
 */
export class RuntimeError extends Error {
  readonly code: RuntimeFailureCode;
  /** The tool name the failure concerns, when it concerns one. */
  readonly toolName?: string;

  constructor(code: RuntimeFailureCode, message: string, toolName?: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    if (toolName !== undefined) this.toolName = toolName;
  }
}
