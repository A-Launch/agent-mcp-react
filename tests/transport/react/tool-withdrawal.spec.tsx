// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// The exposed tool set describes the mounted application — and, crucially, what happens when it does
// not any more.
//
// Absence from a listing is NOT the control. An agent holding a listing it fetched a moment ago will
// call a tool that has since gone, and a client that ignores change notifications will do it
// repeatedly. So the assertion here is the refusal at invocation, with the absence checked alongside
// it rather than instead of it.

afterEach(closeAll);

function Screen(): React.ReactNode {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setVisible(false)} data-testid="leave">
        leave
      </button>
      {visible ? <Tool /> : null}
    </>
  );
}

function Tool(): null {
  useMcpTool({
    name: 'screen.action',
    description: 'An action that exists only while its screen is mounted.',
    handler: () => ({ ok: true }),
  });
  return null;
}

describe('a tool whose declaring component unmounted', () => {
  it('is gone from what the agent lists', async () => {
    const page = await stack(<Screen />);
    await until(
      async () => (await listedNames(page.client)).includes('screen.action'),
      'the tool to be listed',
    );

    page.rendered.getByTestId('leave').click();

    await until(
      async () => (await listedNames(page.client)).length === 0,
      'the tool to leave the listing',
    );
  });

  it('is REFUSED when called, which is the control the absence is not', async () => {
    const page = await stack(<Screen />);
    await until(
      async () => (await listedNames(page.client)).includes('screen.action'),
      'the tool to be listed',
    );

    page.rendered.getByTestId('leave').click();
    await until(
      async () => (await listedNames(page.client)).length === 0,
      'the tool to leave the listing',
    );

    const result = await page.client.callTool({ name: 'screen.action', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('leaves no ownership entry behind, so no divergence is reported', async () => {
    const page = await stack(<Screen />);
    await until(
      async () => (await listedNames(page.client)).includes('screen.action'),
      'the tool to be listed',
    );

    page.rendered.getByTestId('leave').click();
    await until(
      async () => (await listedNames(page.client)).length === 0,
      'the tool to leave the listing',
    );
    await page.client.listTools();

    // A record entry outliving its registration is a divergence this library manufactured itself. The
    // runtime would report it correctly, which is exactly what makes it dangerous: an alarm that
    // fires for the library's own bookkeeping is an alarm an operator learns to ignore.
    expect(page.unexpected).toEqual([]);
  });
});
