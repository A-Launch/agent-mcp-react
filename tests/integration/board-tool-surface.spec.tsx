import { fireEvent } from '@testing-library/react/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BoardApplication,
  call,
  listedNames,
  startBoard,
  stopBoard,
  until,
} from './board-harness.tsx';

// User story 3: the reachable actions are a function of what is on the screen.
//
// **Asserted through what an MCP CLIENT sees**, never through the library's own registry. A registry
// read that agreed with a broken `tools/list` would be a test of the registry.
//
// The case this file exists for is the REORDER one. A panel identifier that comes from a counter is
// necessary and not sufficient: the rendered list must also be keyed by that identifier, or React reuses
// one component instance for a different panel and renames its actions underneath it. And a listing
// comparison alone cannot catch that — swapping two panels of the SAME KIND leaves a position-derived
// name list byte-identical while every tool now drives the wrong panel. So the reorder case asserts
// IDENTITY CONTINUITY: it calls a tool afterwards and checks which panel actually changed.

const ADD = 'board.add_panel';
const REMOVE = 'board.remove_panel';
const REORDER = 'board.reorder';

let app: BoardApplication;
/** Counts `notifications/tools/list_changed` as the CLIENT receives them. */
let notifications = 0;

/** Two tables of the SAME KIND on DIFFERENT sources — the pair that makes the reorder trap live. */
let tableA = '';
let tableB = '';

async function add(kind: string, source: string): Promise<string> {
  const { text, isError } = await call(app.client, ADD, { panels: [{ kind, source }] });
  expect(isError, text).toBe(false);
  const result = JSON.parse(text) as { ok: boolean; created: { id: string }[] };
  expect(result.ok, text).toBe(true);
  return result.created[0]?.id ?? '';
}

/** Waits until the agent's listing contains (or stops containing) a name. A socket round trip. */
async function untilListed(name: string, present: boolean): Promise<void> {
  await until(
    async () => (await listedNames(app.client)).includes(name) === present,
    `${name} to ${present ? 'appear in' : 'leave'} the agent's listing`,
  );
}

beforeAll(async () => {
  app = await startBoard();
  app.client.setNotificationHandler('notifications/tools/list_changed', () => {
    notifications += 1;
  });
});

afterAll(async () => {
  await stopBoard();
});

describe('the actions an agent can reach follow what is on the board', () => {
  it('offers no panel actions while the board is empty', async () => {
    const names = await listedNames(app.client);
    expect(names.filter((name) => name.startsWith('panel.'))).toEqual([]);
  });

  it('gains a panel’s own actions when that panel appears, and notifies without being asked', async () => {
    const before = notifications;
    tableA = await add('table', 'accounts');

    await untilListed(`panel.${tableA}.set_sort`, true);
    const names = await listedNames(app.client);

    expect(names).toContain(`panel.${tableA}.set_sort`);
    expect(names).toContain(`panel.${tableA}.set_filter`);

    // **The agent was TOLD.** There is no subscription to open — this connection negotiates an era where
    // notifications are unsolicited — so an absence here would mean a quietly stale agent rather than
    // an error.
    await until(() => notifications > before, 'a tools/list_changed notification to arrive');
  });

  it('does not touch the registry when a setting changes', async () => {
    const before = await listedNames(app.client);
    const notifiedBefore = notifications;

    const { text, isError } = await call(app.client, `panel.${tableA}.set_sort`, {
      column: 'revenue',
      direction: 'desc',
    });
    expect(isError, text).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ column: 'revenue', direction: 'desc' });

    // The display changed and the tool set did not. A descriptor that moved with a setting would make
    // every sort a withdraw-and-register cycle: a tool-list-change storm, and a window in which the tool
    // does not exist.
    expect(app.rendered.getByTestId(`sort-${tableA}`).textContent).toContain('revenue desc');
    expect(await listedNames(app.client)).toEqual(before);
    expect(notifications, 'a settings change must notify nothing').toBe(notifiedBefore);
  });

  it('keeps every action name AND every action’s panel across a reorder', async () => {
    tableB = await add('table', 'revenue_by_region');
    await untilListed(`panel.${tableB}.set_sort`, true);

    const before = [...(await listedNames(app.client))].sort();
    const notifiedBefore = notifications;

    const { text, isError } = await call(app.client, REORDER, { id: tableA, position: 1 });
    expect(isError, text).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ ok: true, order: [tableB, tableA] });

    // Half one: the listing is byte-identical and nothing was announced.
    expect([...(await listedNames(app.client))].sort()).toEqual(before);
    expect(notifications, 'a reorder must notify nothing').toBe(notifiedBefore);

    // **Half two, and the half a listing comparison cannot give you.** Both panels are tables, so a
    // position-derived name would leave the sorted list above unchanged while every tool drove the wrong
    // panel. Calling one and checking WHICH panel changed is the only assertion that separates them.
    const filtered = await call(app.client, `panel.${tableA}.set_filter`, { query: 'acme' });
    expect(filtered.isError, filtered.text).toBe(false);

    expect(
      app.rendered.getByTestId(`filter-${tableA}`).textContent,
      'the tool named for tableA must still act on tableA after the reorder',
    ).toContain('acme');
    expect(
      app.rendered.queryByTestId(`filter-${tableB}`),
      'and must not have acted on the panel it swapped places with',
    ).toBeNull();
  });

  it('keeps two panels of the same kind independent', async () => {
    const beforeB = app.rendered.getByTestId(`sort-${tableB}`).textContent ?? '';

    const { isError } = await call(app.client, `panel.${tableA}.set_sort`, {
      column: 'owner',
      direction: 'asc',
    });
    expect(isError).toBe(false);

    expect(app.rendered.getByTestId(`sort-${tableA}`).textContent).toContain('owner asc');
    expect(app.rendered.getByTestId(`sort-${tableB}`).textContent).toBe(beforeB);
  });

  it('takes a panel’s actions away when it is removed', async () => {
    const { isError } = await call(app.client, REMOVE, { id: tableB });
    expect(isError).toBe(false);

    await untilListed(`panel.${tableB}.set_sort`, false);
    const names = await listedNames(app.client);
    expect(names).not.toContain(`panel.${tableB}.set_sort`);
    expect(names).toContain(`panel.${tableA}.set_sort`);
  });

  it('refuses a call against a removed panel as a MISSING TOOL, not a bad argument', async () => {
    const { text, isError } = await call(app.client, `panel.${tableB}.set_sort`, {
      column: 'revenue',
    });

    // **The distinction is the whole design.** The identifier is part of the NAME and never an argument,
    // so a panel that is gone is a tool that is not there. A fixed tool taking a `panelId` would have
    // answered this with a validation failure instead — a different, weaker claim.
    expect(isError).toBe(true);
    expect(text).toContain('MCP_TOOL_NOT_FOUND');
  });

  it('never reports success for a call whose panel is removed while it is in flight', async () => {
    const doomed = await add('table', 'accounts');
    await untilListed(`panel.${doomed}.set_filter`, true);

    // Issued and deliberately NOT awaited, then the panel is taken away by a person's click.
    const inflight = call(app.client, `panel.${doomed}.set_filter`, { query: 'gone' });
    fireEvent.click(app.rendered.getByTestId(`remove-${doomed}`));

    const settled = await inflight;

    // **The requirement is a disjunction and the assertion says so.** Which outcome occurs depends on
    // whether the call reached the handler before the withdrawal — cancelled if it did, not-found if it
    // did not — and both are correct. What must never happen is a success, because the filter was never
    // applied to anything a person can see. Asserting one specific outcome would make this case depend
    // on a race rather than on the guarantee.
    expect(
      settled.isError,
      `a call against a withdrawn tool must not succeed: ${settled.text}`,
    ).toBe(true);
  });

  it('returns to its baseline when the board is emptied', async () => {
    const { isError } = await call(app.client, REMOVE, { id: tableA });
    expect(isError).toBe(false);
    await untilListed(`panel.${tableA}.set_sort`, false);

    const names = await listedNames(app.client);
    expect(names.filter((name) => name.startsWith('panel.'))).toEqual([]);
    expect(names).toContain(ADD);
    expect(names).toContain('board.get_state');
  });
});
