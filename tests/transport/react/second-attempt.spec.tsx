// @vitest-environment jsdom

import { type BrowserConnection, type Gateway, startGateway } from '@agent-mcp/mock-agent';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTabId } from '../../../src/index.ts';
import type { UnexpectedStateReport } from '../../../src/react/index.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/websocket.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';
import { declareSecureContext } from './harness.tsx';

// One credential per connection ATTEMPT, and nothing kept between them.
//
// **What an "attempt" means in THIS file, stated so nothing here reads as more than it is.** The
// attempts driven below are produced by one event: a provider mounting. A second attempt is therefore
// an unmount and a remount, which is what a route change or a hot reload does.
//
// That a DROPPED connection takes a fresh credential, and that a backoff schedule never replays a
// spent one under load, are asserted in `reconnect-credentials.spec.tsx`. They are not shown here and
// must not be read into what is.

const KEY = Symbol.for('@agent-mcp/react.page-instance-identity');
const validator = createAjvValidator();

let gateway: Gateway | undefined;
let unexpected: UnexpectedStateReport[] = [];

afterEach(async () => {
  const reported = unexpected;
  try {
    cleanup();
    await gateway?.close();
  } finally {
    gateway = undefined;
    unexpected = [];
    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');
    delete (document as unknown as Record<symbol, unknown>)[KEY];
  }
  expect(reported).toEqual([]);
});

/** Every URL the provider asked for, in order. */
const dialled: string[] = [];

function Page({ mint }: { mint: (tabId: string) => string }): ReactNode {
  const tabId = useMcpTabId();
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{
        getUrl: () => {
          const url = mint(tabId);
          dialled.push(url);
          return url;
        },
      }}
      server={{ name: 'page-under-test', version: '0.0.0' }}
      validation={{ validator }}
      onUnexpectedState={(failure: UnexpectedStateReport) => unexpected.push(failure)}
    >
      {null}
    </AgentMcpProvider>
  );
}

function credentialOf(url: string): string {
  return new URL(url).searchParams.get('ticket') ?? '';
}

describe('a second attempt takes a second credential', () => {
  it('asks the supplier once per attempt, and never reuses what it got', async () => {
    declareSecureContext();
    dialled.length = 0;
    const seen: BrowserConnection[] = [];
    gateway = await startGateway({ onConnection: (connection) => seen.push(connection) });
    const mint = (tabId: string): string => gateway?.mintUrl(tabId) ?? '';

    const first = render(<Page mint={mint} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    first.unmount();

    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');
    render(<Page mint={mint} />);
    await waitFor(() => expect(seen).toHaveLength(2));

    // One ask per attempt, and two DISTINCT credentials. Both halves matter: a supplier called twice
    // that returned the same value would satisfy the count and fail the deployment, because the
    // gateway would refuse the second as spent.
    expect(dialled).toHaveLength(2);
    const [one, two] = dialled.map(credentialOf);
    expect(one).toMatch(/\S/);
    expect(two).not.toBe(one);
  });

  it('leaves nothing minted behind — every credential it took, it used', async () => {
    declareSecureContext();
    dialled.length = 0;
    const seen: BrowserConnection[] = [];
    gateway = await startGateway({ onConnection: (connection) => seen.push(connection) });
    const mint = (tabId: string): string => gateway?.mintUrl(tabId) ?? '';

    const first = render(<Page mint={mint} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    first.unmount();

    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');
    render(<Page mint={mint} />);
    await waitFor(() => expect(seen).toHaveLength(2));

    // Counted at the minter rather than inferred from the URLs. Two issued, two redeemed, none
    // outstanding — so the page did not quietly take a credential it never presented, which is the
    // shape a retry-with-a-fresh-ticket bug leaves behind.
    expect(gateway.minter.outstanding).toBe(0);
  });

  it('refuses to start a transport twice, so a second attempt is structurally a new one', async () => {
    declareSecureContext();
    gateway = await startGateway({ onConnection: () => {} });
    const url = gateway.mintUrl('page-one');

    const transport = createBrowserWebSocketTransport({ getUrl: () => url });
    await transport.start();
    await transport.close();

    // The property that makes "a fresh credential per attempt" enforceable rather than aspirational:
    // there is no way to re-dial an existing transport, so every attempt necessarily runs the supplier
    // again. A restartable transport could reuse a URL it was holding and nothing would catch it.
    await expect(transport.start()).rejects.toThrow();
  });

  it('exposes no readable state at all, so there is no URL on it to leak', async () => {
    declareSecureContext();
    gateway = await startGateway({ onConnection: () => {} });
    const url = gateway.mintUrl('page-one');

    const transport = createBrowserWebSocketTransport({ getUrl: () => url });
    await transport.start();

    // **The obvious spelling of this case is vacuous, and that was measured rather than suspected.**
    // `JSON.stringify(transport)` returns `{}` — the transport's own enumerable properties are three
    // functions and nothing else — so a `not.toContain(credential)` assertion over it passes no matter
    // what the transport holds, including if it held the credential in a field.
    //
    // What discriminates is the structure itself: the only own properties are the three protocol
    // methods, so there is no data property for a URL to sit in. A future change adding `this.url` to
    // keep it "for reconnection" fails here, which is the change this case exists to stop.
    const data = Object.keys(transport).filter(
      (key) => typeof (transport as unknown as Record<string, unknown>)[key] !== 'function',
    );
    expect(data).toEqual([]);
    expect(Object.keys(transport).sort()).toEqual(['close', 'send', 'start']);

    await transport.close();
  });
});
