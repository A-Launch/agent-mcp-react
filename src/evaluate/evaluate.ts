import { RUNTIME_FAILURE, RuntimeError } from '../runtime/errors.ts';

// Level 3 — evaluating JavaScript in the page (docs/javascript-evaluation.md).
//
// **What this is, in the requirement of record's own words**, because paraphrasing it down is how it
// stops being taken seriously: it *"effectively grants arbitrary same-origin application execution
// privileges"* — the DOM, application globals, `localStorage`, `sessionStorage`, same-origin APIs,
// authenticated requests, and any non-HttpOnly credential the page can reach. The design requires it
// to be *"treated as equivalent to privileged code execution within the application origin"*.
//
// So this module is small and the conditions around it are the feature. It is reachable only when ALL
// of these hold, and none implies another:
//
//   1. the application IMPORTED it from `agent-mcp-react/evaluate` — a build that did not contains
//      none of this code;
//   2. an operator GRANTED the `evaluate` capability — nothing short of it admits this, not
//      `application`, not either half of `dom`;
//   3. a PERSON approved the call, seeing the code that will run;
//   4. and it is NEVER in the document's shared tool registry, in any configuration including the one
//      that granted it — because anything in that registry is callable by every script on the page
//      with not one gate in the path, and for this tool that would be the whole origin.
//
// **`new Function`, never `eval`.** `eval` proper runs in the CALLER's scope — which would be this
// library's, so an expression could reach the runtime's own bindings. A constructed function body
// compiles in global scope instead, measured: a module-scope variable is `undefined` inside one.
//
// **No sandbox, and that is deliberate rather than an omission.** A Worker or an iframe would stop the
// expression reaching the page, which is the entire purpose — it would advertise a capability it
// structurally cannot deliver.
//
// **No capability check lives here.** The gate is the runtime's, because a module that decides whether
// it may run is a module that can be imported past its own check.

/**
 * The async function constructor, reached through a function's own prototype.
 *
 * Not `globalThis.AsyncFunction` — there is no such global. This is the specified way to reach it, and
 * it is read once at module scope rather than per call.
 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  body: string,
) => () => Promise<unknown>;

/**
 * Compiles an expression, translating the two things that can go wrong into distinct causes.
 *
 * **Both surface at CONSTRUCTION, before anything runs**, which is what makes them answers rather than
 * execution failures — nothing executed and nothing changed.
 *
 * The two are kept apart because they are opposite diagnoses. A syntax error is the author's mistake.
 * A CSP refusal means the expression may be perfect and the PAGE forbids evaluating anything at all —
 * a correct configuration for a security-conscious application, and collapsing the two would send an
 * operator looking for a typo in an expression that is fine.
 */
function compile(expression: string): () => Promise<unknown> {
  try {
    return new AsyncFunction(expression);
  } catch (cause) {
    // Classified from the ERROR TYPE, which is the one place this library reads one — and it is sound
    // here because both are platform-thrown rather than application-thrown: the engine raises
    // `SyntaxError` for a malformed body and `EvalError` for a policy refusal. Neither can be produced
    // by application code that this function ever touches, because nothing has run yet.
    if (cause instanceof EvalError) {
      throw new RuntimeError(
        RUNTIME_FAILURE.evaluateForbiddenByPolicy,
        "this page's content security policy forbids evaluating code, so runtime.evaluate cannot run here",
      );
    }
    if (cause instanceof SyntaxError) {
      throw new RuntimeError(
        RUNTIME_FAILURE.evaluateNotCompilable,
        'that expression is not valid JavaScript, so nothing was run',
      );
    }
    throw cause;
  }
}

/**
 * Whether a value can cross a wire, and what to say when it cannot.
 *
 * **This exists because the failure is otherwise SILENT.** Measured: a function and `undefined`
 * serialize identically to nothing, so an agent that evaluated `() => doThing()` — forgetting to call
 * it — would receive an empty success and conclude the page returned nothing.
 *
 * The refusal names the KIND of value, never the value: the result is whatever an operator's
 * expression produced, and this is a socket.
 */
function requireCarriable(value: unknown): unknown {
  if (value === undefined) return { value: null, note: 'the expression returned undefined' };
  const kind = typeof value;
  if (kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new RuntimeError(
      RUNTIME_FAILURE.evaluateResultNotCarriable,
      `the expression returned a ${kind}, which cannot be sent to an agent. Return a value instead — a ${kind} is never carried, and returning one looks like returning nothing.`,
    );
  }
  return { value };
}

/**
 * Runs one expression and returns what it produced.
 *
 * The result is **not traversed, sanitized or transformed** (docs/design.md#security-invariants): this
 * library includes nothing automatically and strips nothing either. A result-sanitizer would be this
 * library deciding what an operator's own debugging expression meant — and the expression is the
 * disclosure boundary here, exactly as `getState` is for `useMcpState`.
 *
 * Each call constructs a FRESH function, so nothing is retained between calls. A persistent scope
 * would be state this library holds on the agent's behalf that the confirmation surface cannot see: a
 * person approving the third call would be approving something whose meaning depends on the first two.
 */
export async function evaluateExpression(expression: string): Promise<unknown> {
  const compiled = compile(expression);
  return requireCarriable(await compiled());
}
