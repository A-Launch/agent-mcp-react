import { render } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  afterMount,
  clearRegistry,
  enterSecureContext,
  neverConnects,
  registeredNames,
} from './harness.ts';

// A tool declared by a component that never commits.
//
// Registration is the only exposure: a tool exists only by registration, and only AFTER commit.
// Registration during
// render would expose an action from a tree the renderer threw away — an agent calling into a
// component that does not exist, with no way for the application to know it was reachable.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

function NeverReady(): null {
  throw new Promise<void>(() => undefined);
}

function Tool(): null {
  useMcpTool({ name: 'suspended.tool', description: 'never committed', handler: () => ({}) });
  return null;
}

describe('a component that declares a tool and never commits', () => {
  it('registers nothing', async () => {
    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'suspending-page', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <Suspense fallback={null}>
          <Tool />
          <NeverReady />
        </Suspense>
      </AgentMcpProvider>,
    );

    await afterMount();

    expect(await registeredNames()).toEqual([]);
  });
});
