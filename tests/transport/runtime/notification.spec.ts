// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, type Stack, stack } from './harness.ts';

// Tool-list-change notification, asserted through what a real MCP client actually receives over a
// real socket.
//
// **Every negative case here is paired with a positive one on the same connection**, and that rule is
// the whole reason this file is shaped the way it is. A completely broken delivery path — a
// notification that is never sent at all — passes "no notification arrived" perfectly. The
// testing strategy makes this point (CONTRIBUTING.md#8-testing), and it survives the correction
// recorded below it.
//
// What this file also does is reproduce, permanently, the finding of a spike that was deleted: the
// notification arrives with **no subscription call of any kind**. The specification claims a client
// receives change notifications only over a stream it opens; that is true of the 2026-07-28 protocol
// revision and false of the 2025-era connection this project speaks, where `Client.listen()` refuses
// outright. A case is the only form of that finding that cannot quietly rot.

afterEach(closeAll);

/** Counts `notifications/tools/list_changed` as the CLIENT receives them. */
function countNotifications(page: Stack): { count(): number; reset(): void } {
  let seen = 0;
  // No subscription is opened first, deliberately. That is the assertion.
  page.client.setNotificationHandler('notifications/tools/list_changed', () => {
    seen += 1;
  });
  return {
    count: () => seen,
    reset: () => {
      seen = 0;
    },
  };
}

/**
 * Lets the publication drain reach the client.
 *
 * A registry change is delivered on a microtask, the drain then derives (async) and sends (async), and
 * the frame crosses a real socket. This yields to those turns; it is NOT a tolerance and NOT a
 * duration chosen to make a count pass. Every case below asserts an exact number afterwards, so a
 * mechanism that needed longer would fail rather than flake into passing.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('the protocol era this delivery depends on', () => {
  it('is the legacy era, where notifications are unsolicited', async () => {
    const page = await stack();
    const client = page.client as unknown as {
      getNegotiatedProtocolVersion(): string;
      getProtocolEra(): string;
    };

    // **This case is a tripwire, not a tautology.** Every notification in this file is delivered
    // unsolicited, which is how the 2025 era works. On the 2026-07-28 era a client receives change
    // notifications only over a `subscriptions/listen` stream it opens, and `listen()` refuses on a
    // legacy connection — so the two models are mutually exclusive rather than one being a superset.
    //
    // An SDK upgrade that moved the negotiated version would therefore stop every notification here
    // from arriving, and the symptom would be an agent that quietly works from a stale tool set. This
    // fails first, and names the reason.
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getProtocolEra()).toBe('legacy');
  });
});

describe('an agent is told when the tool set changes', () => {
  it('arrives with no subscription call, and the listing that follows contains the new tool', async () => {
    const page = await stack();
    const notifications = countNotifications(page);

    await page.register('customers.set_filters', () => 'ok');
    await settle();

    expect(notifications.count()).toBe(1);
    // The notification carries no tools — it is a signal to re-list — so the listing is what proves
    // the agent can now see it.
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'customers.set_filters',
    ]);
  });

  it('arrives on a withdrawal, and the listing that follows no longer contains it', async () => {
    const page = await stack();
    const withdraw = await page.register('a.one', () => 'ok');
    await page.register('a.two', () => 'ok');
    await settle();

    const notifications = countNotifications(page);
    withdraw();
    await settle();

    expect(notifications.count()).toBe(1);
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toEqual(['a.two']);
  });

  it('does not fire for a foreign registration, on a connection that is demonstrably delivering', async () => {
    const page = await stack();
    await page.register('ours.one', () => 'ok');
    await settle();

    const notifications = countNotifications(page);

    // Another script's tool, straight into the shared document registry. It changes the REGISTRY, and
    // fires its change event — but our listing is the intersection of the registry with the ownership
    // record, and that has not moved.
    await page.registerForeign('somebody.else');
    await settle();

    expect(notifications.count()).toBe(0);
    expect((await page.client.listTools()).tools.map((tool) => tool.name)).toEqual(['ours.one']);

    // **The pairing that makes the zero above mean something.** Same connection, same handler: a
    // change that DOES affect us still arrives. Without this, a wholly dead delivery path would pass
    // the assertion above and the suite would report the feature working.
    await page.register('ours.two', () => 'ok');
    await settle();
    expect(notifications.count()).toBe(1);
  });
});

describe('the ordering between the registry event and the ownership record', () => {
  it('never notifies about a set the record has not caught up with', async () => {
    // **The hazard this case exists for.** Registration writes to the registry and only THEN records
    // ownership. The registry's change event is therefore queued before the record knows the tool
    // exists — and a derivation running in that window sees a registry entry with no ownership entry,
    // treats it as foreign, and excludes it. The agent would be told to re-list and would find the
    // tool missing.
    //
    // This is a measured contract, not an incidental microtask ordering. If it fails, the fix is the
    // ordering — never a delay here.
    const page = await stack();

    // The listing is requested from INSIDE the notification handler — at the earliest instant an agent
    // could possibly act on being told. Settling first and then listing would prove almost nothing:
    // any ordering, however wrong, looks correct once everything has finished.
    const seenAtNotification: string[][] = [];
    const listings: Array<Promise<unknown>> = [];
    page.client.setNotificationHandler('notifications/tools/list_changed', () => {
      listings.push(
        page.client.listTools().then((result) => {
          seenAtNotification.push(result.tools.map((tool) => tool.name));
        }),
      );
    });

    // **The window is widened on purpose.** With the tools registered normally the two writes land in
    // adjacent microtasks and ANY ordering looks correct — this case passed with `ownership.onChange`
    // deleted, which is exactly the fix it claims to guard. `registerWithLateOwnership` reproduces
    // the measured failure: registry first, ownership 20ms later.
    await page.registerWithLateOwnership('late.one', () => 'ok');
    await settle();
    await Promise.all(listings);

    // Every listing an agent could have made in response to a notification contains the tool. Not
    // "the last one" — the first is the one that would leave it stale.
    expect(seenAtNotification.length).toBeGreaterThan(0);
    for (const names of seenAtNotification) expect(names).toEqual(['late.one']);
  });

  it('leaves the agent with the complete set after the last notification of a burst', async () => {
    const page = await stack();
    const notifications = countNotifications(page);

    // Three registrations issued together, the way a screen mounting three tools does.
    await Promise.all([
      page.register('burst.one', () => 'ok'),
      page.register('burst.two', () => 'ok'),
      page.register('burst.three', () => 'ok'),
    ]);
    await settle();

    // However many notifications that produced, the listing after the last one is complete. That is
    // the property required here, and the one that makes a two-notification transition safe.
    expect(notifications.count()).toBeGreaterThan(0);
    expect((await page.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'burst.one',
      'burst.three',
      'burst.two',
    ]);
  });
});
