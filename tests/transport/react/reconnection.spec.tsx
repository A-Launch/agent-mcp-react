// @vitest-environment jsdom
import { connectClient } from 'agent-mcp-mock-agent';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_STATUS, useMcpTool } from '../../../src/react/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// A dropped connection coming back on its own, and being useful when it does.
//
// **The claim that matters is "and being useful".** A recovery that reconnects the socket and leaves
// the agent unable to reach anything is the characteristic defect of this feature: every state looks
// right, the gateway records a connection, and every call fails. So these cases attach a client to the
// connection the RECOVERY produced and drive a real call through it — never through the library's own
// record, which would agree with a broken listing.
//
// A new runtime is built per connection, because one runtime measurably cannot serve two. What makes
// the tools still reachable afterwards is that the ownership record is the PROVIDER's and outlives the
// runtime — so this is also the case that would catch that lifetime being put back where it was.

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

describe('a connection that dropped', () => {
  it('is established again without anything being remounted', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();

    // Measured on the gateway's own count of accepted connections. Monotonic, so unlike a state list it
    // cannot be satisfied by a teardown and redial that finished before the comparison ran.
    await until(() => page.connectionCount() >= 2, 'the gateway to accept a second connection');
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );
  });

  it('reports recovering with a rising attempt number, and never a failure', async () => {
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

    // A recovery is not a failure. A surface told "error" would show a person a dead end while the
    // library is actively working, which is the display this member exists to replace.
    expect(page.states).not.toContain(CONNECTION_STATUS.error);
  });

  it('serves a real tool call over the connection the recovery produced', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();
    await until(() => page.connectionCount() >= 2, 'the gateway to accept a second connection');
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );

    // A NEW client on the NEW connection, which is what a restarted agent runtime would be. The
    // harness's original client is attached to a socket that is gone.
    const recovered = page.latest();
    if (recovered === undefined) throw new Error('the recovery produced no connection');
    const client = await connectClient(recovered);

    try {
      const listed = (await client.listTools()) as { tools: { name: string }[] };
      // The tools the application had mounted all along. A runtime that brought its own empty record
      // would list nothing here while every state still read as connected.
      expect(listed.tools.map((tool) => tool.name)).toContain('panel.set');

      const result = (await client.callTool({
        name: 'panel.set',
        arguments: { value: 'after the drop' },
      })) as { isError?: boolean };
      expect(result.isError).toBeUndefined();

      // And the observable consequence, not only the return value. A handler that reported success
      // while the page never changed is this system's characteristic defect.
      await until(
        () => page.rendered.container.textContent === 'after the drop',
        'the page to show what the recovered agent set',
      );
    } finally {
      await client.close();
    }
  });

  it('takes a credential of its own for the second connection', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );
    const dialsBeforeDrop = page.dials();

    page.closeFromPeer();
    await until(() => page.connectionCount() >= 2, 'the gateway to accept a second connection');

    // One further ask of the supplier, which mints a fresh credential per call. The gateway enforces
    // single use, so a recovery that replayed the first credential would have been refused at the
    // upgrade and there would be no second connection to count.
    expect(page.dials()).toBeGreaterThan(dialsBeforeDrop);
  });
});
