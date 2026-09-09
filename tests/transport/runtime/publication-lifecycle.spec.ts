// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, stack } from './harness.ts';

// The edges of the publication window: before a connection exists, after it is torn down, and when it
// goes away underneath a notification that is already in flight.
//
// **This suite was planned alongside the change notification and was not written then.** It is here
// now because the
// review that caught its absence was right about why it matters: every case below is about the
// publisher NOT doing something, and "did not send" is also what a broken publisher does. Each one
// therefore checks two things — that nothing was sent, and that nothing was reported either. A
// publisher that silently swallowed every failure would pass the first half and fail the second.

afterEach(closeAll);

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('changes outside the connection', () => {
  it('after shutdown, sends nothing and reports nothing', async () => {
    const page = await stack();
    await page.register('before.one', () => 'ok');
    await settle();

    await page.runtime.shutdown();

    // Registrations keep unwinding after a provider tears down — effect cleanups, aborted
    // controllers. None of it is an anomaly, and reporting it as one would train an operator to
    // ignore the channel that carries the real thing.
    const withdraw = await page
      .register('after.one', () => 'ok')
      .catch(() => (): void => undefined);
    withdraw();
    await settle();

    expect(page.unexpected).toEqual([]);
  });

  it('when the socket drops underneath, reports nothing about the notification it could not send', async () => {
    const page = await stack();
    await page.register('live.one', () => 'ok');
    await settle();

    // The channel goes away without anyone calling `shutdown()` — the ordinary shape of a laptop
    // sleeping or a gateway restarting. `serving` used to go false only in `shutdown()`, so a queued
    // notification still believed it could send and the protocol layer rejected it with
    // "Not connected", surfacing as an alarm from a page that was already gone.
    page.dropSocket();
    await settle();

    await page.register('after.drop', () => 'ok');
    await settle();

    expect(page.unexpected.map((failure) => failure.code)).not.toContain(
      'MCP_TOOL_LIST_NOTIFICATION_FAILED',
    );
  });
});

describe('a send that fails while the runtime genuinely believes it is connected', () => {
  it('IS reported, so the two silences above are not implemented by swallowing everything', async () => {
    const page = await stack();
    await page.register('one.tool', () => 'ok');
    await settle();

    // **The pairing for this whole file.** Both cases above assert that nothing reached the alarm
    // channel. On their own they are equally satisfied by a publisher that reports nothing ever. This
    // breaks the send while the connection is still up, and the alarm must arrive.
    page.breakSending(new Error('the frame could not be written'));
    await page.register('two.tool', () => 'ok');
    await settle();

    expect(page.unexpected.map((failure) => failure.code)).toContain(
      'MCP_TOOL_LIST_NOTIFICATION_FAILED',
    );
    // And it says what an operator needs: that the agent is now working from a stale listing.
    expect(page.unexpected.at(-1)?.message).toContain('listing it last read');
  });
});
