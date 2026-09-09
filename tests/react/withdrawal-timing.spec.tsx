import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  registeredNames,
  until,
} from './harness.ts';

// A conformance case against the portability layer: aborting a registration withdraws it immediately,
// with nothing to wait on.
//
// It is a property of the platform rather than of this library, which is why it is held rather than
// assumed: the whole withdrawal mechanism is the abort, because the registry offers no unregister
// operation and returns no handle. If a future version of the layer deferred withdrawal, an unmounted
// component's tool would stay callable for a window nobody designed, and this is where that surfaces
// instead of in a browser.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

function Tool(): null {
  useMcpTool({ name: 'ephemeral.tool', description: 'here and gone', handler: () => ({}) });
  return null;
}

describe('unmounting the component that declared a tool', () => {
  it('withdraws it with nothing left to wait for', async () => {
    const view = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'ephemeral-page', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <Tool />
      </AgentMcpProvider>,
    );

    await until(
      async () => (await registeredNames()).includes('ephemeral.tool'),
      'the tool to register',
    );

    view.unmount();

    // Read immediately: no `until`, no turn yielded, nothing awaited except the registry's own async
    // read. A case that waited here would pass equally against a layer that withdrew a second later.
    expect(await registeredNames()).toEqual([]);
  });
});
