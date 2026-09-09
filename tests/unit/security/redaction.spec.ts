import { describe, expect, it } from 'vitest';
import { CONTROL_LEVEL } from '../../../src/index.ts';
import { type InvocationTarget, invoke } from '../../../src/runtime/invocation.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// Nothing an agent sent is ever quoted back to it.
//
// **This is a fix for a defect that shipped, not a new guarantee.** A richer validation adapter than
// the SDK's was built precisely so a refusal could name the rejected value AND the permitted set —
// which collided head-on with the rule that nothing an agent sent is ever quoted back
// (`docs/reference-capabilities.md#what-the-library-redacts-and-what-it-does-not`). Measured before
// the fix, this is what an agent received:
//
//   `password` must be number, but "hunter2-secret" was sent;
//   `role` does not accept "sk-ant-SECRETKEY" — it accepts "admin", "user"
//
// **What the rule costs, and why that is the right trade.** The rejected value is gone. The corrective
// information is not: the field, the expected type and the permitted set all survive, and a model told
// *"`role` is not one of the permitted values — they are admin, user"* corrects on its next call
// exactly as well. What neither version does is what the SDK's own adapter does, which is reduce both
// to "must be equal to one of the allowed values".
//
// **The rule is unconditional** — every capability level, every tool, every build. Not a per-tool
// declaration of sensitive fields, which would be a new authority every application could get wrong,
// and not a heuristic on field names, which would be a guess. The `notes` case below is the one that
// separates this from a heuristic: a field with an innocuous name is redacted too.

const validator = createAjvValidator();

function entryWith(schema: Record<string, unknown>): InvocationTarget {
  return {
    handler: () => 'ok',
    description: 'signs in',
    validators: { input: validator.compile(schema) },
  } as unknown as InvocationTarget;
}

async function refusalFor(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await invoke('auth.sign_in', entryWith(schema), args, {
    requestSignal: new AbortController().signal,
    afterRender: () => Promise.resolve(),
    capabilities: () => APPLICATION_ONLY,
    level: CONTROL_LEVEL.application,
    permissions: () => undefined,
  });
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? '';
}

describe('a rejected value never reaches the agent', () => {
  it('does not quote a value that failed a type check', async () => {
    const said = await refusalFor(
      { type: 'object', properties: { password: { type: 'number' } } },
      { password: 'hunter2-secret' },
    );
    expect(said).not.toContain('hunter2-secret');
    // And still says what to do about it.
    expect(said).toContain('`password`');
    expect(said).toContain('number');
  });

  it('does not quote a value that failed an enum check, but still names the permitted set', async () => {
    const said = await refusalFor(
      { type: 'object', properties: { role: { type: 'string', enum: ['admin', 'user'] } } },
      { role: 'sk-ant-SECRETKEY' },
    );
    expect(said).not.toContain('sk-ant-SECRETKEY');
    // **The half that must survive.** Without it this is a regression rather than a fix: a model told
    // only that it was wrong retries blindly, which is the whole reason this adapter exists at all.
    expect(said).toContain('admin');
    expect(said).toContain('user');
  });

  it('redacts a field whose name suggests nothing sensitive at all', async () => {
    // **The case that separates a rule from a heuristic.** A name-matching filter — password, token,
    // secret — passes every case above and fails this one. It is also the case that would be added
    // last and skipped first, so it is stated as the point rather than as an extra.
    const said = await refusalFor(
      { type: 'object', properties: { notes: { type: 'number' } } },
      { notes: 'the merger closes on Tuesday' },
    );
    expect(said).not.toContain('merger');
    expect(said).toContain('`notes`');
  });

  it('redacts a value nested inside an object', async () => {
    const said = await refusalFor(
      {
        type: 'object',
        properties: {
          credentials: { type: 'object', properties: { apiKey: { type: 'number' } } },
        },
      },
      { credentials: { apiKey: 'sk-live-DEADBEEF' } },
    );
    expect(said).not.toContain('DEADBEEF');
    // The path still points at it, which is what a caller needs.
    expect(said).toContain('credentials.apiKey');
  });

  it('names a missing property, which is a name the agent already has', async () => {
    // The pairing that keeps the rule from being read as "say nothing". A property NAME comes from the
    // schema the agent was given; repeating it discloses nothing it did not already know.
    const said = await refusalFor(
      { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
      {},
    );
    expect(said).toContain('account');
  });

  it('names an unexpected property the agent itself chose', async () => {
    const said = await refusalFor(
      { type: 'object', properties: {}, additionalProperties: false },
      { surprise: 'value-that-must-not-appear' },
    );
    expect(said).toContain('surprise');
    expect(said).not.toContain('value-that-must-not-appear');
  });
});

// **The OUTPUT direction, which is a different exposure from the one above.**
//
// Everything above is about a value the AGENT sent: the rule is that we never quote it back. A state
// read reverses the direction — the value being validated is the APPLICATION's own state, and a
// diagnostic that quoted it would send application data to the agent through an error rather than
// through the tool.
//
// That is the same defect as the one above, in the one place nobody looked for it, and a state
// surface is where it would bite hardest: `getState` returns the richest values in the page.
//
// **What this file can and cannot pin, stated because the difference matters.** These cases pin the
// BUNDLED adapter, which is deliberately configured never to interpolate the data. They cannot pin a
// validator an embedder supplies: `SchemaValidator` is a public seam and `ValidationOutcome.reason`
// is an unconstrained string that `invocation.ts` interpolates into what the agent receives. That
// limitation is documented rather than silently carried, and closing it properly would be a breaking
// change to the seam.

/** A value long and distinctive enough that no timestamp, count or length can contain it by luck. */
const CANARY = 'eyJhbGciOiJIUzI1NiJ9-CANARY-VALUE-THAT-MUST-NEVER-REACH-THE-AGENT-0123456789';

function producing(value: unknown, schema: Record<string, unknown>): InvocationTarget {
  return {
    handler: () => value,
    description: 'reads the customer state',
    validators: { output: validator.compile(schema) },
    outputSchema: schema,
  } as unknown as InvocationTarget;
}

async function outputRefusalFor(value: unknown, schema: Record<string, unknown>): Promise<string> {
  const result = await invoke(
    'customers.get_state',
    producing(value, schema),
    {},
    {
      requestSignal: new AbortController().signal,
      afterRender: () => Promise.resolve(),
      capabilities: () => APPLICATION_ONLY,
      level: CONTROL_LEVEL.application,
      permissions: () => undefined,
    },
  );
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? '';
}

describe("a rejected RESULT tells the agent nothing about the application's own data", () => {
  it('carries neither the value nor the property name that failed', async () => {
    const message = await outputRefusalFor(
      { sessionToken: CANARY },
      { type: 'object', properties: { sessionToken: { type: 'number' } } },
    );

    expect(message).not.toContain(CANARY);
    // **The stronger claim, and the one a review forced.** Withholding the VALUE is not enough here:
    // for an `additionalProperties` failure Ajv names the offending PROPERTY, and an object's keys are
    // routinely identifiers — `{ "user_8f3a…": … }`, `{ "tenant-secret-42": … }`. The adapter's own
    // comment justified naming it as "a name the agent itself chose and already knows", which is true
    // of an ARGUMENT and false of a RESULT.
    expect(message).not.toContain('sessionToken');
  });

  it('names no property from a value carrying an identifier as a key', async () => {
    // The realistic shape of the leak, rather than a field with a suspicious name. Nothing about
    // `{ [customerId]: … }` looks wrong until the key reaches an agent that had never seen it.
    const message = await outputRefusalFor(
      { 'user_8f3a91c4-tenant-42': { plan: 'enterprise' } },
      { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    );

    expect(message).not.toContain('user_8f3a91c4-tenant-42');
    expect(message).not.toContain('8f3a91c4');
  });

  it('does not quote a value nested inside the returned state', async () => {
    const message = await outputRefusalFor(
      { user: { name: 'ada', apiKey: CANARY } },
      {
        type: 'object',
        properties: {
          user: { type: 'object', properties: { apiKey: { type: 'number' } } },
        },
      },
    );

    expect(message).not.toContain(CANARY);
  });

  it('still says WHICH tool and WHAT went wrong, so the failure is not mute', async () => {
    // The refusal must stay actionable for the person who can fix it. What is withheld is the
    // application's data; what survives is the tool's name and the kind of failure — and the full
    // detail reaches the application through the observability surface, where the defect actually is.
    const message = await outputRefusalFor(
      { sessionToken: CANARY },
      { type: 'object', properties: { sessionToken: { type: 'number' } } },
    );

    expect(message).toContain('customers.get_state');
    expect(message).toContain('does not match its declared output schema');
  });

  it('carries its own code, never the input one, because the handler already ran', async () => {
    // An agent told its ARGUMENTS were refused believes nothing happened and retries. A read is
    // idempotent in principle, but `getState` is application code and the rule has to hold for the
    // mechanism rather than for the well-behaved case.
    const message = await outputRefusalFor(
      { sessionToken: CANARY },
      { type: 'object', properties: { sessionToken: { type: 'number' } } },
    );

    expect(message).toContain('MCP_TOOL_RESULT_VIOLATES_OUTPUT_SCHEMA');
    expect(message).not.toContain('MCP_TOOL_ARGUMENTS_INVALID');
  });
});
