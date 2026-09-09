import { expect, test } from '@playwright/test';

// What only a real browser can catch: that this library loads, resolves a tool registry, dials a real
// socket, and publishes a tool an agent can see — in an engine that is not jsdom.
//
// **Four `test.fixme`s stood here until every other layer was real**, which meant `pnpm test:e2e`
// was the one test layer of five that executed nothing. They are replaced rather than deleted: each
// of the four questions they named is answered by a case in this directory.
//
// One of them is renamed rather than answered as written. "The published bundle loads in a real
// browser" cannot be asserted against a dev server, which serves source rather than a published
// bundle — so what this asserts is the application loading and connecting through the dev server,
// which is the same code path minus the packaging. The residual gap is recorded in
// `docs/browser-support.md` rather than covered by a case that would have to be skipped forever.
//
// This suite starts nothing. The example application and the mock agent are started by the operator,
// so a broken start command fails the run instead of hiding inside it.

test('the library loads and the provider reaches connected', async ({ page }) => {
  await page.goto('/');
  // The application's own connection indicator, which reads the provider's published state. Asserting
  // through what the PAGE shows rather than through an internal, so this cannot pass against a
  // library that connected and told nobody.
  await expect(page.getByText('agent connection:')).toBeVisible();
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });
});

test('the document has a tool registry, and this library’s tools are in it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });

  const registry = await page.evaluate(async () => {
    const host = (globalThis as { document?: { modelContext?: unknown } }).document?.modelContext as
      | { getTools?: () => Promise<{ name: string }[]> }
      | undefined;
    if (host?.getTools === undefined) return { available: false, names: [] as string[] };
    return { available: true, names: (await host.getTools()).map((tool) => tool.name) };
  });

  expect(registry.available, 'the document exposes a tool registry').toBe(true);
  expect(registry.names.some((name) => name.startsWith('customers.'))).toBe(true);
});

test('no Level 2 or Level 3 tool is in the page’s shared registry', async ({ page }) => {
  // Security invariant 16 (docs/design.md#security-invariants) — no Level 2 or Level 3 tool ever
  // enters the document's shared registry, in any configuration — in a real browser, in whatever
  // profile the operator started. Anything in that registry is callable by every script on the page
  // with none of this library's gates in the path.
  await page.goto('/');
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });

  const names = await page.evaluate(async () => {
    const host = (globalThis as { document?: { modelContext?: unknown } }).document?.modelContext as
      | { getTools?: () => Promise<{ name: string }[]> }
      | undefined;
    return host?.getTools === undefined ? [] : (await host.getTools()).map((tool) => tool.name);
  });

  // The vacancy guard: the read must find something, or the two assertions below are empty.
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((name) => name.startsWith('dom.'))).toEqual([]);
  expect(names.filter((name) => name.startsWith('runtime.'))).toEqual([]);
});

test('the page reports no uncaught error while connecting', async ({ page }) => {
  // A page that throws during startup and connects anyway is a page whose next release breaks
  // silently. Collected before navigation so nothing is missed.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });
  expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([]);
});
