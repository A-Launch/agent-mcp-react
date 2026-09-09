// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECTION_STATUS, useMcpTool } from '../../../src/react/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// **A fresh credential per attempt, across a DROP.**
//
// That a provider mount takes a fresh credential is asserted elsewhere; what needs reconnection to be
// shown at all is that a DROPPED connection produces a new attempt with a fresh credential, and that a
// backoff schedule never replays a spent one under load. Both are here, and both
// are measured at the MINTER rather than inferred from the page — the difference between "two attempts
// happened" and "two credentials were issued and both were used".
//
// The failure this guards only ever appears somewhere expensive: a permissive gateway accepts a
// replayed credential, every local reconnection works, and the first deployment against a real gateway
// fails on the second connection. The dev gateway here is strict on purpose, and must never be relaxed
// to make a case pass.

afterEach(closeAll);

function Panel(): React.ReactNode {
  const [value] = useState('idle');
  useMcpTool({
    name: 'panel.set',
    description: 'Set the panel value.',
    handler: () => ({ value }),
  });
  return <p>{value}</p>;
}

/** Drops the live connection and waits for the gateway to accept the next one. */
async function dropAndRecover(page: Awaited<ReturnType<typeof stack>>): Promise<void> {
  const before = page.connectionCount();
  page.closeFromPeer();
  await until(
    () => page.connectionCount() > before,
    'the gateway to accept the connection after a drop',
  );
}

describe('a reconnection and its credential', () => {
  it('presents one that has never been presented before', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    await dropAndRecover(page);

    const presented = page.credentials();
    expect(presented.length).toBeGreaterThanOrEqual(2);
    // Distinct, not merely "another one". The gateway enforces single use, so a replay would have been
    // refused at the upgrade and there would be no second connection to count — but asserting the
    // values makes the reason visible instead of leaving it to the gateway's strictness.
    expect(new Set(presented).size).toBe(presented.length);
  });

  it('does the same across several drops, not only the first', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    // Three drops. A design that happened to work once — a credential cached and refreshed on the
    // first recovery only — passes a single-drop case and fails the second time a gateway restarts.
    for (let round = 0; round < 3; round += 1) {
      await until(
        () => page.states.lastIndexOf(CONNECTION_STATUS.connected) >= 0,
        'the provider to be connected before the next drop',
      );
      await dropAndRecover(page);
    }

    const presented = page.credentials();
    expect(presented.length).toBeGreaterThanOrEqual(4);
    expect(new Set(presented).size).toBe(presented.length);
  });

  it('leaves none outstanding — every credential it took, it used', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    await dropAndRecover(page);
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );

    // Counted at the minter. A retry that mints and then abandons — cancelled by teardown, or
    // superseded by a newer attempt — leaks one, and that is the shape a fresh-credential bug leaves
    // behind. It is invisible from the page's side, where every attempt still looks like it dialled.
    expect(page.gateway.minter.outstanding).toBe(0);
  });

  it('obtains the credential AFTER the wait, so its age is bounded by one attempt', async () => {
    const page = await stack(<Panel />);
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    const dialsAtDrop = page.dials();
    page.closeFromPeer();

    // Recovering is reported immediately; the credential is not taken until the wait elapses. If the
    // supplier ran at scheduling time instead, a credential would be outstanding during the whole
    // interval — and at the schedule's maximum that interval equals the recommended credential
    // lifetime, so it would be refused as expired at exactly the step a real gateway restart reaches.
    await until(
      () => page.states.includes(CONNECTION_STATUS.reconnecting),
      'the provider to report it recovering',
    );

    // The observable form of "not yet": no further ask of the supplier at the moment recovery begins.
    expect(page.dials()).toBe(dialsAtDrop);

    await until(() => page.dials() > dialsAtDrop, 'the attempt to obtain its credential');
  });
});

describe('the ordering that only shows at the schedule’s maximum', () => {
  it('still presents a live credential when the wait is longer than a credential lives', async () => {
    // **This is the case the whole ordering rule exists for, and the only one that can catch it.**
    //
    // In deployment the numbers are a 30 s backoff maximum against a recommended 30 s credential
    // lifetime, and redemption refuses on `>=` — so the two collide exactly at the cap. Waiting that
    // out is not a test anyone runs, so the same relationship is reproduced in miniature: a credential
    // that lives 300 ms against a first recovery interval of 375-500 ms.
    //
    // Wait-then-fetch: the credential is taken after the wait, so its age at redemption is one dial,
    // and it is accepted. Fetch-then-wait: its age IS the interval, so it is expired on arrival — and
    // expired, spent and "the gateway is down" are one cause to a page, so the symptom would be a
    // reconnection that never works against a gateway that looks dead.
    const page = await stack(<Panel />, { ticketTtlMs: 300 });
    await until(
      () => page.states.includes(CONNECTION_STATUS.connected),
      'the provider to report it connected',
    );

    page.closeFromPeer();
    await until(
      () => page.connectionCount() >= 2,
      'the gateway to accept the recovered connection',
    );

    // Accepted, with a credential that would have been long dead had it been taken before the wait.
    await until(
      () => page.states.lastIndexOf(CONNECTION_STATUS.connected) > 0,
      'the provider to report it connected again',
    );
    expect(page.gateway.minter.outstanding).toBe(0);
  });
});
