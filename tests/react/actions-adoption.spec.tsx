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

// Tools declared outside React, and the one property that makes them worth having
// (docs/tools-outside-react.md).
//
// **The claim this file exists for is the REMOUNT.** Every steady-state check — it registers, it is
// listed, it can be called — passes whether the queue holds declarations or registrations. The two
// designs differ in exactly one observable place: what happens when the provider goes away and comes
// back. Hold registrations, and a shell-owned tool silently vanishes with no signal to re-register it.
// Hold declarations, and it comes back.
//
// That is what it means to say *"'Static' describes OWNERSHIP, never an exemption from the
// lifecycle"*, and it is why the break-it for this feature is "delete the re-adoption" rather than
// anything about the happy path.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
  resetDeclarationsForTests();
});

afterEach(() => {
  clearRegistry();
  resetDeclarationsForTests();
});

function Host({ children }: { children?: React.ReactNode }): React.ReactNode {
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      {children ?? null}
    </AgentMcpProvider>
  );
}

async function settled(): Promise<void> {
  await act(async () => {
    await until(async () => (await registeredNames()).length > 0, 'waited for registration');
  });
}

describe('a tool declared before any provider exists', () => {
  it('is registered by the provider that eventually mounts', async () => {
    // Declared with no provider anywhere — the module-scope case the registration API exists for.
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });

    expect(handle.registered).toBe(false);
    expect(await registeredNames()).toEqual([]);

    render(<Host />);
    await settled();

    expect(await registeredNames()).toEqual(['session.logout']);
    expect(handle.registered).toBe(true);
  });

  it('SURVIVES the provider unmounting and is re-registered by the next one', async () => {
    // **The case the whole design turns on.** Its owner is the application shell, which did not
    // unmount — so a provider going away withdraws the registration and must not discard the
    // declaration.
    registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });

    const first = render(<Host />);
    await settled();
    expect(await registeredNames()).toEqual(['session.logout']);

    first.unmount();
    await act(async () => {
      await until(async () => (await registeredNames()).length === 0, 'waited for withdrawal');
    });
    expect(await registeredNames()).toEqual([]);

    render(<Host />);
    await settled();

    // Back, with the application having done nothing.
    expect(await registeredNames()).toEqual(['session.logout']);
  });

  it('does NOT come back after remove(), which is what makes remove permanent', async () => {
    // The other half of the previous case. Without it, "survives a remount" could be satisfied by a
    // queue that never forgets anything — and `remove()` would be a temporary measure a remount undoes.
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });

    const first = render(<Host />);
    await settled();

    handle.remove();
    await act(async () => {
      await until(async () => (await registeredNames()).length === 0, 'waited for removal');
    });

    first.unmount();
    render(<Host />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(await registeredNames()).toEqual([]);
    expect(handle.registered).toBe(false);
  });
});

describe('update()', () => {
  it('does nothing at all when the descriptor is unchanged', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });
    render(<Host />);
    await settled();

    const changes = recordChanges();
    changes.reset();

    // Fifty calls with the same descriptor. The design requires that an update to an UNCHANGED
    // descriptor costs nothing; without that, an application calling update() from a store
    // subscription produces a tools/list_changed storm, and the tool
    // stays correct throughout, which is how it would go unnoticed.
    for (let turn = 0; turn < 50; turn += 1) {
      handle.update({ description: 'Logs out the current user.' });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(changes.count()).toBe(0);
    changes.stop();
  });

  it('performs one cycle for a genuine change', async () => {
    const handle = registerMcpTool({
      name: 'session.logout',
      description: 'Logs out the current user.',
      handler: () => ({ loggedOut: true }),
    });
    render(<Host />);
    await settled();

    const changes = recordChanges();
    changes.reset();

    handle.update({ description: 'Ends the current session.' });
    await act(async () => {
      await until(async () => changes.count() > 0, 'waited for the change to land');
    });

    expect(changes.count()).toBeGreaterThan(0);
    expect(await registeredNames()).toEqual(['session.logout']);
    changes.stop();
  });
});
