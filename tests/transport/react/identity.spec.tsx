// @vitest-environment jsdom

import {
  type BrowserConnection,
  connectClient,
  type Gateway,
  startGateway,
} from '@agent-mcp/mock-agent';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentCapabilities,
  AgentMcpProvider,
  useMcpTabId,
  useMcpTool,
} from '../../../src/index.ts';
import type { UnexpectedStateReport } from '../../../src/react/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY, NOTHING_GRANTED } from '../../support/capabilities.ts';
import { declareSecureContext } from './harness.tsx';

// The page instance's identity, end to end: minted in the browser, appended by the application,
// received by a real gateway over a real socket.
//
// **What "a second page instance" means here.** A real one is a second document, and this environment
// has one. So a second instance is simulated by removing the identity marker from the document — which
// is exactly the state a fresh document is in, and is how the module's own suite does it. What is NOT
// simulated is anything on the path being asserted: the mint, the URL, the socket, the gateway and the
// ids it records are all real. The two-real-browser-pages version of this claim is the live run, and
// this case does not replace it.
//
// The identity is document-scoped, so two providers in one document would share one — which is correct
// (one provider per document, docs/design.md#the-provider) and is why the second instance is
// sequential rather than
// concurrent.

const KEY = Symbol.for('@agent-mcp/react.page-instance-identity');
const validator = createAjvValidator();

/** Puts the document back in the state a fresh page instance starts in. */
function newPageInstance(): void {
  delete (document as unknown as Record<symbol, unknown>)[KEY];
}

const toClose: Array<() => Promise<void> | void> = [];

/**
 * Everything that reached the provider's operational channel.
 *
 * Collected and asserted empty rather than discarded into a no-op. The prop is required, so the
 * cheapest way to satisfy the type is to ignore what it reports — and a case that ignored it would
 * pass while the page was loudly complaining that something was wrong.
 */
let unexpected: UnexpectedStateReport[] = [];

afterEach(async () => {
  // **Teardown first, assertion after, and the ordering is the fix rather than a style choice.** An
  // `expect` before the cleanup throws on the first case that reports anything — skipping the unmount,
  // the gateway close and the registry reset, so one real failure leaves mounted providers and open
  // sockets to cascade into every case after it. And clearing the collector before the unmount would
  // hand any report emitted DURING teardown to the next case, and lose the last one entirely.
  const reported = unexpected;
  try {
    cleanup();
    for (const close of toClose.splice(0)) await close();
  } finally {
    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');
    newPageInstance();
    unexpected = [];
  }
  expect(reported).toEqual([]);
});

/**
 * Mounts a provider whose URL supplier appends the identity the way an application's does.
 *
 * Deliberately not the shared harness: that one dials with a fixed `tab-1`, which is the very thing
 * under test here.
 */
function PageUnderTest({
  gateway,
  capabilities = APPLICATION_ONLY,
  children = null,
}: {
  gateway: Gateway;
  capabilities?: AgentCapabilities;
  children?: ReactNode;
}): ReactNode {
  const tabId = useMcpTabId();
  return (
    <AgentMcpProvider
      capabilities={capabilities}
      connection={{ getUrl: () => gateway.mintUrl(tabId) }}
      server={{ name: 'page-under-test', version: '0.0.0' }}
      validation={{ validator }}
      onUnexpectedState={(failure: UnexpectedStateReport) => unexpected.push(failure)}
    >
      {children}
    </AgentMcpProvider>
  );
}

/** One ordinary Level 1 tool, declared by the component that owns it. */
function Invoicing(): ReactNode {
  useMcpTool({
    name: 'invoice.send',
    description: 'Send the open invoice.',
    handler: () => ({ sent: true }),
  });
  return null;
}

async function openGateway(seen: BrowserConnection[]): Promise<Gateway> {
  const gateway = await startGateway({
    onConnection: (connection) => {
      seen.push(connection);
    },
  });
  toClose.push(() => gateway.close());
  return gateway;
}

describe('the identity a page mints is the identity the agent receives', () => {
  it('reaches the gateway on a real connection', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(1));

    // The end-to-end binding, and the part that cannot be faked: what the gateway recorded is what the
    // page minted. A case that only checked the gateway saw *something* would pass against a page
    // sending a constant.
    const received = seen[0]?.tabId;
    expect(received).toMatch(/\S/);
    expect(received).toBe(
      (document as unknown as Record<symbol, { id: string } | undefined>)[KEY]?.id,
    );
  });

  it('gives two page instances two identities, so an agent can address either', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    const first = render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    first.unmount();

    // A fresh page instance — a second window, or a tab restored from a previous session.
    newPageInstance();
    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');

    render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(2));

    // **This is the case that would have caught the collision found on 2026-08-25.** Two copies of the
    // demonstrator both dialled as `dashboard`, and a request naming that id was answered by whichever
    // connected first — a wrong answer that looked entirely normal.
    expect(seen[1]?.tabId).not.toBe(seen[0]?.tabId);
    expect(seen[0]?.tabId).toMatch(/\S/);
    expect(seen[1]?.tabId).toMatch(/\S/);
  });

  it('keeps ONE identity across a remount of the same page instance', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    const first = render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    first.unmount();

    // No `newPageInstance()` here — the document is the same, so the page instance is the same. Only
    // the provider was torn down and rebuilt, which is what a route change or a hot reload does.
    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');

    render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(2));

    // The mirror of the case above, and it is what makes that one meaningful: if every remount minted
    // a new identity, "two instances differ" would pass for the wrong reason.
    expect(seen[1]?.tabId).toBe(seen[0]?.tabId);
  });

  it('takes a fresh credential on the second attempt, and the identity is not one', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    const first = render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    first.unmount();

    resetResolutionForTests();
    Reflect.deleteProperty(document as object, 'modelContext');
    render(<PageUnderTest gateway={gateway} />);

    // Both attempts were accepted. The gateway enforces single use, so a second attempt reusing the
    // first credential would have been refused as spent and never appear here — while the identity,
    // which IS reused, changes nothing about admission. That pairing is the point: one of the two
    // values is a credential and the other is metadata, and they behave differently.
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]?.tabId).toBe(seen[0]?.tabId);
  });
});

describe('an identity is metadata, and confers nothing', () => {
  it('does not admit a call — the granted capabilities do, and they alone', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    render(
      <PageUnderTest gateway={gateway}>
        <Invoicing />
      </PageUnderTest>,
    );
    await waitFor(() => expect(seen).toHaveLength(1));

    const connection = seen[0];
    if (connection === undefined) throw new Error('the page never connected');
    // The connection carried an identity. Everything below is about a connection that HAS one, which
    // is the only version of this claim worth making.
    expect(connection.tabId).toMatch(/\S/);

    const client = await connectClient(connection);
    toClose.push(() => client.close());

    const granted = (await client.callTool({ name: 'invoice.send', arguments: {} })) as {
      isError?: boolean;
    };
    expect(granted.isError).toBeUndefined();
  });

  it('leaves a call refused when the capabilities are withheld, however well known it is', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    render(
      <PageUnderTest gateway={gateway} capabilities={NOTHING_GRANTED}>
        <Invoicing />
      </PageUnderTest>,
    );
    await waitFor(() => expect(seen).toHaveLength(1));

    const connection = seen[0];
    if (connection === undefined) throw new Error('the page never connected');
    expect(connection.tabId).toMatch(/\S/);

    const client = await connectClient(connection);
    toClose.push(() => client.close());

    // Same page, same kind of identity, same tool — refused. An identity that admitted anything would
    // make this pass, and the failure would be silent and in the direction that grants access.
    const refused = (await client.callTool({ name: 'invoice.send', arguments: {} })) as {
      isError?: boolean;
    };
    expect(refused.isError).toBe(true);
  });

  it('is refused at the upgrade when it arrives without a credential', async () => {
    declareSecureContext();
    newPageInstance();
    const seen: BrowserConnection[] = [];
    const gateway = await openGateway(seen);

    // A MINTED identity rather than a literal, which is the version of this claim 011 owes: the
    // gateway already refuses `?tabId=something`, and what matters now is that a real identity — the
    // kind a page actually presents — buys nothing either.
    const identity = document as unknown as Record<symbol, { id: string } | undefined>;
    render(<PageUnderTest gateway={gateway} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    const minted = identity[KEY]?.id;
    expect(minted).toMatch(/\S/);

    const dial = async (mutate: (url: URL) => void): Promise<string> => {
      const url = new URL(gateway.mintUrl(minted));
      mutate(url);
      return new Promise<string>((resolve) => {
        const socket = new WebSocket(url.toString());
        socket.addEventListener('open', () => {
          socket.close();
          resolve('opened');
        });
        socket.addEventListener('error', () => resolve('refused'));
        socket.addEventListener('close', () => resolve('refused'));
      });
    };

    // **The contrast is the case.** Without it, a typo in the URL would produce "refused" and this
    // would read as proof that the identity bought nothing — when in fact nothing had been tested.
    // The same identity, the same gateway, one difference: the credential.
    expect(await dial(() => {})).toBe('opened');

    // Refused at the upgrade, before the handshake completes — so nothing was ever sent to an
    // unauthenticated peer, and the identity did not stand in for the credential it lacks.
    expect(await dial((url) => url.searchParams.delete('ticket'))).toBe('refused');
  });
});
