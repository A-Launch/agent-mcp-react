// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// A tool whose NAME changes is two names, and the old one must be gone in both senses.
//
// Absence from the listing is not the control. An agent holding a listing from a moment ago will call
// the old name, and a client that ignores change notifications will keep doing it — which is exactly
// the case a refusal exists for.

afterEach(closeAll);

function Tool({ renamed }: { renamed: boolean }): null {
  useMcpTool({
    name: renamed ? 'panel.after' : 'panel.before',
    description: 'The tool that gets renamed.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ renamed }),
  });
  return null;
}

/**
 * Renames the tool, then removes it — without unmounting the provider.
 *
 * The removal has to come from inside the tree: unmounting the rendered result would take the provider
 * with it, shut the runtime down and close the channel, so there would be no agent left to ask.
 */
function Renaming(): React.ReactNode {
  const [state, setState] = useState<'before' | 'after' | 'gone'>('before');
  return (
    <>
      <button type="button" data-testid="rename" onClick={() => setState('after')}>
        rename
      </button>
      <button type="button" data-testid="remove" onClick={() => setState('gone')}>
        remove
      </button>
      {state === 'gone' ? null : <Tool renamed={state === 'after'} />}
    </>
  );
}

describe('a tool whose name changes', () => {
  it('leaves only the new name listed', async () => {
    const page = await stack(<Renaming />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.before'),
      'the original name to be listed',
    );

    page.rendered.getByTestId('rename').click();

    await until(
      async () => (await listedNames(page.client)).includes('panel.after'),
      'the new name to be listed',
    );
    expect(await listedNames(page.client)).toEqual(['panel.after']);
  });

  it('REFUSES the old name at invocation, which the absence is not', async () => {
    const page = await stack(<Renaming />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.before'),
      'the original name to be listed',
    );

    page.rendered.getByTestId('rename').click();
    await until(
      async () => (await listedNames(page.client)).includes('panel.after'),
      'the new name to be listed',
    );

    const stale = await page.client.callTool({ name: 'panel.before', arguments: {} });
    expect(stale.isError).toBe(true);
  });

  it('leaves the new name callable, and reaching the current handler', async () => {
    const page = await stack(<Renaming />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.before'),
      'the original name to be listed',
    );

    page.rendered.getByTestId('rename').click();
    await until(
      async () => (await listedNames(page.client)).includes('panel.after'),
      'the new name to be listed',
    );

    const result = await page.client.callTool({ name: 'panel.after', arguments: {} });
    expect(result.isError ?? false).toBe(false);
    // The handler sees the render that renamed it, not the one that registered the old name. Parsed
    // rather than string-matched: the result is JSON inside a text block, so a literal match would be
    // asserting against the escaping.
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '{}';
    expect(JSON.parse(text)).toEqual({ renamed: true });
  });

  it('leaves no ownership entry behind for the old name', async () => {
    const page = await stack(<Renaming />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.before'),
      'the original name to be listed',
    );
    page.rendered.getByTestId('rename').click();
    await until(
      async () => (await listedNames(page.client)).includes('panel.after'),
      'the new name to be listed',
    );
    await page.client.listTools();

    // A record entry for a withdrawn name is a divergence this library manufactured itself.
    expect(page.unexpected).toEqual([]);
  });
});

describe('after a rename, the REPLACEMENT registration cleans up after itself', () => {
  // The gap the break-it run found. The original registration's own abort listener removes the old
  // name, so a rename alone passes whether or not the replacement attaches one of its own. What
  // exercises the replacement's cleanup is what happens to the NEW name afterwards.

  it('withdraws the new name on unmount, and refuses it', async () => {
    const page = await stack(<Renaming />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.before'),
      'the original name to be listed',
    );
    page.rendered.getByTestId('rename').click();
    await until(
      async () => (await listedNames(page.client)).includes('panel.after'),
      'the new name to be listed',
    );

    page.rendered.getByTestId('remove').click();
    await until(async () => (await listedNames(page.client)).length === 0, 'the tool to leave');

    const result = await page.client.callTool({ name: 'panel.after', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('leaves no ownership entry for the new name either', async () => {
    const page = await stack(<Renaming />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.before'),
      'the original name to be listed',
    );
    page.rendered.getByTestId('rename').click();
    await until(
      async () => (await listedNames(page.client)).includes('panel.after'),
      'the new name to be listed',
    );

    // The tool leaves and the provider keeps serving, so the runtime is still there to notice a record
    // entry the registry does not back.
    page.rendered.getByTestId('remove').click();
    await until(async () => (await listedNames(page.client)).length === 0, 'the tool to leave');
    await page.client.listTools();

    expect(page.unexpected).toEqual([]);
  });
});
