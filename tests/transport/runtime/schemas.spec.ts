// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, stack } from './harness.ts';

// What an agent actually experiences when a tool declares a contract: refusals it can act on, and
// results it can trust.
//
// Asserted through a real MCP client over a real socket, because the two things that matter here are
// both observable only from that side — whether the handler ran, and what the agent was told.

afterEach(closeAll);

const SEGMENTS = ['enterprise', 'midmarket', 'startup'];

function textOf(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content ?? [])
    .map((block) => block.text ?? '')
    .join('');
}

function failed(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('a call that does not match the declared schema', () => {
  it('never reaches the handler, and says which field and which values', async () => {
    const page = await stack();
    let entered = 0;

    await page.registerWithSchemas(
      'customers.set_filters',
      () => {
        entered += 1;
        return 'ok';
      },
      {
        input: {
          type: 'object',
          properties: { segment: { type: 'string', enum: SEGMENTS } },
          additionalProperties: false,
        },
      },
    );

    const refused = await page.client.callTool({
      name: 'customers.set_filters',
      arguments: { segment: 'entrprise' },
    });

    // **The handler is what the assertion is really about.** Checking only the returned error would
    // pass for a handler that ran, mutated the application, and then failed — which is the shape this
    // feature exists to prevent, not a variant of it.
    expect(entered).toBe(0);
    expect(failed(refused)).toBe(true);

    // And the refusal is one a model can act on: which field, and what it could have sent. A model
    // told only "must be equal to one of the allowed values" retries blindly.
    const message = textOf(refused);
    expect(message).toContain('"enterprise"');
    expect(message).toContain('segment');

    // **What it sent is NOT in the message.** The same
    // path carries a password or a token when one fails validation, so nothing an agent sent is ever
    // quoted back over the socket. This is the wire-level half of the rule; the unit half, including
    // the case that separates it from a field-name heuristic, is in
    // `tests/unit/security/redaction.spec.ts`.
    expect(message).not.toContain('entrprise');

    // The pairing: the same tool, on the same connection, works when the value is one it declared.
    const accepted = await page.client.callTool({
      name: 'customers.set_filters',
      arguments: { segment: 'enterprise' },
    });
    expect(failed(accepted)).toBe(false);
    expect(entered).toBe(1);
  });

  it('refuses a missing required field, and an unexpected one', async () => {
    const page = await stack();
    let entered = 0;
    await page.registerWithSchemas(
      'account.open',
      () => {
        entered += 1;
        return 'ok';
      },
      {
        input: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    );

    expect(textOf(await page.client.callTool({ name: 'account.open', arguments: {} }))).toContain(
      'id',
    );
    expect(
      textOf(
        await page.client.callTool({ name: 'account.open', arguments: { id: 'a', extra: 1 } }),
      ),
    ).toContain('extra');
    expect(entered).toBe(0);
  });
});

describe('a tool that declares no schema', () => {
  it('behaves exactly as it did before this feature', async () => {
    const page = await stack();
    // Nothing to validate, so validation is not applicable — not skipped, not defaulted to permissive.
    // Every tool declared without a schema is this tool, and none of them may break.
    await page.register('legacy.tool', (args) => ({ saw: args }));

    const result = await page.client.callTool({
      name: 'legacy.tool',
      arguments: { anything: [1, 2, 3] },
    });
    expect(failed(result)).toBe(false);
    expect(textOf(result)).toContain('anything');
  });
});

describe('a tool that promises a shape', () => {
  it('returns structured content ALONGSIDE text, never instead of it', async () => {
    const page = await stack();
    await page.registerWithSchemas('customers.count', () => ({ matched: 4, of: 48 }), {
      output: {
        type: 'object',
        properties: { matched: { type: 'number' }, of: { type: 'number' } },
        required: ['matched', 'of'],
      },
    });

    const result = (await page.client.callTool({ name: 'customers.count', arguments: {} })) as {
      structuredContent?: unknown;
      content?: { text?: string }[];
    };

    expect(result.structuredContent).toEqual({ matched: 4, of: 48 });
    // A client that does not read structured content must still receive something usable
    // (docs/design.md#tool-results).
    expect(textOf(result)).toContain('matched');
  });

  it('refuses a result that violates the promise, with a code of its own', async () => {
    const page = await stack();
    await page.registerWithSchemas('bad.tool', () => ({ matched: 'four' }), {
      output: {
        type: 'object',
        properties: { matched: { type: 'number' } },
        required: ['matched'],
      },
    });

    const result = await page.client.callTool({ name: 'bad.tool', arguments: {} });

    expect(failed(result)).toBe(true);
    // **Not the input code**, and the distinction is not cosmetic: the handler ALREADY RAN and may
    // have mutated the application. An agent told its arguments were refused would believe nothing
    // happened and retry, performing the mutation twice.
    expect(textOf(result)).toContain('MCP_TOOL_RESULT_VIOLATES_OUTPUT_SCHEMA');
    expect(textOf(result)).not.toContain('MCP_TOOL_ARGUMENTS_INVALID');
  });

  it('validates what will be SENT, not what the handler returned', async () => {
    const page = await stack();
    // A `Date` is an object that satisfies `type: object` before serialization and is a STRING after
    // it. Validating the raw handler result would pass, and the agent would receive a string where
    // its schema promised an object — data contradicting the contract it was checked against.
    await page.registerWithSchemas('date.tool', () => ({ at: new Date(0) }), {
      output: {
        type: 'object',
        properties: { at: { type: 'object' } },
        required: ['at'],
      },
    });

    const result = await page.client.callTool({ name: 'date.tool', arguments: {} });
    expect(failed(result)).toBe(true);
  });

  it('gives no structured content to a tool that promised none', async () => {
    const page = await stack();
    await page.register('plain.tool', () => ({ shape: 'not promised' }));

    const result = (await page.client.callTool({ name: 'plain.tool', arguments: {} })) as {
      structuredContent?: unknown;
    };

    // Structure is never invented. An agent handed a shape nobody guaranteed treats it as a contract,
    // and the first handler that returns something different breaks it silently.
    expect(result.structuredContent).toBeUndefined();
  });

  it('still answers when a result cannot be serialized at all', async () => {
    const page = await stack();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await page.registerWithSchemas('cyclic.tool', () => cyclic, {
      output: { type: 'object' },
    });

    // The silence this whole file's ordering is designed against: before `serialize` existed, an
    // unserializable result produced NO frame — no error, no rejection — and the agent blocked until
    // its own timeout. Output validation is a new way to reach that, so it is asserted to not.
    const result = await page.client.callTool({ name: 'cyclic.tool', arguments: {} });
    expect(failed(result)).toBe(true);
    expect(textOf(result)).toContain('MCP_TOOL_RESULT_NOT_SERIALIZABLE');
  });
});

describe('what an agent is shown about a tool', () => {
  it('includes the output schema, which the document registry cannot carry', async () => {
    const page = await stack();
    const output = { type: 'object', properties: { matched: { type: 'number' } } };
    await page.registerWithSchemas('described.tool', () => ({ matched: 1 }), { output });

    const listed = (await page.client.listTools()) as {
      tools: { name: string; outputSchema?: unknown }[];
    };
    const tool = listed.tools.find((entry) => entry.name === 'described.tool');

    // The registry's descriptor has no output schema, so this can only have come from the ownership
    // record by way of the derived listing — which is the whole reason the listing is derived rather
    // than read back from the registry.
    expect(tool?.outputSchema).toEqual(output);
  });
});
