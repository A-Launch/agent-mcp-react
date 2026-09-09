import type { SchemaValidator } from '@agent-mcp/react';

// A validator that compiles no code, for a page served under a strict Content-Security-Policy.
//
// **Why an application needs this at all.** The bundled `createAjvValidator` uses Ajv, which compiles
// a JSON Schema into a JavaScript function with `new Function`. Under a policy whose `script-src`
// omits `unsafe-eval` that throws at DECLARATION — and this library refuses to register a tool whose
// declared schema has no working validator, so the page registers nothing and the agent sees an empty
// application. Measured; recorded in `docs/issues/validator-requires-unsafe-eval.md`.
//
// **This is the seam working as designed, not a workaround for a broken one.** `SchemaValidator` is an
// interface the application supplies precisely so a deployment can bring a validator that suits its
// environment. What was missing was the documentation saying so.
//
// **It is deliberately MINIMAL and is not a general JSON Schema implementation.** It covers exactly the
// keywords this demonstrator's own tools declare, listed below, and refuses to pretend about anything
// else. An embedder copying this must check it against their own schemas — a validator that silently
// accepts what it does not understand is worse than none, because the whole point of declaring a
// schema is that something enforces it.
//
// Covered: `type` (object, string, number, integer, boolean, array), `required`,
// `additionalProperties: false`, `enum`, `items`, `properties`, `minimum`, `maximum`,
// `minLength`, `maxLength`.
// NOT covered, and refused loudly rather than ignored: `$ref`, `allOf`, `anyOf`, `oneOf`, `not`,
// `patternProperties`, `format`, `if`/`then`/`else`, and every other keyword.

/** Keywords this validator understands. Anything else makes a schema unusable rather than lenient. */
const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'description',
  'title',
  'default',
]);

type Schema = Record<string, unknown>;

/** Every path in a schema this validator would silently fail to enforce. */
function unsupportedKeywords(schema: Schema, path = ''): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED.has(key)) found.push(`${path}${key}`);
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        if (typeof sub === 'object' && sub !== null) {
          found.push(...unsupportedKeywords(sub as Schema, `${path}properties.${name}.`));
        }
      }
    }
    if (key === 'items' && typeof value === 'object' && value !== null) {
      found.push(...unsupportedKeywords(value as Schema, `${path}items.`));
    }
  }
  return found;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, declared: unknown): boolean {
  const kinds = Array.isArray(declared) ? declared : [declared];
  const actual = typeOf(value);
  return kinds.some((kind) =>
    kind === 'number' ? actual === 'number' || actual === 'integer' : kind === actual,
  );
}

/**
 * Checks one value, collecting every problem rather than the first.
 *
 * **Names the field and what was permitted, never the value that was sent.** That is the same rule the
 * bundled adapter keeps and the reason it exists: a refusal travels to an agent over a socket, and a
 * rejected value is the likeliest thing in a call to be secret.
 */
function problemsIn(value: unknown, schema: Schema, path = ''): string[] {
  const problems: string[] = [];
  const where = path === '' ? 'the arguments' : `\`${path}\``;

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(' or ') : String(schema.type);
    return [`${where} must be ${expected}`];
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    problems.push(
      `${where} accepts only ${schema.enum.map((one) => JSON.stringify(one)).join(', ')}`,
    );
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      problems.push(`${where} must be at least ${schema.minLength} character(s)`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      problems.push(`${where} must be at most ${schema.maxLength} character(s)`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      problems.push(`${where} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      problems.push(`${where} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && typeof schema.items === 'object' && schema.items !== null) {
    for (const [index, entry] of value.entries()) {
      problems.push(...problemsIn(entry, schema.items as Schema, `${path}[${index}]`));
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;

    for (const name of (schema.required ?? []) as string[]) {
      if (!(name in record)) problems.push(`\`${path}${name}\` is required`);
    }
    if (schema.additionalProperties === false) {
      const permitted = Object.keys(properties);
      for (const name of Object.keys(record)) {
        if (!permitted.includes(name)) {
          problems.push(
            `\`${path}${name}\` is not a field this tool accepts — it accepts ${permitted.join(', ')}`,
          );
        }
      }
    }
    for (const [name, sub] of Object.entries(properties)) {
      if (name in record) problems.push(...problemsIn(record[name], sub, `${path}${name}.`));
    }
  }

  return problems;
}

/**
 * A `SchemaValidator` that compiles nothing.
 *
 * **Refuses a schema it does not fully understand, at compile time.** That is the important behaviour
 * and the reason this is safe to use: a validator that quietly ignored `oneOf` would report every call
 * valid and the tool would be advertising a contract nothing checks — which is exactly the state
 * validating in the runtime, before the handler, exists to end. Throwing here surfaces to the author
 * who wrote the schema, in
 * development, rather than to an agent much later.
 */
export function createCspSafeValidator(): SchemaValidator {
  return {
    compile(schema: Record<string, unknown>) {
      const unsupported = unsupportedKeywords(schema);
      if (unsupported.length > 0) {
        throw new Error(
          `this CSP-safe validator does not implement ${unsupported.join(', ')}, so it cannot enforce this schema. ` +
            'It covers type, properties, required, additionalProperties, enum, items, minimum and maximum. ' +
            'Use a fuller validator, or simplify the schema.',
        );
      }
      return {
        validate(value: unknown) {
          const problems = problemsIn(value, schema);
          return problems.length === 0
            ? ({ verdict: 'valid' } as const)
            : ({ verdict: 'invalid', reason: problems.join('; ') } as const);
        },
      };
    },
  };
}
