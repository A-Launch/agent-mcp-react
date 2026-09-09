import { expect, test } from '@playwright/test';
import { REQUIRED_APIS } from './required-apis.ts';

// The browser APIs the design requires (docs/browser-support.md#what-the-design-asks-for), asserted
// individually in a real page.
//
// **Each one gets its own case**, so a failure names which API is missing and why this library needs
// it — rather than one case that says "an API is missing" and leaves an operator to find out which.
//
// This is the layer where the question means anything. Every other suite runs in jsdom or in Node,
// where `AbortSignal.any` existing says nothing at all about the browser an application runs in.

for (const api of REQUIRED_APIS) {
  test(`the design requires ${api.name}, and it is present`, async ({ page }, testInfo) => {
    await page.goto('/');
    const present = await page.evaluate(api.probe);
    expect(
      present,
      `${api.name} is missing in ${testInfo.project.name}. This library needs it because ${api.because}.`,
    ).toBe(true);
  });
}

test('the page runs in a secure context, which the registry requires', async ({ page }) => {
  // One of the two platform preconditions (docs/browser-support.md#two-platform-preconditions): the
  // registry attribute is defined only in a secure context, and the shim declines to install outside
  // one. `localhost` is a secure context, so this passes in development — the case exists so that a
  // run against a non-local origin over plain HTTP fails HERE, with a cause, rather than as a puzzling
  // registry failure later.
  await page.goto('/');
  expect(await page.evaluate('isSecureContext')).toBe(true);
});

test('records the engine this run actually evidences', async ({ page }, testInfo) => {
  // **The claim this suite is allowed to support is "these engine revisions", and this is what makes
  // the revision part true.** Playwright's `chromium` is not Chrome or Edge, its `webkit` is not
  // Safari, and none of them can be pinned to "current and previous 2" — so the report names exactly
  // what ran, and the browser matrix (docs/browser-support.md#what-that-does-not-evidence) stays a
  // support TARGET rather than a satisfied requirement.
  await page.goto('/');
  const agent = await page.evaluate('navigator.userAgent');
  console.log(`  [${testInfo.project.name}] ${page.context().browser()?.version()} — ${agent}`);
  expect(typeof agent).toBe('string');
});
