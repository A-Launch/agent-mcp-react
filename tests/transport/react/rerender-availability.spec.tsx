// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// The cost a rerender used to have, expressed as what an AGENT would experience.
//
// The event count in `tests/react/rerender.spec.tsx` says the storm is gone. This says the other half:
// inside each withdraw-and-register cycle there is a window where the tool is not in the registry, and
// a call landing in it is refused. An agent driving a page whose components rerender — which is every
// page — would hit that window at random.

afterEach(closeAll);

function Panel(): React.ReactNode {
  const [count, setCount] = useState(0);
  useMcpTool({
    name: 'panel.bump',
    description: 'Increment the panel counter.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      setCount((value) => value + 1);
      return { count };
    },
  });
  return <p data-testid="count">{count}</p>;
}

describe('an agent calling a tool whose component keeps rerendering', () => {
  it('is never refused', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );

    // Each call rerenders the panel, so the next call arrives after a rerender. Twenty of them.
    const refusals: unknown[] = [];
    for (let call = 0; call < 20; call += 1) {
      const result = await page.client.callTool({ name: 'panel.bump', arguments: {} });
      if (result.isError === true) refusals.push(result.content);
    }

    expect(refusals).toEqual([]);
  });

  it('sees the tool in every listing taken between calls', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );

    for (let call = 0; call < 10; call += 1) {
      await page.client.callTool({ name: 'panel.bump', arguments: {} });
      expect(await listedNames(page.client)).toEqual(['panel.bump']);
    }
  });

  it('raises no unexpected-state alarm across all of it', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.bump'),
      'the tool to be listed',
    );
    for (let call = 0; call < 10; call += 1) {
      await page.client.callTool({ name: 'panel.bump', arguments: {} });
    }

    expect(page.unexpected).toEqual([]);
  });
});
