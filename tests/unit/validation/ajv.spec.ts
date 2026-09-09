import { describe, expect, it } from 'vitest';
import { VALIDATION } from '../../../src/runtime/validation.ts';
import { createAjvValidator, DIALECT } from '../../../src/validation/ajv.ts';

// The installed validator, and specifically the parts of it that are NOT just "ajv works".
//
// Two groups of cases here, and they exist for different reasons:
//
//   - **The messages.** This module exists rather than being a one-line re-export of the SDK's own
//     adapter, because that adapter reduces structured errors through `errorsText()` and drops the
//     rejected value and the permitted set. Every case below that asserts a message is asserting the
//     difference between an agent that can correct itself and one that retries blindly.
//   - **The settings.** No coercion, no defaults, no unknown keywords. Each is a way a validator can
//     quietly change the meaning of a declared contract, and each is asserted rather than trusted —
//     they are configuration, and configuration is exactly what a later edit changes without noticing.

const validator = createAjvValidator();

async function refuse(schema: Record<string, unknown>, value: unknown): Promise<string> {
  const compiled = validator.compile(schema) as {
    validate(v: unknown): { verdict: string; reason?: string };
  };
  const outcome = compiled.validate(value);
  expect(outcome.verdict).toBe(VALIDATION.invalid);
  return outcome.reason ?? '';
}

async function accept(schema: Record<string, unknown>, value: unknown): Promise<void> {
  const compiled = validator.compile(schema) as { validate(v: unknown): { verdict: string } };
  expect(compiled.validate(value).verdict).toBe(VALIDATION.valid);
}

describe('the refusal an agent can act on', () => {
  it('names the permitted set for an enum, and never the rejected value', async () => {
    const reason = await refuse(
      {
        type: 'object',
        properties: { segment: { type: 'string', enum: ['enterprise', 'midmarket', 'startup'] } },
      },
      { segment: 'entrprise' },
    );

    // **The case this whole module exists for.** The SDK's adapter says "must be equal to one of the
    // allowed values" and stops there. A model receiving that knows only that it was wrong.
    expect(reason).toContain('"enterprise"');
    expect(reason).toContain('"midmarket"');
    expect(reason).toContain('segment');

    // **This assertion is the reverse of what it once was, and the change is the point.** This case
    // used to require the rejected value to appear, and that requirement was a defect: the same path
    // carries a password or a token when one fails validation. The collision was settled in favour of
    // redaction — the permitted set survives, the received value does not.
    // `tests/unit/security/redaction.spec.ts` owns the rule.
    expect(reason).not.toContain('entrprise');
  });

  it('names the path for a nested failure, and never the value at it', async () => {
    const reason = await refuse(
      {
        type: 'object',
        properties: { xs: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
      },
      { xs: ['a', 'zz'] },
    );

    // The path is what a caller needs in order to find what to fix, and it comes from the schema.
    expect(reason).toContain('xs.1');
    expect(reason).not.toContain('zz');
  });

  it('names the missing property for a required failure', async () => {
    const reason = await refuse(
      { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
      {},
    );
    expect(reason).toContain('account');
  });

  it('names the expected type for a type failure, and never the value', async () => {
    const reason = await refuse(
      { type: 'object', properties: { limit: { type: 'number' } } },
      { limit: 'twenty' },
    );
    expect(reason).toContain('limit');
    expect(reason).toContain('number');
    expect(reason).not.toContain('twenty');
  });

  it('names an unexpected property rather than only saying there was one', async () => {
    const reason = await refuse(
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      { a: 'x', tpyo: 1 },
    );
    expect(reason).toContain('tpyo');
  });

  it('reports every failure, not only the first', async () => {
    const reason = await refuse(
      { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      { a: 'no', b: 'also no' },
    );

    // One round trip per mistake is a real cost when each round trip is a call against a live page.
    expect(reason).toContain('a');
    expect(reason).toContain('b');
  });

  it('bounds an enormous value rather than echoing it whole', async () => {
    const reason = await refuse(
      { type: 'object', properties: { n: { type: 'number' } } },
      { n: 'x'.repeat(5000) },
    );
    expect(reason.length).toBeLessThan(400);
  });
});

describe('the settings that decide what a schema MEANS', () => {
  it('does not coerce', async () => {
    // A validator that accepted `"42"` for a number would be deciding what the agent meant, and the
    // difference between what was sent and what was applied would exist nowhere a reader could see.
    await refuse({ type: 'object', properties: { n: { type: 'number' } } }, { n: '42' });
  });

  it('does not insert defaults', async () => {
    const compiled = validator.compile({
      type: 'object',
      properties: { k: { type: 'string', default: 'inserted' } },
    }) as { validate(v: unknown): { verdict: string } };
    const value: Record<string, unknown> = {};
    compiled.validate(value);

    // The handler must receive what the agent sent. A value that appeared during validation is a
    // value the agent never chose and cannot be held to.
    expect(value).toEqual({});
  });

  it('refuses a schema whose keyword the dialect does not define', () => {
    // **The typo that silently removes a constraint.** With unknown keywords permitted, `requird`
    // compiles as an ignored annotation and `account` is simply not required — a contract weakened by
    // a misspelling, with nothing anywhere to notice. Refused at declaration instead.
    expect(() =>
      validator.compile({
        type: 'object',
        properties: { account: { type: 'string' } },
        requird: ['account'],
      }),
    ).toThrow();
  });

  it('refuses a schema that is not valid JSON Schema at all', () => {
    expect(() => validator.compile({ type: 'nonsense' })).toThrow();
  });

  it('lets an embedder accept unknown keywords deliberately', () => {
    // Deliberately awkward to reach, and it exists because a vocabulary this build does not know is a
    // real situation — just a much rarer one than a typo.
    const permissive = createAjvValidator({ allowUnknownKeywords: true });
    expect(() =>
      permissive.compile({ type: 'object', properties: {}, someVendorKeyword: true }),
    ).not.toThrow();
  });
});

describe('the dialect, which an author has to be able to trust', () => {
  it('is the one the bundled validator actually implements', async () => {
    // **This constant said `draft-2020-12` and was wrong.** The SDK re-exports only the draft-07 Ajv,
    // not Ajv2020. Naming the dialect is what makes an author's keyword choices predictable, so naming
    // the wrong one is worse than naming none: it invites writing `prefixItems` and reading the
    // resulting refusal as a bug in this library.
    expect(DIALECT).toBe('draft-07');

    // Asserted against behaviour, not against the string — the string is what drifts.
    expect(() => validator.compile({ type: 'array', prefixItems: [{ type: 'string' }] })).toThrow();
  });

  it('enforces `format` rather than refusing a schema that uses one', async () => {
    // Without formats registered, `strictSchema` refuses `format: 'email'` outright with "unknown
    // format ignored" — an ordinary schema reported as a broken declaration. The opposite failure from
    // the `requird` one above, and equally confusing.
    const reason = await refuse(
      { type: 'object', properties: { e: { type: 'string', format: 'email' } } },
      { e: 'definitely not an email' },
    );
    expect(reason).toContain('e');
  });
});

describe('what it accepts', () => {
  it('passes a value that matches', async () => {
    await accept(
      {
        type: 'object',
        properties: {
          segment: { type: 'string', enum: ['enterprise'] },
          limit: { type: 'number' },
        },
        required: ['segment'],
      },
      { segment: 'enterprise', limit: 5 },
    );
  });

  it('accepts a tool that declares an object with no properties', async () => {
    await accept({ type: 'object', properties: {} }, {});
  });
});
