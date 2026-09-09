// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, stack } from './harness.ts';

// The first moment this project has a product rather than components: an agent lists a tool the
// application registered, calls it, and the application changes.
//
// jsdom, because the tool registry belongs to the DOCUMENT and there is no registry without one. The
// socket is real regardless — jsdom's WebSocket connects to the real gateway, so nothing here is
// mocked. What jsdom does not give is a browser, and that limit is recorded on the conformance page
// rather than implied away by these cases passing.

afterEach(closeAll);

describe('a full exchange between an agent and a page', () => {
  it('lists a registered tool and calls it, and the application changes', async () => {
    const applied: Array<Record<string, unknown>> = [];
    const page = await stack();
    await page.register('customers.set_filters', (args) => {
      applied.push(args);
      return { applied: true };
    });

    const listed = await page.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['customers.set_filters']);

    const result = await page.client.callTool({
      name: 'customers.set_filters',
      arguments: { country: 'RO' },
    });

    // The assertion that matters is the first one. A handler reporting success while the application
    // never changed is this project's characteristic defect, and it is precisely the thing a
    // return-value assertion gets right.
    expect(applied).toEqual([{ country: 'RO' }]);
    expect(result.isError).toBeFalsy();
  });

  it('gives each of several tools its own handler', async () => {
    const reached: string[] = [];
    const page = await stack();
    for (const name of ['a.one', 'b.two', 'c.three']) {
      await page.register(name, () => {
        reached.push(name);
        return name;
      });
    }

    const listed = await page.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(['a.one', 'b.two', 'c.three']);

    await page.client.callTool({ name: 'b.two', arguments: {} });
    await page.client.callTool({ name: 'c.three', arguments: {} });

    expect(reached).toEqual(['b.two', 'c.three']);
  });

  it('advertises the capability the change notification needs', async () => {
    const page = await stack();

    // Declared at construction because it cannot be added afterwards without rebuilding the server. A
    // capability discovered to be missing at the moment a tool set changes is discovered too late.
    expect(page.client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
  });

  it('answers an empty listing when nothing is registered', async () => {
    const page = await stack();

    // A correct answer, and distinct from the runtime being unready — which refuses instead.
    expect((await page.client.listTools()).tools).toEqual([]);
  });
});

describe('what the agent sees follows the page', () => {
  it('stops listing a tool once it is withdrawn, with nothing told to the runtime', async () => {
    const page = await stack();
    const withdraw = await page.register('customers.open', () => 'opened');

    expect((await page.client.listTools()).tools).toHaveLength(1);

    withdraw();
    // Deliberately nothing here. There is no invalidation to call, no cache to clear and no
    // notification to send — if someone later adds a cache plus a refresh, this case fails because the
    // refresh is not here to be called.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await page.client.listTools()).tools).toEqual([]);
  });

  it('lists a tool registered after the agent already listed once', async () => {
    const page = await stack();
    expect((await page.client.listTools()).tools).toEqual([]);

    await page.register('dashboard.set_period', () => 'set');

    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'dashboard.set_period',
    ]);
  });
});
