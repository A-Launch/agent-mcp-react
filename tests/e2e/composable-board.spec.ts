import { expect, test } from '@playwright/test';

// The composable board, in a real browser, over a real socket.
//
// **This is the live run the plan required, made repeatable.** Everything below is invisible to
// `pnpm test:integration`, which builds the provider itself in jsdom: that the published bundle
// actually loads, that `App.tsx`'s own wiring is right — its provider nesting, its validator, its
// hardcoded capability set — that a real WebSocket carries the registrations, and that the page
// addresses ITSELF when a second demonstrator is also connected.
//
// **It needs THREE servers**, and the third is deliberate:
//
//   pnpm dev:agent      :45000
//   pnpm dev:example    :45010   ← started so the ambiguity case has something to be ambiguous with
//   pnpm dev:board      :45030
//
// Starting the dashboard is not incidental. With one page connected, the runtime answers an
// unaddressed control request happily, so a case that "passes" against a single tab proves nothing
// about addressing. The positive control is the whole point: the unaddressed request must FAIL while
// the addressed one succeeds.

const AGENT = process.env.AMR_AGENT_URL ?? 'http://localhost:45000';
const BOARD = process.env.AMR_BOARD_URL ?? 'http://localhost:45030';
const DASHBOARD = process.env.AMR_EXAMPLE_URL ?? 'http://localhost:45010';

interface CallOutcome {
  readonly content?: { type?: string; text?: string }[];
  readonly isError?: boolean;
  readonly error?: string;
}

/** Calls one tool through the agent runtime, addressed to a named tab. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  tab: string,
): Promise<{ text: string; isError: boolean; status: number }> {
  const response = await fetch(`${AGENT}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args, tab }),
  });
  const body = (await response.json()) as CallOutcome;
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return {
    text: text === '' ? JSON.stringify(body) : text,
    isError: body.isError === true || !response.ok,
    status: response.status,
  };
}

async function listNames(tab: string): Promise<string[]> {
  const response = await fetch(`${AGENT}/tools?tab=${encodeURIComponent(tab)}`);
  const body = (await response.json()) as { tools?: { name: string }[] };
  return (body.tools ?? []).map((tool) => tool.name);
}

async function connectedTabs(): Promise<{ tabId: string | null; state: string }[]> {
  const body = (await (await fetch(`${AGENT}/agent`)).json()) as {
    tabs: { tabId: string | null; state: string }[];
  };
  return body.tabs;
}

/**
 * The one tab that is READY, waited for rather than assumed.
 *
 * **Two things make the obvious version wrong, and both were measured here.** The page's connection
 * indicator says `connected` as soon as the SOCKET is open, while the agent still records the tab as
 * `connecting` until MCP `initialize` completes — so reading the tab list the instant the UI turns
 * green addresses a tab that cannot answer. And a closed browser context's socket is not reaped the
 * moment the context closes, so the previous case's tab can still be in the list.
 *
 * This waits on a genuinely asynchronous boundary — a handshake crossing a real socket, and a close
 * frame arriving — which is what polling is for. It is not a delay standing in for synchronization.
 */
async function readyTab(): Promise<string> {
  for (let turn = 0; turn < 200; turn += 1) {
    const ready = (await connectedTabs()).filter((tab) => tab.state === 'ready');
    if (ready.length === 1 && ready[0]?.tabId != null) return ready[0].tabId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const seen = JSON.stringify(await connectedTabs());
  throw new Error(`waited for exactly one READY tab and never saw it — the agent reports ${seen}`);
}

// **Serial, deliberately.** `fullyParallel` is on for this project, and these cases read
// `/agent`'s tab list to learn which page is theirs. Two cases connecting at once would each see the
// other's page and address the wrong one — which would look like a flaky suite rather than what it is.
test.describe.configure({ mode: 'serial' });

test.describe('the composable board, in a browser', () => {
  test('loads, connects, and publishes its tools over a real socket', async ({ browser }) => {
    const context = await browser.newContext();

    // **Every page error is collected and asserted on.** A bundle that throws on import still renders
    // an empty body, and an assertion about content would call that a layout problem.
    const failures: string[] = [];
    const board = await context.newPage();
    board.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
    board.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console.error: ${message.text()}`);
    });

    await board.goto(BOARD);

    // The provider dialled, the ticket was redeemed, and the socket is open. This is `App.tsx`'s own
    // wiring — the part both harnesses substitute for.
    await expect(board.getByTestId('connection')).toContainText('connected', { timeout: 15_000 });
    await expect(board.getByTestId('board-empty')).toBeVisible();

    // Only THIS page is connected, so its tab is unambiguous and can be captured before the second
    // demonstrator arrives to make it ambiguous.
    const boardTab = await readyTab();
    expect(boardTab).not.toBe('');

    const names = await listNames(boardTab);
    expect(names).toContain('board.add_panel');
    expect(names).toContain('board.remove_panel');
    expect(names).toContain('board.reorder');
    expect(names).toContain('board.get_state');
    // Nothing is mounted, so no panel actions exist yet.
    expect(names.filter((name) => name.startsWith('panel.'))).toEqual([]);

    // **Level 1 only, checked in the page rather than in a config file.** Level 2 and Level 3 are
    // absent from the document's shared registry in every configuration, including this one — anything
    // in that registry is callable by any script on the page with not one gate in the path.
    const registryNames = await board.evaluate(async () => {
      const registry = (
        document as unknown as { modelContext?: { getTools?: () => Promise<unknown> } }
      ).modelContext;
      const tools = (await registry?.getTools?.()) as { name: string }[] | undefined;
      return (tools ?? []).map((tool) => tool.name);
    });
    expect(registryNames.length, 'the page registry should hold the Level 1 tools').toBeGreaterThan(
      0,
    );
    expect(registryNames.filter((name) => name.startsWith('dom.'))).toEqual([]);
    expect(registryNames.filter((name) => name.startsWith('runtime.'))).toEqual([]);

    expect(failures, `the page reported errors: ${failures.join(' | ')}`).toEqual([]);
    await context.close();
  });

  test('addresses itself when a second demonstrator is also connected', async ({ browser }) => {
    const context = await browser.newContext();
    const board = await context.newPage();
    await board.goto(BOARD);
    await expect(board.getByTestId('connection')).toContainText('connected', { timeout: 15_000 });

    const boardTab = await readyTab();
    expect(boardTab).not.toBe('');

    // The other demonstrator, started on purpose.
    const dashboard = await context.newPage();
    await dashboard.goto(DASHBOARD);
    await expect(dashboard.getByTestId('connection')).toContainText('connected', {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await connectedTabs()).filter((tab) => tab.state === 'ready').length, {
        timeout: 15_000,
      })
      .toBe(2);

    // **The negative half.** An unaddressed control request is now refused — which is what makes the
    // positive half below mean something rather than being a request that would have worked anyway.
    const unaddressed = await fetch(`${AGENT}/tools`);
    expect(unaddressed.status, 'an unaddressed request must be refused with two tabs up').toBe(400);
    expect(await unaddressed.text()).toContain('several tabs');

    // **The positive half.** The page's own id still reaches the page.
    expect(await listNames(boardTab)).toContain('board.add_panel');

    await context.close();
  });

  test('composes, keeps identity across a reorder, and keeps a secret out of what the agent reads', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const board = await context.newPage();
    await board.goto(BOARD);
    await expect(board.getByTestId('connection')).toContainText('connected', { timeout: 15_000 });
    const tab = await readyTab();

    // Two tables of the SAME KIND, which is what makes the reorder trap live: a position-derived name
    // would leave the listing byte-identical while every tool drove the wrong panel.
    const added = await callTool(
      'board.add_panel',
      {
        panels: [
          { kind: 'table', source: 'accounts' },
          { kind: 'table', source: 'revenue_by_region' },
          { kind: 'form', source: 'accounts' },
        ],
      },
      tab,
    );
    expect(added.isError, added.text).toBe(false);
    const created = (JSON.parse(added.text) as { ok: boolean; created: { id: string }[] }).created;
    const [tableA, tableB, form] = created.map((panel) => panel.id);

    // The screen changed, in a browser.
    await expect(board.getByTestId(`panel-${String(tableA)}`)).toBeVisible();
    await expect(board.getByTestId('panel-count')).toContainText('3 panels');

    // **The registration gap, MEASURED rather than claimed (R15).** `afterRender()` is a barrier about
    // rendering; registration completes asynchronously after the effect that starts it. Whether a new
    // panel's action answers immediately is a fact this run records, not one the design asserts.
    const immediate = await callTool(`panel.${String(tableA)}.set_filter`, { query: 'acme' }, tab);
    // eslint-disable-next-line no-console
    console.log(
      `[R15 registration gap] a panel action called immediately after add_panel resolved: ${
        immediate.isError ? 'REFUSED' : 'ANSWERED'
      } — ${immediate.text.slice(0, 120)}`,
    );

    const before = (await listNames(tab)).sort();

    const reordered = await callTool('board.reorder', { id: tableA, position: 1 }, tab);
    expect(reordered.isError, reordered.text).toBe(false);

    // Half one: the listing is unchanged.
    expect((await listNames(tab)).sort()).toEqual(before);

    // Half two, the half a listing cannot give you: the tool named for tableA still drives tableA.
    const filtered = await callTool(`panel.${String(tableA)}.set_filter`, { query: 'zenith' }, tab);
    expect(filtered.isError, filtered.text).toBe(false);
    await expect(board.getByTestId(`filter-${String(tableA)}`)).toContainText('zenith');
    await expect(board.getByTestId(`filter-${String(tableB)}`)).toHaveCount(0);

    // The form: fill it, then read the board back and confirm the secret is absent.
    const secret = 'hunter2-live-run';
    const filledOut = await callTool(
      `panel.${String(form)}.fill`,
      {
        name: 'Live Run Ltd',
        owner_email: 'ada@liverun.test',
        plan: 'team',
        initial_password: secret,
      },
      tab,
    );
    expect(filledOut.isError, filledOut.text).toBe(false);

    const state = await callTool('board.get_state', {}, tab);
    expect(state.isError, state.text).toBe(false);
    expect(state.text, 'the non-secret value must be reported').toContain('ada@liverun.test');
    expect(state.text, 'the secret value must appear nowhere').not.toContain(secret);

    // A person can see it; the agent cannot read it.
    await expect(board.getByTestId(`field-${String(form)}-initial_password`)).toHaveValue(secret);

    await context.close();
  });

  test('waits for a person before submitting, and refuses when they decline', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const board = await context.newPage();
    await board.goto(BOARD);
    await expect(board.getByTestId('connection')).toContainText('connected', { timeout: 15_000 });
    const tab = await readyTab();

    const added = await callTool(
      'board.add_panel',
      { panels: [{ kind: 'form', source: 'accounts' }] },
      tab,
    );
    const form = (JSON.parse(added.text) as { created: { id: string }[] }).created[0]?.id ?? '';

    await callTool(
      `panel.${form}.fill`,
      {
        name: 'Declined Ltd',
        owner_email: 'no@declined.test',
        plan: 'free',
        initial_password: 'x',
      },
      tab,
    );

    // Issued and NOT awaited: the confirmation resolves BEFORE the handler, so this parks.
    const pending = callTool(`panel.${form}.submit`, {}, tab);

    // **If this prompt never appears the page is not instrumented.** With the dialog wired and the
    // resolver not, every call is refused `MCP_TOOL_CONFIRMATION_UNAVAILABLE` and no prompt is ever
    // shown — a failure that is SAFE, and therefore invisible to anything but a run that looks.
    await expect(board.getByTestId('confirmation')).toBeVisible({ timeout: 15_000 });

    // **And it has to be READABLE, not merely present.** This stylesheet targeted `.confirm-panel`,
    // which no component has ever rendered, so the panel that gates every agent mutation drew with no
    // background and no width: its heading and the arguments a person is approving painted straight
    // onto the board behind them. Every assertion in this file stayed green throughout — the test ids
    // and the button names were correct the whole time — and a selector that matches nothing is
    // invisible to the compiler and the linter alike. It was found by watching a recording.
    const paint = await board.locator('.confirm').evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      width: node.getBoundingClientRect().width,
    }));
    expect(paint.background, 'the confirmation panel must paint its own background').not.toMatch(
      /rgba\(0, 0, 0, 0\)|transparent/,
    );
    expect(paint.width, 'and must be a bounded panel, not the whole viewport').toBeLessThan(700);

    await board.getByRole('button', { name: 'No' }).click();

    const settled = await pending;
    expect(settled.isError, 'a declined confirmation must settle as a refusal').toBe(true);

    await context.close();
  });
});
