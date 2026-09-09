// @vitest-environment jsdom
import { connectClient } from 'agent-mcp-mock-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_STATUS, useMcpTool } from '../../../src/react/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// **Re-advertising the tool set after a reconnection.**
//
// It belongs to reconnection rather than to the change-notification path, because splitting it would
// have put reconnection policy in two places. What its absence costs is silent: a
// reconnected agent holds the listing it had before the drop, nothing polls — the design forbids it —
// so the
// notification is the entire mechanism by which it can learn, and an agent that is never told calls a
// tool that no longer resolves or never calls one that now exists. Nothing reports a problem either
// way.
//
// The claims here are deliberately separate: that the tools ARE reachable, and that the agent was TOLD.
// A case that only checked the first would pass against a page whose listing is perfect and whose
// agent has no idea.

afterEach(closeAll);

function Fixed(): React.ReactNode {
  useMcpTool({ name: 'panel.set', description: 'Always here.', handler: () => ({ ok: true }) });
  return null;
}

function Added(): React.ReactNode {
  useMcpTool({ name: 'panel.set', description: 'Always here.', handler: () => ({ ok: true }) });
  useMcpTool({ name: 'drawer.open', description: 'Mounted later.', handler: () => ({ ok: true }) });
  return null;
}

describe('what a reconnected agent can reach', () => {
  it('is what the page has mounted NOW, not what it had before the drop', async () => {
    const page = await stack(<Fixed />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();
    await until(
      () => page.states.includes(CONNECTION_STATUS.reconnecting),
      'the provider to report it recovering',
    );

    // The route change happens WHILE the connection is down, which is the case that matters: the agent
    // cannot have learned about it, because there was nothing to learn it over.
    page.setChildren(<Added />);

    await until(
      () => page.connectionCount() >= 2,
      'the gateway to accept the recovered connection',
    );
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );

    const recovered = page.latest();
    if (recovered === undefined) throw new Error('the recovery produced no connection');
    const client = await connectClient(recovered);
    try {
      const listed = (await client.listTools()) as { tools: { name: string }[] };
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(['drawer.open', 'panel.set']);
    } finally {
      await client.close();
    }
  });

  it('survives the drop without a registration being withdrawn', async () => {
    const page = await stack(<Fixed />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );
    const changesBeforeDrop = page.registryChanges();

    page.closeFromPeer();
    await until(
      () => page.connectionCount() >= 2,
      'the gateway to accept the recovered connection',
    );
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );

    // **Counted on registry CHANGE events, never on registrations.** A withdraw-and-register cycle
    // leaves the registration count at one — correct at rest — which is exactly how a churn defect
    // shipped past an earlier feature's suite. A tool belongs to the mounted application; a network
    // event is not a reason to withdraw one, so a recovery must cost zero churn.
    expect(page.registryChanges()).toBe(changesBeforeDrop);
  });

  it('is told when the set changed while it was away, rather than having to ask', async () => {
    const page = await stack(<Fixed />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();
    await until(
      () => page.states.includes(CONNECTION_STATUS.reconnecting),
      'the provider to report it recovering',
    );
    page.setChildren(<Added />);

    await until(
      () => page.connectionCount() >= 2,
      'the gateway to accept the recovered connection',
    );
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );

    const recovered = page.latest();
    if (recovered === undefined) throw new Error('the recovery produced no connection');

    // Counted on the WIRE, from the browser's side — the side that decides to send. "The listing is
    // different when I ask again" is a weaker claim that a polling agent would also satisfy, and
    // nothing polls.
    let told = 0;
    recovered.socket.on('message', (raw: unknown) => {
      if (String(raw).includes('notifications/tools/list_changed')) told += 1;
    });

    const client = await connectClient(recovered);
    try {
      // The agent takes its baseline, exactly as a restarted runtime would, and then must be TOLD
      // about anything after it.
      await client.listTools();
      page.setChildren(<Fixed />);

      await until(() => told > 0, 'the page to tell the reconnected agent the set changed');
    } finally {
      await client.close();
    }
  });

  it('is not told about a change that did not happen', async () => {
    const page = await stack(<Fixed />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();
    await until(
      () => page.connectionCount() >= 2,
      'the gateway to accept the recovered connection',
    );
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );

    const recovered = page.latest();
    if (recovered === undefined) throw new Error('the recovery produced no connection');
    let told = 0;
    recovered.socket.on('message', (raw: unknown) => {
      if (String(raw).includes('notifications/tools/list_changed')) told += 1;
    });

    const client = await connectClient(recovered);
    try {
      await client.listTools();
      // Nothing changed across the drop. A recovery that announced unconditionally would look correct
      // in every case above and would produce a change storm on a flapping gateway.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(told).toBe(0);
    } finally {
      await client.close();
    }
  });
});
