// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, stack } from './harness.ts';

// Divergence: the ownership record holds a name the registry does not.
//
// The contrast with the foreign case next door is the whole point, and the two are deliberately not
// symmetrical:
//
//   - A registry entry we did not record is FOREIGN. Normal. Another script registered it, which is
//     what a shared registry means. Excluded silently — reporting it would fire constantly on any page
//     carrying another script that registers tools.
//   - A record entry the registry does not have is DIVERGED. We believe we registered something that
//     is not there. That is a broken invariant, so it is refused AND reported.
//
// One name — divergence — reads as covering both directions
// (docs/reference-error-vocabulary.md). Only one of them is unexpected, and this
// suite is where that distinction is enforced rather than argued.

afterEach(closeAll);

function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? '').join('');
}

describe('a name the record holds and the registry does not', () => {
  it('is excluded from the listing, and reported', async () => {
    const page = await stack();
    page.recordWithoutRegistering('ghost.tool');

    expect((await page.client.listTools()).tools).toEqual([]);

    // The listing succeeded — for every other tool there was nothing wrong — so there is no error to
    // return. That is exactly why the destination is a construction-time requirement rather than an
    // option: without it this alarm has nowhere to go and defaults to silence.
    expect(page.unexpected.map((failure) => failure.code)).toContain(
      RUNTIME_FAILURE.ownershipDiverged,
    );
    expect(page.unexpected.map((failure) => failure.toolName)).toContain('ghost.tool');
  });

  it('is refused at invocation, and reported there too', async () => {
    const page = await stack();
    page.recordWithoutRegistering('ghost.tool');

    const result = await page.client.callTool({ name: 'ghost.tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.ownershipDiverged);
    expect(page.unexpected.map((failure) => failure.code)).toContain(
      RUNTIME_FAILURE.ownershipDiverged,
    );
  });

  it('never reaches the handler the record holds', async () => {
    const page = await stack();
    let reached = false;
    page.recordWithoutRegistering('ghost.tool', () => {
      reached = true;
      return 'should not happen';
    });

    await page.client.callTool({ name: 'ghost.tool', arguments: {} });

    // The record holds a perfectly good handler. Running it would be the runtime deciding that its own
    // bookkeeping outranks the registry — which is the inversion this whole design exists to prevent.
    expect(reached).toBe(false);
  });

  it('leaves every other tool listable and callable', async () => {
    const page = await stack();
    page.recordWithoutRegistering('ghost.tool');
    await page.register('healthy.tool', () => 'still here');

    // One broken name refuses one call. A runtime that stopped serving because its bookkeeping
    // disagreed about one entry would turn a diagnosable condition into an outage.
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'healthy.tool',
    ]);
    expect(textOf(await page.client.callTool({ name: 'healthy.tool', arguments: {} }))).toBe(
      'still here',
    );
  });
});

describe('the other direction is not divergence', () => {
  it('excludes a foreign registry entry without reporting anything', async () => {
    const page = await stack();
    await page.registerForeign('someone.elses_tool');

    await page.client.listTools();

    // The normal condition of a shared registry. If this were reported, every page carrying another
    // MCP-registering script would raise a continuous alarm and the signal would be worthless.
    expect(page.unexpected).toEqual([]);
  });
});

describe('where a report may go', () => {
  it('never reaches the agent', async () => {
    const page = await stack();
    page.recordWithoutRegistering('ghost.tool');

    const listed = await page.client.listTools();
    const called = await page.client.callTool({ name: 'ghost.tool', arguments: {} });

    // A registry-integrity alarm is the operator's business. The agent is the party the ownership
    // record exists to constrain, and telling it which names this library has lost track of is telling
    // it exactly where the bookkeeping is weak.
    expect(page.unexpected.length).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toContain('ghost.tool');
    // The refusal names the tool the agent itself asked for, which it already knows — and nothing more.
    expect(textOf(called)).toContain('ghost.tool');
    expect(textOf(called)).not.toContain('ownership record holds');
  });
});
