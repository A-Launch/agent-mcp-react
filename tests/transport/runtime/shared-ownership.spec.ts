// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnershipRecord } from '../../../src/runtime/index.ts';
import { closeAll, stack } from './harness.ts';

// A runtime serving from a record it does not own.
//
// **Why this matters beyond the parameter existing.** A reconnection builds a NEW runtime, because one
// runtime measurably cannot serve a second connection: the second `connect()` resolves and the next
// `initialize` fails. So the record has to outlive the runtime, or every recovery would leave the
// application's tools foreign to the connection that just came back — present in the document, absent
// from the agent's listing, refused at the bridge.
//
// Two properties are asserted here, and the second is the one that would rot quietly: a runtime reads
// what the supplied record holds, and a runtime that has shut down stops listening to it. Without the
// second, every reconnect would leave one more listener publishing into a socket that is gone, and the
// symptom would be an agent receiving change notifications from connections that no longer exist.

afterEach(closeAll);

describe('a runtime serving from a record it was given', () => {
  it('lists what the record already held before it was built', async () => {
    const shared = createOwnershipRecord();
    const under = await stack({ ownership: shared });

    // Registered through the record directly, the way a provider's gateway does — and BEFORE anything
    // asks the runtime for a listing.
    await under.register('invoice.send', () => 'sent');

    const listed = await under.client.listTools();
    expect((listed as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toContain(
      'invoice.send',
    );
  });

  it('leaves the record and its entries alone when it shuts down', async () => {
    const shared = createOwnershipRecord();
    const under = await stack({ ownership: shared });
    await under.register('invoice.send', () => 'sent');

    await under.runtime.shutdown();

    // The runtime is terminal; the record is not. This is what lets a reconnection keep the
    // application's tools — the alternative is a recovery that reconnects to an empty page.
    expect(shared.holds('invoice.send')).toBe(true);
  });

  it('stops listening to it once it has shut down', async () => {
    const shared = createOwnershipRecord();
    const under = await stack({ ownership: shared });
    await under.register('invoice.send', () => 'sent');
    await under.runtime.shutdown();

    // A change after shutdown. A runtime still subscribed would react to this — and since its socket is
    // gone, the reaction is at best wasted and at worst an error on a dead channel. One reconnect would
    // leave one such listener; a flapping gateway would leave dozens.
    expect(() => {
      shared.remove('invoice.send');
    }).not.toThrow();
    expect(shared.holds('invoice.send')).toBe(false);
    expect(under.unexpected).toEqual([]);
  });
});
