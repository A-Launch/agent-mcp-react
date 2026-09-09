// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_STATUS, useMcpTool } from '../../../src/react/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// What happens when the agent goes away, and what deliberately does not.
//
// The state changes to RECOVERING, not to a failure — and the part most likely to be got wrong: no
// registration is withdrawn. A tool belongs to the mounted application, not to the network. Withdrawing
// tools when an agent cannot currently reach them would express availability as absence from a
// registry, which the lifecycle binding prohibits — a registration follows mount and unmount, never
// the connection — and would make the library's own registrations flicker with the network.
//
// **These cases changed subject when reconnection landed, and were corrected rather than weakened.**
// Each asserted a true property of a build with no reconnection — a drop ended in
// the failure state and stayed there. That is no longer true, and the honest replacement is not "assert
// less" but "assert what is now true": a drop is recovered from, and the failure state now belongs to a
// FIRST attempt that never established anything.

afterEach(closeAll);

function Panel(): React.ReactNode {
  const [value, setValue] = useState('unset');
  useMcpTool({
    name: 'panel.set',
    description: 'Set the panel value.',
    handler: (input) => {
      setValue(String(input.value));
      return { value: String(input.value) };
    },
  });
  return <p>{value}</p>;
}

describe('a connection that ends after it was established', () => {
  it('is reported as recovering, and NOT as a failure', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();

    await until(
      () => page.states.includes(CONNECTION_STATUS.reconnecting),
      'the provider to report it recovering',
    );

    // The distinction this feature exists to make. A page that dropped is doing something about it, and
    // a surface told "error" would show a person a dead end while the library is actively working.
    expect(page.states).not.toContain(CONNECTION_STATUS.error);
  });

  it('withdraws no registration, because a tool belongs to the application and not to the network', async () => {
    const page = await stack(<Panel />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.set'),
      'the tool to be listed',
    );

    page.closeFromPeer();
    await until(
      () => page.states.includes(CONNECTION_STATUS.reconnecting),
      'the provider to report it recovering',
    );

    // Read from the document directly: the agent is gone, so there is no listing to ask. The tool is
    // still there, and still invokable by every script in the page — which is what the
    // tool-declaration documentation has to say out loud.
    const host = (
      document as unknown as { modelContext?: { getTools(): Promise<{ name: string }[]> } }
    ).modelContext;
    expect((await host?.getTools())?.map((tool) => tool.name)).toEqual(['panel.set']);
  });

  it('makes a further attempt, which is what a dropped channel now does', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );
    const dialsBeforeDrop = page.dials();

    page.closeFromPeer();

    // **The inversion of what this case used to assert.** It asserted an absence, correctly, of a
    // mechanism that did not exist. Now the presence is the claim — and it is measured on the dial
    // COUNT, which is monotonic, rather than on the state list, which a teardown and redial could
    // reproduce without anything having retried.
    await until(
      () => page.dials() > dialsBeforeDrop,
      'the provider to make a further connection attempt',
    );
  });
});
