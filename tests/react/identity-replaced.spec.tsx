import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  nextTask,
  registeredNames,
  until,
} from './harness.ts';

// A component whose identity is replaced while it is mounted.
//
// This is the observable property a hot reload produces: the dev server swaps the module, and React
// sees a different component type in the same position — so the old tree unmounts and a new one mounts.
// What must never survive is the OLD registration, silently, doing the old thing under a name the new
// module also claims.
//
// **The dev-server trigger itself is not exercised here**, and that is recorded rather than implied
// away: the suite cannot produce a Vite module replacement, so the feature's conformance record lists
// it as an unverified claim resolved by a manual pass or the e2e suite. What is held here is the
// property the trigger produces.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

/** Stands in for a module before it is replaced. */
function OldModule(): null {
  useMcpTool({
    name: 'panel.act',
    description: 'the old implementation',
    handler: () => ({ from: 'old' }),
  });
  return null;
}

/** And after. A different function, which is what a module replacement produces. */
function NewModule(): null {
  useMcpTool({
    name: 'panel.act',
    description: 'the new implementation',
    handler: () => ({ from: 'new' }),
  });
  return null;
}

function mount(children: React.ReactNode) {
  return render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'reloading-page', version: '0.0.0' }}
      onUnexpectedState={() => undefined}
    >
      {children}
    </AgentMcpProvider>,
  );
}

async function describedAs(name: string): Promise<string | undefined> {
  const host = (
    document as unknown as {
      modelContext?: { getTools(): Promise<Array<{ name: string; description: string }>> };
    }
  ).modelContext;
  return (await host?.getTools())?.find((tool) => tool.name === name)?.description;
}

describe('a component replaced by a different component in the same position', () => {
  it('leaves the new registration, never the previous one', async () => {
    const view = mount(<OldModule />);
    await until(
      async () => (await describedAs('panel.act')) === 'the old implementation',
      'the old tool',
    );

    view.rerender(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'reloading-page', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <NewModule />
      </AgentMcpProvider>,
    );

    await until(
      async () => (await describedAs('panel.act')) === 'the new implementation',
      'the replacement to take over the name',
    );
    expect(await registeredNames()).toEqual(['panel.act']);
  });

  it('does not leave the two fighting over the name', async () => {
    const view = mount(<OldModule />);
    await until(
      async () => (await describedAs('panel.act')) === 'the old implementation',
      'the old tool',
    );

    view.rerender(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'reloading-page', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <NewModule />
      </AgentMcpProvider>,
    );
    await until(
      async () => (await describedAs('panel.act')) === 'the new implementation',
      'the replacement to take over the name',
    );
    await nextTask();

    // Exactly one entry, and it is the new one. A withdrawal that arrived after the new registration
    // would leave none at all, which is the other way this goes wrong.
    expect(await registeredNames()).toEqual(['panel.act']);
    expect(await describedAs('panel.act')).toBe('the new implementation');
  });

  it('leaves nothing at all when the replacement declares no tool', async () => {
    const view = mount(<OldModule />);
    await until(
      async () => (await describedAs('panel.act')) === 'the old implementation',
      'the old tool',
    );

    view.rerender(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'reloading-page', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <p>nothing declared here</p>
      </AgentMcpProvider>,
    );
    await nextTask();

    // "The new registration or NONE" — this is the none.
    expect(await registeredNames()).toEqual([]);
  });
});
