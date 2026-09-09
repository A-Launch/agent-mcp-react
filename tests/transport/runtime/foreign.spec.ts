// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, stack } from './harness.ts';

// The single most consequential fact about the platform this library builds on: the tool registry
// belongs to the DOCUMENT and is shared with every script in it. Another library, a widget or a
// browser extension's page script can register tools into the same registry.
//
// The failure that produces is not an error. It is a silent widening: the agent gains reach over
// something nobody declared, validated or gated — and every symptom looks like the system working.
//
// Both halves are asserted in every case here. Absence from a listing is not an access control,
// because an agent may hold a list from before, and a well-behaved client is not the case a control
// exists for.

afterEach(closeAll);

function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? '').join('');
}

describe('a tool this library did not register', () => {
  it('appears in no listing', async () => {
    const page = await stack();
    await page.registerForeign('someone.elses_tool');

    expect((await page.client.listTools()).tools).toEqual([]);
  });

  it('is refused at invocation, not merely absent', async () => {
    const page = await stack();
    await page.registerForeign('someone.elses_tool');

    const result = await page.client.callTool({ name: 'someone.elses_tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.nameHeldByForeignOwner);
  });

  it('is refused with a cause distinct from a name that does not exist', async () => {
    const page = await stack();
    await page.registerForeign('someone.elses_tool');

    const foreign = await page.client.callTool({ name: 'someone.elses_tool', arguments: {} });
    const unknown = await page.client.callTool({ name: 'nobody.has_this', arguments: {} });

    // The distinction is actionable rather than cosmetic. An application can fix an unknown name by
    // registering it; it cannot fix a foreign one by changing its own code at all — the name belongs
    // to a script outside its control, and is not ours to shadow, rename around or remove.
    expect(textOf(foreign)).toContain(RUNTIME_FAILURE.nameHeldByForeignOwner);
    expect(textOf(unknown)).toContain(RUNTIME_FAILURE.toolNotFound);
    expect(RUNTIME_FAILURE.nameHeldByForeignOwner).not.toBe(RUNTIME_FAILURE.toolNotFound);
  });

  it('does not hide the tools this library did register', async () => {
    const page = await stack();
    await page.registerForeign('someone.elses_tool');
    await page.register('ours.tool', () => 'ours');
    await page.registerForeign('another.foreign_one');

    // Exactly the owned ones. The registry holds three entries; the agent sees one.
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toEqual(['ours.tool']);
    expect(textOf(await page.client.callTool({ name: 'ours.tool', arguments: {} }))).toBe('ours');
  });
});

describe('a tool that was ours and has been withdrawn', () => {
  it('is refused when called from a stale list', async () => {
    const page = await stack();
    const withdraw = await page.register('customers.open', () => 'opened');

    // The agent lists, and holds that list.
    expect((await page.client.listTools()).tools).toHaveLength(1);
    withdraw();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Then calls from it. This is exactly the case absence-from-a-listing does not cover.
    const result = await page.client.callTool({ name: 'customers.open', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.toolNotFound);
  });
});
