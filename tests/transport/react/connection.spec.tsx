// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_STATUS } from '../../../src/react/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// The provider as an addressable MCP server, before any tool exists.
//
// It matters that this is testable on its own: a page with no instrumented actions is still a page an
// agent connects to and enumerates, and the states an application is told about are the same either
// way.

afterEach(closeAll);

describe('a mounted provider', () => {
  it('connects, and a real client completes an exchange with the page', async () => {
    const page = await stack(<p>no tools here</p>);

    // Through the client. The provider's own state is what it BELIEVES; the exchange is what is true.
    const listing = await page.client.listTools();
    expect(listing.tools).toEqual([]);
  });

  it('reports the states it passed through, in order', async () => {
    const page = await stack(<p>no tools here</p>);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    expect(page.states).toEqual([CONNECTION_STATUS.connecting, CONNECTION_STATUS.connected]);
  });

  it('raises no unexpected-state alarm while idle', async () => {
    const page = await stack(<p>no tools here</p>);
    await page.client.listTools();

    expect(page.unexpected).toEqual([]);
  });
});
