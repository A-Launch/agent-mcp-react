// The boundary onto a schema validator, and the envelope that stops one from taking the runtime with
// it.
//
// **What this module owns:** the shape a validator must present, the vocabulary of an outcome, and the
// guarantee that calling one never throws out of here. It owns no schema, compiles nothing, and has no
// idea which validator it is talking to — which is what lets every branch below be pinned against a
// fake, and what lets the real one live in an optional subpath the embedder chooses.
//
// **Why the envelope, rather than trusting the validator:** the validator is supplied by the
// application. It is a third-party library reached through a factory the application called, and it
// can throw, return nonsense, or reject. A throw escaping into the runtime becomes a PROTOCOL error —
// which tells an agent the request was malformed rather than that the tool refused it — and a rejected
// promise nobody holds is silent. Neither is a thing a page should be able to cause by installing a
// validator, and neither may be swallowed here: an unexpected state is reported, never hidden.

/** What a validator reports about one value. A closed set, declared once with its type derived. */
export const VALIDATION = {
  /** The value matched the schema. */
  valid: 'valid',
  /** The value did not match. Carries a reason written for whoever has to fix the call. */
  invalid: 'invalid',
  /**
   * The validator itself failed — threw, rejected, or answered with something that is not an outcome.
   *
   * Its own member rather than folded into `invalid`, because the two mean opposite things about the
   * VALUE. `invalid` says the arguments were wrong; this says nothing is known about them. Reporting
   * a broken validator as a failed validation would tell an agent to fix arguments that may be fine.
   */
  unusable: 'unusable',
} as const;

export type ValidationVerdict = (typeof VALIDATION)[keyof typeof VALIDATION];

export type ValidationOutcome =
  | { readonly verdict: typeof VALIDATION.valid }
  | { readonly verdict: typeof VALIDATION.invalid; readonly reason: string }
  | { readonly verdict: typeof VALIDATION.unusable; readonly reason: string };

/**
 * One compiled schema, ready to check values.
 *
 * Compiled once at declaration and held on the ownership entry, never rebuilt per call: compiling is
 * the expensive half, and the performance budget allows under 5 ms of invocation overhead excluding
 * the handler (`docs/records/performance-budgets.md`).
 */
export interface CompiledSchema {
  /**
   * Checks one value.
   *
   * MAY throw or reject — `check()` below is what makes that safe. A validator implementation is not
   * required to be careful; it is required to be honest, and this interface cannot enforce either.
   */
  validate(value: unknown): Promise<ValidationOutcome> | ValidationOutcome;
}

/**
 * What an application supplies so its declared schemas can be enforced.
 *
 * Obtained from `agent-mcp-react/validation`, or written by an embedder that has its own. Passed to
 * the provider as a value rather than installed by importing a module for its side effects: a
 * validator that arrives because somebody imported something is one whose presence cannot be reasoned
 * about from the code that depends on it.
 */
export interface SchemaValidator {
  /**
   * Compiles one schema, or throws if it cannot.
   *
   * **Throwing here is the designed path, not a failure mode.** It happens at declaration, where the
   * author can fix it — rather than at invocation, where a correct agent call is refused for a reason
   * that has nothing to do with the agent.
   */
  compile(schema: Record<string, unknown>): Promise<CompiledSchema> | CompiledSchema;
}

/**
 * Runs one compiled schema against one value and always answers.
 *
 * Never throws, never rejects. Every way a validator can misbehave becomes an `unusable` outcome
 * carrying what actually happened, so the caller has one thing to branch on instead of a try/catch at
 * every call site — which is how one of them eventually goes missing.
 */
export async function check(compiled: CompiledSchema, value: unknown): Promise<ValidationOutcome> {
  try {
    // **`interpret` is INSIDE the try, and that is not tidiness.** Reading a property can run code: an
    // object whose `verdict` is a getter that throws escapes a `try` that covers only the call. It was
    // written the other way first and a probe walked straight through the guarantee. The envelope has
    // to cover everything done with what a validator hands back, not only the handing back.
    return interpret(await compiled.validate(value));
  } catch (cause) {
    return {
      verdict: VALIDATION.unusable,
      reason: `the validator failed while checking: ${describe(cause)}`,
    };
  }
}

/**
 * Reads a validator's answer, refusing anything that is not one.
 *
 * A validator returning `undefined`, a bare boolean, or an object with a verdict nobody defined is a
 * broken validator — and treating any of those as "valid" by falling through is exactly how an
 * unvalidated call gets reported as validated. Membership in the closed set is checked, never
 * assumed from shape.
 */
function interpret(answered: unknown): ValidationOutcome {
  const verdict = (answered as { verdict?: unknown } | null | undefined)?.verdict;

  if (verdict === VALIDATION.valid) return { verdict: VALIDATION.valid };

  if (verdict === VALIDATION.invalid || verdict === VALIDATION.unusable) {
    const reason = (answered as { reason?: unknown }).reason;
    return {
      verdict,
      // A reason is required by the type, so its absence means the validator did not honour the
      // contract. Named rather than defaulted to empty: an empty reason reaches an agent as a refusal
      // with no information, which is the least actionable thing a refusal can be.
      reason:
        typeof reason === 'string' && reason !== ''
          ? reason
          : 'the validator refused the value but gave no reason',
    };
  }

  return {
    verdict: VALIDATION.unusable,
    reason: `the validator answered with something that is not a verdict: ${describe(answered)}`,
  };
}

/** Renders an unknown thing for a message, without letting the rendering itself throw. */
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return String(JSON.stringify(value) ?? String(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}
