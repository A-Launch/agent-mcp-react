// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_STATUS, useMcpTool } from '../../../src/react/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// What a recovery must not survive.
//
// A retry loop is a timer, and a timer that outlives the cleanup that owns it dials into a torn-down
// provider — two sockets from one page, which presents as duplicate tool calls rather than as a
// connection error. Development-mode double invocation reaches that on every ordinary mount, and this
// provider already carries one scar of exactly that shape: a flag latched in a cleanup that fires
// during a normal mount, with every test still passing.

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

describe('a page torn down while it is recovering', () => {
  it('opens no further socket', async () => {
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

    // Torn down mid-schedule, which is the window a pending timer lives in.
    page.rendered.unmount();
    const dialsAtTeardown = page.dials();

    // Long enough to cover several intervals of the schedule, which starts at 500 ms. Asserting an
    // absence, so there is nothing to wait FOR — and it is asserted on the dial COUNT, which is
    // monotonic, rather than on a state list a late report could leave looking unchanged.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(page.dials()).toBe(dialsAtTeardown);
  });

  it('reports nothing after teardown, so a late attempt cannot resurrect a corpse', async () => {
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

    page.rendered.unmount();
    const settled = [...page.states];

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(page.states).toEqual(settled);
  });

  it('raises no operational alarm doing any of it', async () => {
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
    await until(() => page.connectionCount() >= 2, 'the gateway to accept a second connection');
    page.rendered.unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // **This is where a forbidden transition would surface**, because the state machine is enforced:
    // a drop, a recovery and a teardown in quick succession is the sequence most likely to publish
    // states out of order, and the provider reports rather than publishes when it does. An empty list
    // is the assertion that the machine agreed with the code through the whole cycle.
    expect(page.unexpected).toEqual([]);
  });
});
