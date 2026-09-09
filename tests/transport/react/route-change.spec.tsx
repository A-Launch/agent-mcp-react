// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// The exposed tool set describes the mounted application, through a route change that moves a SET.
//
// Asserted as set equality through the MCP client, never as a count: a route that swapped two tools for
// two other tools keeps the count identical while exposing entirely the wrong actions.

afterEach(closeAll);

function Dashboard(): null {
  useMcpTool({
    name: 'dashboard.set_period',
    description: 'Set the dashboard period.',
    handler: () => ({ ok: true }),
  });
  useMcpTool({
    name: 'dashboard.change_metric',
    description: 'Change the dashboard metric.',
    handler: () => ({ ok: true }),
  });
  return null;
}

function Customers(): null {
  useMcpTool({
    name: 'customers.set_filters',
    description: 'Filter the customer list.',
    handler: () => ({ ok: true }),
  });
  useMcpTool({
    name: 'customers.select',
    description: 'Select a customer.',
    handler: () => ({ ok: true }),
  });
  return null;
}

function Router(): React.ReactNode {
  const [route, setRoute] = useState<'dashboard' | 'customers'>('dashboard');
  return (
    <>
      <button type="button" data-testid="go" onClick={() => setRoute('customers')}>
        go to customers
      </button>
      {route === 'dashboard' ? <Dashboard /> : <Customers />}
    </>
  );
}

describe('a route change', () => {
  it('moves the exposed set to exactly the mounted set', async () => {
    const page = await stack(<Router />);
    await until(
      async () => (await listedNames(page.client)).length === 2,
      'the first route to register',
    );
    expect((await listedNames(page.client)).sort()).toEqual([
      'dashboard.change_metric',
      'dashboard.set_period',
    ]);

    page.rendered.getByTestId('go').click();

    await until(
      async () => (await listedNames(page.client)).includes('customers.select'),
      'the second route to register',
    );
    // Set equality, not a count — both routes declare two tools, so a count assertion would pass
    // against a page exposing entirely the wrong actions.
    expect((await listedNames(page.client)).sort()).toEqual([
      'customers.select',
      'customers.set_filters',
    ]);
  });

  it('REFUSES every tool of the route that left', async () => {
    const page = await stack(<Router />);
    await until(
      async () => (await listedNames(page.client)).length === 2,
      'the first route to register',
    );

    page.rendered.getByTestId('go').click();
    await until(
      async () => (await listedNames(page.client)).includes('customers.select'),
      'the second route to register',
    );

    // The control the absence is not: an agent holding the previous listing will call these.
    for (const departed of ['dashboard.set_period', 'dashboard.change_metric']) {
      const result = await page.client.callTool({ name: departed, arguments: {} });
      expect(result.isError, `${departed} must be refused after its route left`).toBe(true);
    }
  });

  it('leaves the arriving route tools callable', async () => {
    const page = await stack(<Router />);
    await until(
      async () => (await listedNames(page.client)).length === 2,
      'the first route to register',
    );

    page.rendered.getByTestId('go').click();
    await until(
      async () => (await listedNames(page.client)).includes('customers.select'),
      'the second route to register',
    );

    const result = await page.client.callTool({ name: 'customers.set_filters', arguments: {} });
    expect(result.isError ?? false).toBe(false);
  });

  it('raises no unexpected-state alarm moving between them', async () => {
    const page = await stack(<Router />);
    await until(
      async () => (await listedNames(page.client)).length === 2,
      'the first route to register',
    );
    page.rendered.getByTestId('go').click();
    await until(
      async () => (await listedNames(page.client)).includes('customers.select'),
      'the second route to register',
    );
    await page.client.listTools();

    // A route change that left ownership entries behind would show up here as the library's own
    // bookkeeping raising the alarm that exists to catch a real fault.
    expect(page.unexpected).toEqual([]);
  });
});
