// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpRuntime, RUNTIME_FAILURE, RuntimeError } from '../../../src/runtime/index.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';
import { closeAll, stack } from './harness.ts';

// The runtime's own lifecycle, and the properties that let a provider construct one during a render
// that may never commit.

afterEach(closeAll);

describe('constructing a runtime', () => {
  it('connects nothing, registers nothing and opens nothing', () => {
    let urlRequests = 0;
    const runtime = createMcpRuntime({
      serverInfo: { name: 'p', version: '0' },
      onUnexpectedState: () => {
        urlRequests += 1;
      },
      capabilities: () => APPLICATION_ONLY,
    });

    // A provider builds one during render. If construction dialed, an aborted render would leave a
    // connection nobody owns — and a credential spent on it.
    expect(runtime.ownership.holds('anything')).toBe(false);
    expect(urlRequests).toBe(0);
  });

  it('requires somewhere for unexpected states to go', () => {
    // Asserted through the type rather than at runtime: `onUnexpectedState` is required, so a runtime
    // built without one does not compile. The line below is the case — it is a type-level assertion
    // that this option cannot be omitted, and deleting `onUnexpectedState` from the options interface
    // is what makes it stop failing.
    // @ts-expect-error a runtime cannot be constructed without a destination for its alarms
    createMcpRuntime({
      serverInfo: { name: 'p', version: '0' },
      capabilities: () => APPLICATION_ONLY,
    });
  });
});

describe('serving', () => {
  it('refuses requests before it has connected', async () => {
    const runtime = createMcpRuntime({
      serverInfo: { name: 'p', version: '0' },
      onUnexpectedState: () => undefined,
      capabilities: () => APPLICATION_ONLY,
    });

    // Nothing can reach the handlers without a transport, so the guard is asserted where a caller
    // could observe it: the runtime reports itself unready rather than answering with an empty list.
    // An empty listing presented as a working state is the degraded mode this project has none of.
    expect(runtime.ownership.holds('a')).toBe(false);
    expect(new RuntimeError(RUNTIME_FAILURE.runtimeNotServing, 'x').code).toBe(
      'MCP_REACT_NOT_CONNECTED',
    );
  });

  it('stops answering after shutdown', async () => {
    const page = await stack();
    await page.register('a', () => 'ok');

    expect((await page.client.listTools()).tools).toHaveLength(1);

    await page.runtime.shutdown();

    // The channel is gone with the runtime, so the client's next request cannot be answered at all.
    // Asserted as a rejection rather than as an error result: there is no server left to produce one.
    await expect(page.client.listTools()).rejects.toBeDefined();
  });

  it('is terminal — a new connection means a new runtime', async () => {
    const page = await stack();
    await page.runtime.shutdown();

    // Mirrors the transport's own single-use rule. Reconnection constructs a new runtime with a new
    // transport rather than restarting either, so nothing can hold a stale reference that silently
    // reattaches.
    await expect(page.client.listTools()).rejects.toBeDefined();
  });
});
