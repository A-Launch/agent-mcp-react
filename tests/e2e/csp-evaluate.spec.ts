import { expect, test } from '@playwright/test';

// **The one refusal of `runtime.evaluate` that no test-side probe can exercise**
// (docs/javascript-evaluation.md#when-your-page-forbids-it), made conclusive here.
//
// `MCP_RUNTIME_EVALUATE_FORBIDDEN` cannot be reached from the test side, and the reason is worth
// restating because three separate attempts hit it:
//
//   1. A probe page whose meta policy omitted `unsafe-eval` still constructed a function.
//   2. Rewriting the response headers from the test side also did not enforce.
//   3. And with a REAL header from a real server, `page.evaluate` STILL constructed — while the
//      document recorded two `script-src|eval` violations. Measured. The policy is live; Chromium
//      reports violations from an isolated world and does not enforce them there.
//
// So no test-side evaluation can answer this question, structurally. **The only faithful instrument is
// the tool itself** — library code running in the page's own world, reached the way an agent reaches
// it: over the socket, through the gate chain, with a person approving.
//
// The page is served under a real `Content-Security-Policy` that omits `unsafe-eval`, which is the
// ordinary posture of a security-conscious application. `runtime.evaluate` must refuse by NAME rather
// than fail as though the expression were at fault — an operator told "syntax error" would go looking
// for a typo in an expression that is perfect.

const AGENT = process.env.AMR_AGENT_HTTP ?? 'http://localhost:45000';

async function readyTabs(): Promise<string[]> {
  const response = await fetch(`${AGENT}/tabs`);
  const { tabs } = (await response.json()) as { tabs: { tabId: string; state: string }[] };
  return tabs.filter((tab) => tab.state === 'ready').map((tab) => tab.tabId);
}

/**
 * The tab THIS page opened, found by difference.
 *
 * **Not "the most recent ready tab", which is what this did first and why it failed.** The agent
 * runtime holds every page that ever connected to it, so a previous run's tab is still listed — and
 * the call went to one of those, where no dialog was waiting and no page was watching. A test that
 * addressed the wrong tab would have been asserting against somebody else's page.
 */
async function tabOpenedSince(before: readonly string[]): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const now = await readyTabs();
    const mine = now.filter((id) => !before.includes(id));
    if (mine.length > 0) return mine[mine.length - 1] ?? '';
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return '';
}

async function callTool(id: string, name: string, args: unknown): Promise<string> {
  const response = await fetch(`${AGENT}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tab: id, name, arguments: args }),
  });
  const body = (await response.json()) as { content?: { text?: string }[] };
  return (body.content ?? []).map((part) => part.text ?? '').join(' ');
}

test('runtime.evaluate refuses by name when the page forbids evaluation', async ({ page }) => {
  test.skip(
    process.env.AMR_CAPABILITIES_PROFILE !== 'evaluate',
    'needs the example served with AMR_CAPABILITIES=evaluate; set AMR_CAPABILITIES_PROFILE=evaluate to run',
  );

  const tabsBefore = await readyTabs();

  // Served with a real header, from the real server. Nothing about the bundle differs — only the
  // response header does.
  //
  // **The header is asserted from the RESPONSE, not from inside the page.** An earlier version listened
  // for `securitypolicyviolation` via `page.evaluate` and was unreliable, for the same reason the whole
  // verification needed rethinking: that world is not the page's. The response header is a fact about
  // what the server sent, and it is the thing the browser applies.
  const response = await page.goto('/?csp=strict');
  const policy = response?.headers()['content-security-policy'] ?? '';
  expect(policy, 'the page is served under a Content-Security-Policy').not.toBe('');
  expect(policy, 'and that policy does NOT permit unsafe-eval').not.toContain('unsafe-eval');

  await expect(page.getByTestId('connection').locator('strong')).toHaveText('connected', {
    timeout: 15_000,
  });

  // **That the page connected at all is itself a finding.** Under this policy the bundled Ajv
  // validator throws while compiling a schema, so the page registers nothing — measured, and recorded
  // in `docs/issues/validator-requires-unsafe-eval.md`. It connects here because the demonstrator
  // installs a CSP-safe validator through the `SchemaValidator` seam, which is what any application
  // under a strict policy must do.

  const id = await tabOpenedSince(tabsBefore);
  expect(id, 'this page registered a new tab with the agent runtime').not.toBe('');

  // The call blocks on the confirmation dialog, so it is started and answered concurrently.
  const call = callTool(id, 'runtime.evaluate', { expression: 'return 1 + 1;' });
  await page.getByTestId('confirmation').waitFor({ timeout: 10_000 });
  await page.locator('.confirm-actions button.primary').click();

  const answer = await call;

  // **The whole point: the cause names the POLICY, not the expression.** `return 1 + 1;` is perfect
  // JavaScript, so a syntax cause here would send an operator to fix code that is already correct.
  expect(answer).toContain('MCP_RUNTIME_EVALUATE_FORBIDDEN');
  expect(answer).not.toContain('MCP_RUNTIME_EVALUATE_SYNTAX');
  expect(answer).toMatch(/content security policy/i);
});
