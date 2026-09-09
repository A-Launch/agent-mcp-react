import type { RuntimeError } from '../runtime/index.ts';
import { CLAIM_REFUSED, type ClaimRefusedCode, type WebMcpBoundaryError } from '../webmcp/index.ts';

// This module's failure vocabulary: what the React binding itself can refuse, expressed as a closed
// set so that no call site ever spells a code as a string literal — one exported dictionary, its type
// derived from it, and a received string checked for membership rather than cast onto it.
//
// What it owns: exactly one cause of its own — a hook used with no provider above it. Everything else
// a caller sees through this module is raised elsewhere and passes through unchanged: the claim
// refusal belongs to `src/webmcp/`, registration refusals belong to `src/webmcp/`, and connection
// failures belong to `src/transport/`. They are re-exported here so an application needs one import
// to recognise what it was handed, and are NOT re-wrapped: a second error type over the same
// condition would give one failure two identities, and a caller that matched on the wrong one would
// look correct in every test that used the other.

/**
 * Why this module refused.
 *
 * Small, and kept that way deliberately. A provider claim already has a vocabulary and so does a
 * registration; inventing parallel members here would put the same condition in two closed sets, and
 * the two would drift the first time one of them gained a case. Every member below is a condition that
 * arises in THIS module and nowhere else — the two newest both belong to the shared-registry route,
 * which by construction does not pass through the runtime.
 */
export const REACT_REFUSED = {
  /**
   * `useMcpTool` was called by a component with no provider above it.
   *
   * Loud, never a no-op. A hook that quietly did nothing would leave an application believing it
   * instrumented an action, and an agent that never sees the tool — which is the silent success this
   * library exists to make impossible, arriving before a call is even made.
   */
  providerMissing: 'MCP_REACT_PROVIDER_MISSING',
  /**
   * A call arriving through the SHARED document registry did not match the tool's declared schema.
   *
   * Its own cause because of where it comes from: not the agent, but a script on the page invoking the
   * descriptor this library registered — the one described in docs/declaring-a-tool.md. That route does
   * not pass through the runtime, so the runtime's own `MCP_TOOL_ARGUMENTS_INVALID` never applies to it
   * — and a reader tracing a refusal needs to know which of the two routes produced it, because only
   * one of them is an agent.
   */
  argumentsInvalid: 'MCP_REACT_ARGUMENTS_INVALID',
  /**
   * The connection state machine was asked for a transition it does not declare.
   *
   * **This one is never an application's doing** — the only code that publishes a connection state is
   * the provider, so reaching it means this library asked for something its own table forbids. It is
   * reported rather than published: publishing would put a state on screen that the declared machine
   * says cannot happen, and swallowing it would leave a hidden unknown where a loud failure belongs.
   *
   * It exists because reconnection roughly doubled the table's edges and made it ENFORCED rather than
   * described. A table nothing reads is a comment, and a comment drifts from the code it describes
   * without anything failing.
   */
  transitionForbidden: 'MCP_REACT_CONNECTION_TRANSITION_FORBIDDEN',
  /**
   * A call arrived through the SHARED document registry for a descriptor no mounted component is
   * declaring any more.
   *
   * The window is between the hook's cleanup and the registry finishing the withdrawal it triggers, so
   * this should be unreachable — but an unexpected state fails loud, so it is refused rather than
   * assumed impossible. The alternative was handing the handler a substitute cancellation signal that
   * could never fire, which would tell it it had cancellation it does not have.
   */
  toolNotDeclared: 'MCP_REACT_TOOL_NOT_DECLARED',
  /**
   * An observability callback the application supplied threw.
   *
   * **Never this library's own defect**, which is why it has its own code rather than arriving as a
   * bare report. `onUnexpectedState` is the operator's destination for broken invariants, and once it
   * also carries consumer failures an operator reading it needs to know which kind they are looking
   * at — otherwise a bug in an application's logging sends them into this library's internals.
   *
   * The call itself is unaffected: it is not awaited on the observer, its outcome does not change, and
   * the remaining events for it are still delivered to every other subscriber. Reported rather than
   * swallowed all the same: an unexpected state fails loud.
   */
  observerFailed: 'MCP_REACT_OBSERVER_FAILED',
  /**
   * A state surface was declared with no schema.
   *
   * **Its own cause, and the two nearest existing codes were both rejected for reasons that needed
   * the code to establish.** `RUNTIME_FAILURE.validatorMissing` means "declares a schema and no
   * validator is installed" — reusing it would tell an author to install a validator when their
   * actual mistake is a missing schema, sending them somewhere they cannot fix anything.
   * `REGISTRATION_REFUSED` lives in `src/webmcp/`, whose members answer "why did the REGISTRY not
   * take this name"; a missing schema is not a registry condition, and that module must not learn
   * what a state surface is.
   *
   * A state surface's schema is REQUIRED where `useMcpTool`'s `outputSchema` is optional, because a
   * mutating tool's return value is incidental to what it did while a state surface's return value
   * IS the whole thing it offers. Registering one unvalidated would silently widen what crosses to
   * the agent, which is the decision this feature exists to make deliberately.
   *
   * **Loud in BOTH builds, unlike a duplicate name — and the difference is what kind of mistake it
   * is.** A duplicate is an ENVIRONMENTAL collision: another component or another script holds the
   * name, the page runs correctly without that one tool, and tearing it down would be worse than the
   * collision. This is an INCOHERENT DECLARATION: there is no version of the page where it is right,
   * TypeScript rejects it at compile time, and it reaches a production build only through untyped
   * consumption. `providerMissing` above is the same class and behaves the same way.
   */
  stateSchemaMissing: 'MCP_REACT_STATE_SCHEMA_MISSING',
  /**
   * A tool invoked through the SHARED document registry returned a value that does not match its
   * declared output schema.
   *
   * **Never `argumentsInvalid`, and the reason is the same one the bridge has for keeping its own two
   * codes apart: the handler ALREADY RAN.** A caller told its arguments were refused would believe
   * nothing happened and retry, performing the mutation a second time. The bridge's equivalent is
   * `MCP_TOOL_RESULT_VIOLATES_OUTPUT_SCHEMA`; this is its registry-route sibling, distinct because a
   * reader tracing a refusal needs to know which of the two routes produced it and only one of them
   * is an agent.
   *
   * It exists because this route validated INPUT and not OUTPUT while the ownership entry's own
   * comment claimed *"one compiled contract per tool, so the two routes cannot enforce different
   * things"* — true of input, false of output, and invisible for six features. The check uses the
   * same compiled schema object the bridge uses, so the claim is now true of both.
   */
  resultViolatesOutputSchema: 'MCP_REACT_RESULT_VIOLATES_OUTPUT_SCHEMA',
} as const;

export type ReactRefusedCode = (typeof REACT_REFUSED)[keyof typeof REACT_REFUSED];

/** Membership derived from the dictionary, so a new cause cannot be half-added. */
const REACT_REFUSED_CODES: ReadonlySet<string> = new Set(Object.values(REACT_REFUSED));

export function isReactRefusedCode(value: string): value is ReactRefusedCode {
  return REACT_REFUSED_CODES.has(value);
}

/**
 * Everything an application can be handed from this module, as one union.
 *
 * A caller branches on `code` rather than on `instanceof`. The reason is the same one the boundary
 * gives: two copies of this library on one page produce two class identities for one condition, and
 * an `instanceof` check is then correct for whichever copy the checking code was bundled with.
 */
export type ReactFailureCode = ReactRefusedCode | ClaimRefusedCode;

/**
 * A failure raised by the React binding itself.
 *
 * Deliberately NOT used for a claim refusal, a registration refusal or a connection failure — those
 * arrive as the error the owning module raised, with its own code, and this module passes them along
 * without translation.
 */
export class AgentMcpReactError extends Error {
  readonly code: ReactRefusedCode;

  /**
   * `cause` is optional and reaches the OPERATOR's destination only.
   *
   * That is the whole reason it is safe here. The redaction rule governs what crosses to the AGENT: a
   * value the agent sent is never repeated, and an application's own error text is not ours to publish
   * across a socket. `onUnexpectedState` is neither — it is the application telling itself, in its own
   * page, about something it needs to fix. Dropping the original throw there would leave a developer
   * with "an observer failed" and no way to find which one.
   */
  constructor(code: ReactRefusedCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'AgentMcpReactError';
    this.code = code;
  }
}

/**
 * What reaches the provider's unexpected-state destination.
 *
 * Two kinds of report now travel it: a broken invariant the runtime detected while serving (an
 * ownership divergence), and a contested tool name in a production build — where the conflict must be
 * reported without tearing the application down.
 *
 * **No new vocabulary, deliberately.** Both carry a `code` from a closed set that already exists, so a
 * receiver branches on the code it already had to handle. Inventing a wrapper here would give one
 * condition two identities and put the same fact in two dictionaries, when a fact has one owner.
 *
 * What a receiver must be able to do — tell the two kinds apart without reading a message string — is
 * asserted rather than assumed: `tests/unit/react/report-kinds.spec.ts` holds that the codes reaching
 * this destination do not overlap.
 */
/**
 * What can reach the operational channel.
 *
 * Three shapes rather than two: the React binding has an invariant of its own to report — a connection
 * transition its declared machine forbids — and a receiver branches on the code, which every one of
 * these carries from a closed set.
 */
export type UnexpectedStateReport = RuntimeError | WebMcpBoundaryError | AgentMcpReactError;

export { CLAIM_REFUSED };
