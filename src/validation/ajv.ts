import { Ajv, addFormats } from '@modelcontextprotocol/server/validators/ajv';
import {
  type CompiledSchema,
  type SchemaValidator,
  VALIDATION,
  type ValidationOutcome,
} from '../runtime/validation.ts';

// The JSON Schema validator an application installs so its declared schemas are enforced.
//
// **This is an optional subpath, and it is optional in the BUNDLE only.** A tool that declares a
// schema and has no validator available is not registered at all — the runtime refuses the
// declaration rather than advertising a contract nothing checks. So this import is not a feature an
// application chooses; it is the thing that makes a schema it already wrote mean something.
//
// It is separate from the root entry for one measured reason: the validator chunk is **54,313 bytes
// gzipped**, larger than the size budget everything else in this library is held to
// (docs/records/performance-budgets.md). An application whose tools declare no schemas should not
// carry it, and one whose tools do should carry it knowingly.
//
// ## Why this is not `new AjvJsonSchemaValidator()`
//
// The SDK ships an adapter around the same library, and using it directly would be less code. It
// reduces the validator's structured errors through `errorsText()`, which keeps the failing path and
// **discards the rejected value and the permitted set**: an enum failure becomes "must be equal to one
// of the allowed values".
//
// That difference decides whether this feature pays for itself. The application code this replaces
// says `segments does not accept "entrprise"` and lists what it does accept. A model told which values
// are allowed corrects on its next call; a model told only that its value was wrong retries blindly,
// which costs a round trip and reads as the model being bad at the task. So the errors are read
// structurally and the message is composed here.

/**
 * The JSON Schema dialect this validator admits.
 *
 * **Draft 07, and that is a measurement rather than a choice.** The MCP SDK bundles its validator
 * internally and re-exports only the draft-07 `Ajv` — not `Ajv2020` — so this is the dialect available
 * through the surface this project already depends on. Verified rather than assumed: the instance
 * reports `http://json-schema.org/draft-07/schema` as its meta-schema, and rejects `prefixItems` and
 * `$dynamicRef`, both of which exist only in 2020-12.
 *
 * **An earlier version of this constant said `draft-2020-12` and was simply wrong.** Naming the
 * dialect is named precisely so an author knows which keywords are real; naming the
 * wrong one is worse than naming none, because it invites writing `prefixItems` and reading the
 * resulting "unknown keyword" refusal as a bug in this library.
 *
 * An embedder who needs 2020-12 can supply their own `SchemaValidator` — that interface exists for
 * exactly this — adding `ajv` to their own dependencies and constructing `Ajv2020` themselves.
 */
export const DIALECT = 'draft-07' as const;

/** One error as the validator reports it, before it is turned into something a caller can act on. */
interface StructuredError {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly message?: string;
  readonly params?: Record<string, unknown>;
}

export interface AjvValidatorOptions {
  /**
   * Accept keywords the dialect does not define, instead of refusing the schema.
   *
   * Off by default and deliberately awkward to reach. It exists because a schema written against a
   * vocabulary this build does not know is a real situation; it is off because the common case is a
   * typo, and a typo that silently removes a constraint is the worst kind.
   */
  readonly allowUnknownKeywords?: boolean;
}

/**
 * Builds the validator an application hands to the provider.
 *
 * Constructing one compiles nothing. Each schema is compiled once, at declaration, and the compiled
 * form is held for the tool's lifetime — compiling is the expensive half, and invocation overhead is
 * budgeted at under 5 ms excluding the handler (docs/records/performance-budgets.md).
 */
/**
 * **This validator requires a Content-Security-Policy that permits `unsafe-eval`.**
 *
 * Ajv compiles a JSON Schema into a JavaScript function with `new Function`. Under a `script-src`
 * that omits `unsafe-eval` that throws while COMPILING — at declaration, not at invocation — and this
 * library refuses to register a tool whose declared schema has no working validator, rather than
 * advertising a contract nothing checks. So a strict-CSP application using this exposes **no tools at
 * all**, and an agent sees an empty page.
 *
 * Measured in a real browser, not inferred: `Error compiling schema… Evaluating a string as
 * JavaScript violates the following Content Security Policy directive`. Recorded in
 * `docs/issues/validator-requires-unsafe-eval.md`.
 *
 * **The seam is the answer, and it is why `SchemaValidator` is an interface.** An application under a
 * strict policy supplies a validator that compiles nothing;
 * `examples/customer-dashboard/src/csp-safe-validator.ts` is a worked example, deliberately minimal
 * and explicit about which keywords it covers.
 */
export function createAjvValidator(options: AjvValidatorOptions = {}): SchemaValidator {
  const ajv = new Ajv({
    // Every error, not only the first. A caller told about one bad field at a time needs one round
    // trip per mistake, and an agent doing that against a live page is making real calls each time.
    allErrors: true,
    // Refuses a schema whose keywords this dialect does not define. This is the setting that turns a
    // misspelled keyword from a silent weakening into a loud refusal at declaration.
    strictSchema: options.allowUnknownKeywords !== true,
    // No mutation of the value being checked, in either direction. A validator that coerced `"42"` to
    // `42`, or inserted a `default`, would be deciding what the agent meant — and the difference
    // between what was sent and what was applied would exist nowhere a reader could see it.
    coerceTypes: false,
    useDefaults: false,
    // **The rejected value is never even collected.** Ajv attaches the offending data to each error
    // only under `verbose`, so leaving this off means the message composition below has nothing to
    // leak by accident — a second, independent layer under the invariant that a refusal names
    // identifiers and never the value it received.
    //
    // It is spelled out although `false` is Ajv's own default, because a guarantee resting on a
    // dependency's unwritten default is a guarantee nobody can see. Found during a break-it pass:
    // deleting the redaction from the message composition did NOT turn the cases red,
    // because there was no data attached to interpolate — which meant the case could not tell which of
    // the two layers it was actually testing. Both are needed and both are now stated.
    verbose: false,
  });

  // **Registered, or `format` is a compile error rather than a check.** Without this, `strictSchema`
  // refuses any schema using `format: 'email'` with "unknown format ignored" — so an author writing a
  // perfectly ordinary schema would be told their declaration is broken. With it, the format is
  // actually enforced. The failure mode being avoided is the opposite of the `requird` one: there, a
  // silent pass; here, a refusal that reads as a bug in this library.
  addFormats(ajv);

  return {
    compile(schema: Record<string, unknown>): CompiledSchema {
      // Throws when the schema cannot be compiled, which is the designed path: it happens at
      // declaration, where the author can fix it, rather than at invocation where a correct agent
      // call is refused for a reason that has nothing to do with the agent.
      const validate = ajv.compile(schema);

      return {
        validate(value: unknown): ValidationOutcome {
          if (validate(value) === true) return { verdict: VALIDATION.valid };
          const errors = (validate.errors ?? []) as StructuredError[];
          return { verdict: VALIDATION.invalid, reason: explain(errors) };
        },
      };
    },
  };
}

/**
 * Composes the refusal an agent receives.
 *
 * This function is the whole reason this module exists rather than a one-line re-export. It reads the
 * validator's structured errors and keeps what a caller needs in order to correct itself: **where** it
 * went wrong and **what was allowed**.
 *
 * **Invariant: nothing the agent sent is ever quoted back to it.** Every string here comes from the
 * SCHEMA — a path the application declared, a type it named, the permitted set it wrote — or from this
 * library's own words. Never from the value.
 *
 * That rule is unconditional, at every capability level, for every tool, and it is enforced *here*
 * rather than filtered further out, because the next diagnostic composed downstream would not know to
 * filter — and filtering downstream is working around the leak instead of closing it where it is
 * produced.
 *
 * **It was not always true, and the defect was real.** An earlier version quoted the rejected value:
 * this adapter was written partly for the better message, and the collision between that message and
 * redaction had to be settled. What it produced, measured:
 *
 * ```
 * `password` must be number, but "hunter2-secret" was sent;
 * `role` does not accept "sk-ant-SECRETKEY" — it accepts "admin", "user"
 * ```
 *
 * **What is lost is a nicety, and what is kept is the reason this adapter exists.** A model told
 * *"`role` is not one of the permitted values — they are admin, user"* corrects on its next call
 * exactly as well as one told what it had sent. The SDK's own adapter reduces both to "must be equal
 * to one of the allowed values", which is what neither of these does.
 *
 * A rejected value is not lost to the *application*: it is in the arguments the agent sent, and the
 * operator-facing surfaces can show it. It simply never crosses back over the socket.
 */
function explain(errors: readonly StructuredError[]): string {
  if (errors.length === 0) return 'the value did not match the declared schema';
  return errors.map(explainOne).join('; ');
}

function explainOne(error: StructuredError): string {
  const where = field(error.instancePath ?? '');
  const params = error.params ?? {};

  if (error.keyword === 'enum') {
    const allowed = params.allowedValues;
    const permitted = Array.isArray(allowed)
      ? allowed.map(render).join(', ')
      : 'the declared values';
    // The permitted set comes from the SCHEMA, so it is the application's own words and safe to send.
    // What the caller sent is deliberately absent.
    return `${where} is not one of the permitted values — they are ${permitted}`;
  }

  if (error.keyword === 'required') {
    // A property NAME, not a value. It is in the schema the agent was given.
    const missing = params.missingProperty;
    return `${where === 'the value' ? 'the value' : where} is missing required property ${render(missing)}`;
  }

  if (error.keyword === 'additionalProperties') {
    // Also a name the agent itself chose and already knows; no value is disclosed by repeating it.
    return `${where} does not accept the property ${render(params.additionalProperty)}`;
  }

  if (error.keyword === 'type') {
    return `${where} must be ${String(params.type)}`;
  }

  // The validator's own text for everything else. It describes the CONSTRAINT — "must NOT have more
  // than 3 characters" — and the adapter is configured so that it never interpolates the data.
  return `${where} ${error.message ?? 'did not match the declared schema'}`;
}

/** Turns `/xs/1` into something a person and a model both read the same way. */
function field(instancePath: string): string {
  if (instancePath === '') return 'the value';
  return `\`${instancePath.slice(1).split('/').join('.')}\``;
}

/**
 * Renders one SCHEMA-derived value for a message. Bounded, because a declared enum can be long.
 *
 * Never called on anything an agent sent — see the invariant on `explain`. The bound is here because a
 * permitted set can be large, not because the input is untrusted.
 */
function render(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
