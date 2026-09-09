import { expect, test } from '@playwright/test';

// **A case that needs the real example application and a real engine.** A socket closed by the peer
// must produce the closure semantics the reconnection policy assumes — the one thing jsdom cannot
// evidence, because its socket is not a socket.

test('a socket closed by the peer is noticed, and the page recovers on its own', async ({
  page,
}) => {
  // **Sockets are collected by patching the constructor BEFORE the page loads**, not by the library
  // exposing one. That is deliberate in both directions: the library deliberately exposes no socket
  // reference (a seam case enforces that `WebSocket` is named only in `src/transport/`), and a test
  // that reached into an internal would be asserting against a surface no embedder has.
  //
  // Any script on the page could do exactly this, which is the point — it is the page's own platform.
  // **Sockets are collected by patching the constructor BEFORE the page loads**, not by the library
  // exposing one. That is deliberate in both directions: the library deliberately exposes no socket
  // reference (a seam case enforces that `WebSocket` is named only in `src/transport/`), and a test
  // that reached into an internal would be asserting against a surface no embedder has.
  //
  // Any script on the page could do exactly this, which is the point — it is the page's own platform.
  await page.addInitScript(() => {
    const Native = globalThis.WebSocket;
    const held: WebSocket[] = [];
    (globalThis as { __openSockets?: WebSocket[] }).__openSockets = held;
    class Recorded extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        held.push(this);
      }
    }
    globalThis.WebSocket = Recorded as unknown as typeof WebSocket;
  });

  await page.goto('/');
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });

  /**
   * How many sockets this page has opened TO THE AGENT GATEWAY.
   *
   * **The filter is the whole correctness of this case, and it was found by measuring.** The page
   * opens TWO sockets in development: the library's, to the gateway, and the dev server's own
   * hot-reload channel. Closing both made the dev server RELOAD THE PAGE — so the tab went away and
   * came back looking exactly like a recovery, while the library's reconnection had done nothing at
   * all. The first version of this case would have passed on a page reload.
   *
   * The gateway is identified by port rather than by asking the library, because the library exposes
   * no socket and this case must not be the reason it starts to.
   */
  const gatewaySockets = () =>
    page.evaluate(
      () =>
        ((globalThis as { __openSockets?: WebSocket[] }).__openSockets ?? []).filter((socket) =>
          socket.url.includes(':45000'),
        ).length,
    );

  const opened = await gatewaySockets();
  // The vacancy guard: with no gateway socket recorded, everything below would pass against a page
  // that never connected at all.
  expect(opened, 'the page opened a socket to the agent gateway').toBeGreaterThan(0);

  // Closed from inside the page rather than by stopping the gateway, so the gateway stays up and the
  // recovery has something to reconnect TO. Stopping the server would test a dead port, which is a
  // different question with a different answer.
  await page.evaluate(() => {
    for (const socket of (globalThis as { __openSockets?: WebSocket[] }).__openSockets ?? []) {
      if (socket.url.includes(':45000')) socket.close();
    }
  });

  // It must LEAVE connected first — otherwise the recovery assertion could pass without anything
  // having happened.
  await expect(page.getByTestId('connection').locator('strong')).not.toHaveText('connected', {
    timeout: 10_000,
  });

  // ...and come back WITHOUT a reload, which is what "reconnects" means.
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 30_000,
  });

  // A SECOND gateway socket exists, so recovery built a new one rather than reviving the old. That is
  // what makes a fresh credential per attempt structural
  // (docs/connection-lifecycle.md#a-fresh-credential-per-attempt-structurally): a new transport
  // necessarily runs the URL supplier again, so no credential can be reused across attempts.
  const afterRecovery = await gatewaySockets();
  expect(
    afterRecovery,
    'recovery opened a new socket rather than reusing the closed one',
  ).toBeGreaterThan(opened);
});
