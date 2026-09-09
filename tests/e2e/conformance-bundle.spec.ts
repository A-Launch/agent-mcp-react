import { expect, test } from '@playwright/test';

// The oldest row of the conformance rule (docs/design.md#testing-strategy): **the MCP SDK server
// package runs in a browser bundle**. A scratch probe answered it; a case was still owed.
//
// The rule says exactly why the probe was not enough: a documented claim is not a verified one, and a
// scratch experiment does not fail when a future dependency bump breaks it. The row stays open until
// the case exists in this repository.
//
// The rule also says where the case belongs — the end-to-end layer, for the bundling question, since
// that is what only a browser can catch. This is the case, and it runs on all three engines.
//
// **The question is not "does the page work".** Other cases cover that. It is specifically: does the
// MCP SDK's SERVER, a package written for Node, actually evaluate and operate inside a browser? A
// bundler can resolve it, ship it, and have it throw on first use — and the symptom would be a page
// that loads and an agent that is never served.

test('the MCP SDK server runs in the browser, not merely bundles into it', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));

  await page.goto('/');

  // Reaching `connected` is what proves it. The provider constructs the SDK's `Server`, attaches it to
  // a transport and completes an MCP handshake — none of which can happen if the SDK failed to
  // evaluate or threw on construction in this engine.
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });

  // ...and it must have SERVED something, not just constructed. A server that initialized and could
  // not answer would still show "connected".
  const registryWorks = await page.evaluate(async () => {
    const host = (globalThis as { document?: { modelContext?: unknown } }).document?.modelContext as
      | { getTools?: () => Promise<{ name: string }[]> }
      | undefined;
    if (host?.getTools === undefined) return { ok: false, count: 0 };
    const tools = await host.getTools();
    return { ok: true, count: tools.length };
  });

  expect(registryWorks.ok, 'a tool registry resolved in this engine').toBe(true);
  expect(registryWorks.count, 'the application registered tools through it').toBeGreaterThan(0);

  expect(failures, `the page raised errors while the SDK ran:\n${failures.join('\n')}`).toEqual([]);
});

test('the bundle works with every Node global absent', async ({ page }) => {
  // The specific way a Node-written package fails in a browser: it touches `process`, `Buffer` or
  // `require` and throws. This asserts the page works when none of them exists.
  //
  // **The first version of this case asserted the opposite and was wrong**, which is worth recording
  // because the distinction is the whole point. It asserted that no Node global is ever *read*, and it
  // failed — `src/build-mode.ts` reads `globalThis.process?.env?.NODE_ENV`, deliberately, with
  // optional chaining, and its own comment explains why at length: a browser dev server serves ESM to
  // a page where `process` is undefined, so a library reading only the bundler flag answers
  // "production" in every browser development session.
  //
  // Reading defensively is CORRECT. The requirement is not "never look" — it is "work when it is not
  // there", and that is what this now asserts.
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));

  await page.addInitScript(() => {
    const absent = { get: () => undefined, configurable: true };
    for (const name of ['process', 'Buffer', 'require', 'global', 'module', 'exports']) {
      if (name in globalThis) continue;
      Object.defineProperty(globalThis, name, absent);
    }
  });

  await page.goto('/');

  // Connecting proves the SDK, the transport and the provider all ran without any of them.
  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });

  const tools = await page.evaluate(async () => {
    const host = (globalThis as { document?: { modelContext?: unknown } }).document?.modelContext as
      | { getTools?: () => Promise<{ name: string }[]> }
      | undefined;
    return host?.getTools === undefined ? 0 : (await host.getTools()).length;
  });
  expect(tools, 'tools registered with no Node globals present').toBeGreaterThan(0);

  expect(failures, `the page threw with Node globals absent:\n${failures.join('\n')}`).toEqual([]);
});
