import { describe, expect, it } from 'vitest';
import {
  type CompiledSchema,
  check,
  VALIDATION,
  type ValidationOutcome,
} from '../../../src/runtime/validation.ts';

// The envelope around a validator, tested against validators that misbehave.
//
// Every case here is about a validator the application supplied doing something the runtime did not
// ask for. That is not a hypothetical: the validator is a third-party library reached through a
// factory the application called, and this boundary is the only thing between it and the protocol
// layer. A throw that escaped would reach the agent as a PROTOCOL error — "your request was
// malformed" — for a call that was perfectly well formed.

function compiled(validate: CompiledSchema['validate']): CompiledSchema {
  return { validate };
}

describe('a validator that behaves', () => {
  it('passes a valid value through', async () => {
    const outcome = await check(
      compiled(() => ({ verdict: VALIDATION.valid })),
      { n: 1 },
    );
    expect(outcome.verdict).toBe(VALIDATION.valid);
  });

  it('carries an invalid verdict and its reason', async () => {
    const outcome = await check(
      compiled(() => ({ verdict: VALIDATION.invalid, reason: 'data/n must be number' })),
      { n: 'no' },
    );
    expect(outcome).toEqual({ verdict: VALIDATION.invalid, reason: 'data/n must be number' });
  });

  it('works the same whether the validator is synchronous or asynchronous', async () => {
    const sync = await check(
      compiled(() => ({ verdict: VALIDATION.valid })),
      {},
    );
    const async = await check(
      compiled(() => Promise.resolve({ verdict: VALIDATION.valid as typeof VALIDATION.valid })),
      {},
    );
    expect(sync.verdict).toBe(async.verdict);
  });
});

describe('a validator that misbehaves', () => {
  it('turns a throw into an unusable verdict rather than letting it escape', async () => {
    const outcome = await check(
      compiled(() => {
        throw new TypeError('ajv exploded');
      }),
      {},
    );

    // Not `invalid`. The two mean opposite things about the VALUE: `invalid` says the arguments were
    // wrong, this says nothing is known about them. Reporting a broken validator as a failed
    // validation would send an agent off fixing arguments that may be fine.
    expect(outcome.verdict).toBe(VALIDATION.unusable);
    expect(outcome).toHaveProperty('reason', expect.stringContaining('TypeError: ajv exploded'));
  });

  it('turns a rejection into an unusable verdict', async () => {
    const outcome = await check(
      compiled(() => Promise.reject(new Error('gone'))),
      {},
    );
    expect(outcome.verdict).toBe(VALIDATION.unusable);
  });

  it('refuses an answer that is not a verdict, rather than falling through to valid', async () => {
    // **The case that matters most in this file.** A validator returning `undefined`, `true`, or an
    // object with a verdict nobody defined is broken — and any code that reads `outcome.verdict !==
    // 'invalid'` as "fine" reports an unvalidated call as validated. Membership is checked, never
    // inferred from shape: a received string is validated against the dictionary, never cast onto it.
    for (const answer of [undefined, null, true, 'valid', {}, { verdict: 'ok' }, 42]) {
      const outcome = await check(
        compiled(() => answer as unknown as ValidationOutcome),
        {},
      );
      expect(outcome.verdict, `answering with ${JSON.stringify(answer)}`).toBe(VALIDATION.unusable);
    }
  });

  it('names the missing reason rather than refusing with an empty message', async () => {
    const outcome = await check(
      compiled(() => ({ verdict: VALIDATION.invalid }) as unknown as ValidationOutcome),
      {},
    );

    // A refusal with no information is the least actionable thing a refusal can be, and an empty
    // string would reach the agent as exactly that.
    expect(outcome.verdict).toBe(VALIDATION.invalid);
    expect(outcome).toHaveProperty('reason', expect.stringContaining('gave no reason'));
  });

  it('survives an answer whose own properties throw when read', async () => {
    // **Reading a property can run code.** A `verdict` accessor that throws escapes a `try` covering
    // only the call to `validate` — which is how this was written first, and a probe walked straight
    // through the never-throw guarantee. The envelope has to cover everything done with what a
    // validator hands back.
    const hostile: CompiledSchema = {
      validate: () =>
        Object.defineProperty({}, 'verdict', {
          get() {
            throw new Error('the verdict getter threw');
          },
        }) as unknown as ValidationOutcome,
    };

    const outcome = await check(hostile, {});
    expect(outcome.verdict).toBe(VALIDATION.unusable);
  });

  it('survives an answer whose REASON throws when read', async () => {
    const hostile: CompiledSchema = {
      validate: () =>
        Object.defineProperty({ verdict: VALIDATION.invalid }, 'reason', {
          get() {
            throw new Error('the reason getter threw');
          },
        }) as unknown as ValidationOutcome,
    };

    const outcome = await check(hostile, {});
    expect(outcome.verdict).toBe(VALIDATION.unusable);
  });

  it('survives a cause that cannot be rendered', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const outcome = await check(
      compiled(() => {
        throw cyclic;
      }),
      {},
    );

    // The rendering of a failure must not become a second failure. A cyclic object thrown by a
    // validator is unusual; a reporting path that throws while reporting is a page that breaks for a
    // reason nobody can read.
    expect(outcome.verdict).toBe(VALIDATION.unusable);
  });
});
