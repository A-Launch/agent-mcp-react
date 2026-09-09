// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { currentClaimHolder } from '../../../src/webmcp/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// Unmounting must leave the document as it was found.
//
// Not "mostly": a claim left behind makes the next mount fail as a second provider, and a registration
// left behind is an action an agent can still reach in an application that no longer implements it.

afterEach(closeAll);

function Tool(): null {
  useMcpTool({ name: 'page.action', description: 'while the page lives', handler: () => ({}) });
  return null;
}

async function registryNames(): Promise<string[]> {
  const host = (
    document as unknown as { modelContext?: { getTools(): Promise<{ name: string }[]> } }
  ).modelContext;
  return (await host?.getTools())?.map((tool) => tool.name) ?? [];
}

describe('unmounting the provider', () => {
  it('leaves the document registry holding nothing the mount put there', async () => {
    const page = await stack(<Tool />);
    await until(
      async () => (await listedNames(page.client)).includes('page.action'),
      'the tool to be listed',
    );

    page.rendered.unmount();

    expect(await registryNames()).toEqual([]);
  });

  it('releases the claim, so the document can host a provider again', async () => {
    const page = await stack(<Tool />);
    await until(
      async () => (await listedNames(page.client)).includes('page.action'),
      'the tool to be listed',
    );
    expect(currentClaimHolder()).toBeDefined();

    page.rendered.unmount();

    expect(currentClaimHolder()).toBeUndefined();
  });

  it('stops serving, so the agent sees the channel end rather than a silent server', async () => {
    const page = await stack(<Tool />);
    await until(
      async () => (await listedNames(page.client)).includes('page.action'),
      'the tool to be listed',
    );

    page.rendered.unmount();

    // The distinction that matters: a server that stopped answering without closing leaves every
    // in-flight request of the agent's hanging forever with no error anywhere.
    await expect(page.client.listTools()).rejects.toThrow();
  });
});
