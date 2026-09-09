import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerMcpTool } from '../../src/actions/index.ts';
import { resetDeclarationsForTests } from '../../src/actions/queue.ts';
import { AgentMcpProvider } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  recordChanges,
  registeredNames,
  testValidator,
  until,
} from './harness.ts';

// **What `update()` must change, and what it must not COST.**
//
// The two are in tension and a first implementation got it wrong by collapsing them. `sameDescriptor`
// compares the fields the REGISTRY carries — name, title, description, inputSchema — because that is
// what decides whether a registry cycle is needed. Three things a caller can update are deliberately
// NOT among them:
//
//   handler       read live, so changing it must cost no cycle at all — exactly as a rerender's does
//   permissions   the registry cannot carry it; it has its own no-churn write path
//   outputSchema  the registry cannot carry it either, but it IS agent-visible through the listing
//
// Using one comparison for all of them meant an update to any of the three was silently discarded:
// the call succeeded, the handle reported registered, and the tool went on doing what it did before.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
  resetDeclarationsForTests();
});

afterEach(() => {
  clearRegistry();
  resetDeclarationsForTests();
});

function Host(): React.ReactNode {
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      {null}
    </AgentMcpProvider>
  );
}

/** Calls through the registry, the way a page script would. */
async function callThroughRegistry(name: string): Promise<{ ok: boolean; text: string }> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('no registry');
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  try {
    const raw = await invoke.call(registry, name, JSON.stringify({}), undefined, true);
    const r = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    return { ok: r.isError !== true, text: (r.content ?? []).map((c) => c.text ?? '').join('') };
  } catch (cause) {
    return { ok: false, text: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function settled(): Promise<void> {
  await act(async () => {
    await until(async () => (await registeredNames()).length > 0, 'waited for registration');
  });
}

describe('update() changes what it says it changes', () => {
  it('replaces the HANDLER, and costs no registry cycle for it', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ from: 'first' }),
    });
    render(<Host />);
    await settled();

    expect((await callThroughRegistry('session.logout')).text).toContain('first');

    const changes = recordChanges();
    changes.reset();

    handle.update({ handler: () => ({ from: 'second' }) });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // The new handler runs...
    expect((await callThroughRegistry('session.logout')).text).toContain('second');
    // ...and it cost nothing, because the registry never carried the handler. A cycle here would be
    // the storm the comparison exists to prevent, arriving from the one field that changes most.
    expect(changes.count()).toBe(0);
    changes.stop();
  });

  it('applies a PERMISSIONS-only change without a registry cycle', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ ok: true }),
      permissions: { available: true },
    });
    render(<Host />);
    await settled();

    const changes = recordChanges();
    changes.reset();

    handle.update({ permissions: { available: false } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // The registry has no opinion about availability, so there is nothing there to update — and
    // routing it through a full cycle would withdraw and re-register a tool on every change to a
    // value that tracks application state.
    expect(changes.count()).toBe(0);
    // But it MUST have taken effect. The tool is still registered for the page...
    expect(await registeredNames()).toEqual(['session.logout']);
    changes.stop();
  });

  it('applies an OUTPUT-SCHEMA-only change, which the registry cannot carry but the agent sees', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      // Returns nothing. Valid under the first schema, which declares `ok` without requiring it.
      handler: () => ({}),
    });
    render(<Host />);
    await settled();

    expect((await callThroughRegistry('session.logout')).ok).toBe(true);

    handle.update({
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    });
    await act(async () => {
      await until(
        async () => (await callThroughRegistry('session.logout')).ok === false,
        'waited for the new output contract to take effect',
      );
    });

    // Now refused against the NEW contract. Discarding this update would leave the tool advertising
    // one output contract while enforcing another.
    expect((await callThroughRegistry('session.logout')).ok).toBe(false);
  });
});
