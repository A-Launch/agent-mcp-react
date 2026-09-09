// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpTool } from '../../../src/react/index.ts';
import { REGISTRATION_REFUSED } from '../../../src/webmcp/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// **The two refusals that produce no call, and would be invisible without their own events.**
//
// The observability surface names both for that reason (docs/observing-tool-calls.md). A
// reserved-prefix refusal happens at DECLARATION — by the
// time a call arrives the name is already held in a registry shared with every script on the page,
// so there is nothing left to refuse — and an author would otherwise see a tool simply missing from
// `tools/list` with nothing anywhere saying why.
//
// A change made by a foreign script produces no call either, and no notification: it moves the
// document's registry and moves nothing the agent can see. Its first visible sign would be a call
// refused as `foreign`, after the fact and on a different channel.

afterEach(closeAll);

async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

function ReservedName(): ReactNode {
  useMcpTool({
    // `dom.` is reserved for this library's own built-ins. An application may not declare under it,
    // and the refusal is synchronous and first — before a provider is awaited, before a schema
    // compiles, before the registry classifies the name.
    name: 'dom.snapshot',
    description: 'An application trying to take a reserved name.',
    handler: () => ({ ok: true }),
  });
  return null;
}

function OwnTool(): ReactNode {
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

describe('a declaration refused before it became a tool', () => {
  it('produces a registration event naming the tool and the prefix', async () => {
    const page = await stack(<ReservedName />);
    await until(() => page.registrations.length > 0, 'the registration refusal to be reported');

    const event = page.registrations[0];
    expect(event?.name).toBe('dom.snapshot');
    expect(event?.prefix).toBe('dom.');
    expect(event?.code).toBe(REGISTRATION_REFUSED.nameReserved);
  });

  it('leaves the tool absent from what the agent can list', async () => {
    const page = await stack(<ReservedName />);
    await until(() => page.registrations.length > 0, 'the registration refusal to be reported');

    // The event explains an absence that is real. Without the event this is all an author would see.
    expect(await listedNames(page.client)).not.toContain('dom.snapshot');
  });
});

function SecondTool(): ReactNode {
  useMcpTool({
    name: 'panel.later',
    description: 'Declared after the agent was already connected.',
    handler: () => ({ ok: true }),
  });
  return null;
}

describe('a change to the shared registry that the agent cannot see', () => {
  it('is reported, and says the agent-visible set did NOT move', async () => {
    const page = await stack(<OwnTool />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.set'),
      'the application tool to be listed',
    );

    const notificationsBefore = page.notifications();
    const reconciliationsBefore = page.reconciliations.length;

    // A script this library does not own, registering into the same document registry — a widget, an
    // extension, or the application's own unrelated code.
    const registry = (
      document as unknown as {
        modelContext?: { registerTool(declaration: unknown): unknown };
      }
    ).modelContext;
    registry?.registerTool({
      name: 'widget.ping',
      description: 'Registered by another script entirely.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        return { content: [{ type: 'text', text: 'pong' }] };
      },
    });

    await until(
      () => page.reconciliations.length > reconciliationsBefore,
      'the registry change to be reconciled',
    );
    await settle();

    // The flag is the whole meaning of the event. A widget's tool is in the registry and is not in
    // what this library bridges, so the agent-visible set is unchanged.
    expect(page.reconciliations.at(-1)?.agentVisibleMoved).toBe(false);
    // And the agent is told nothing: a change that does not move the agent-visible set sends no
    // notification, and that is NOT re-decided here — the flag
    // is derived from the same determination that drives the notification.
    expect(page.notifications()).toBe(notificationsBefore);
    // The foreign name never enters the agent's listing either.
    expect(await listedNames(page.client)).not.toContain('widget.ping');
  });

  it('says the set DID move when a tool appears AFTER the agent connected', async () => {
    const page = await stack(<OwnTool />);
    await until(
      async () => (await listedNames(page.client)).includes('panel.set'),
      'the first tool to be listed',
    );

    // **Mounted after the connection, and that is the whole reason this case is shaped this way.** A
    // tool declared before the agent connects is already in the listing the agent first reads, so the
    // publisher's baseline contains it and the first reconciliation correctly reports no movement.
    // Asserting `moved` on the initial mount would be asserting something untrue.
    page.setChildren(
      <>
        <OwnTool />
        <SecondTool />
      </>,
    );

    await until(
      () => page.reconciliations.some((event) => event.agentVisibleMoved),
      'a reconciliation that moved the agent-visible set',
    );

    // The positive half, and it is not decoration: a flag that were always `false` would satisfy the
    // foreign-registration case above perfectly while reporting nothing at all.
    const moved = page.reconciliations.find((event) => event.agentVisibleMoved);
    expect(moved?.tools).toContain('panel.later');
  });
});
