import { fireEvent } from '@testing-library/react/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BoardApplication,
  call,
  listedNames,
  startBoard,
  stopBoard,
} from './board-harness.tsx';

// User stories 1 and 2: composing a board by describing it, and the person and the agent composing the
// same one.
//
// **One application, advanced by the cases in order.** Failures CASCADE, and that is accepted for the
// same reason it is in the acceptance suite: the FIRST red names where the narrative broke, and cases
// that each rebuilt the prefix would pass in isolation while testing nothing about order. Read
// top-down.
//
// **Every negative case asserts the REFUSAL at invocation**, never absence from a listing, and every one
// also asserts the board is unchanged — a refusal that leaves a half-built panel behind is the failure
// mode, not the error message.
//
// **No `act()` around an agent call.** A handler awaiting `afterRender()` cannot settle inside a
// callback that defers the renderer until it returns; outside `act`, React commits on its own scheduler
// while the call is in flight, which is exactly what a browser does.

const ADD = 'board.add_panel';
const REMOVE = 'board.remove_panel';
const STATE = 'board.get_state';

interface StatePanel {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly settings?: Record<string, unknown>;
}

let app: BoardApplication;

/** The board as the agent reads it. Parsed once here so the cases read like assertions. */
async function readBoard(): Promise<{ panels: StatePanel[]; panelCount: number }> {
  const { text, isError } = await call(app.client, STATE);
  expect(isError, `board.get_state failed: ${text}`).toBe(false);
  return JSON.parse(text) as { panels: StatePanel[]; panelCount: number };
}

/**
 * A composition call's result, as the agent reads it.
 *
 * **A refusal arrives as `ok: false`, not as `isError`.** A handler that threw would have its message
 * replaced with a generic `MCP_TOOL_EXECUTION_ERROR` outside a development build — so guidance the agent
 * is supposed to act on has to be RETURNED. `isError` is still asserted where it matters: it must be
 * FALSE, because the tool did not fail, it declined.
 */
async function compose(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; refused?: string; [key: string]: unknown }> {
  const { text, isError } = await call(app.client, name, args);
  expect(isError, `${name} must decline as a result, never as a thrown failure: ${text}`).toBe(
    false,
  );
  return JSON.parse(text) as { ok: boolean; refused?: string };
}

/** How many panels a person can see, read off the screen rather than out of the store. */
function panelsOnScreen(): number {
  return app.rendered.container.querySelectorAll('[data-panel-kind]').length;
}

beforeAll(async () => {
  app = await startBoard();
});

afterAll(async () => {
  await stopBoard();
});

describe('a person describing a board, and a person building the same one by hand', () => {
  it('starts empty, and offers only the composition tools', async () => {
    const names = await listedNames(app.client);

    // The shell's three tools plus the state read. Nothing panel-scoped, because nothing is mounted.
    expect(names).toContain(ADD);
    expect(names).toContain(REMOVE);
    expect(names).toContain('board.reorder');
    expect(names).toContain(STATE);
    expect(names.filter((name) => name.startsWith('panel.'))).toEqual([]);

    expect(panelsOnScreen()).toBe(0);
    expect((await readBoard()).panelCount).toBe(0);
  });

  it('puts two panels on the screen from one call, and reports what it created', async () => {
    const result = (await compose(ADD, {
      panels: [
        { kind: 'table', source: 'accounts' },
        { kind: 'metric', source: 'revenue_by_region' },
      ],
    })) as unknown as {
      ok: boolean;
      created: { id: string; kind: string; source: string; actions: string[] }[];
      panelCount: number;
    };
    expect(result.ok).toBe(true);

    expect(result.created).toHaveLength(2);
    expect(result.created[0]?.kind).toBe('table');
    expect(result.created[1]?.kind).toBe('metric');

    // **The result names the actions each new panel declares**, so the agent learns what it gained
    // without re-listing.
    expect(result.created[0]?.actions).toEqual([
      `panel.${String(result.created[0]?.id)}.set_sort`,
      `panel.${String(result.created[0]?.id)}.set_filter`,
    ]);

    // **The observable consequence, not only the return value.** A handler that reported success while
    // the screen never changed is this system's characteristic defect.
    expect(panelsOnScreen()).toBe(2);
  });

  it('agrees with the screen at the moment it reports, not merely eventually', async () => {
    const result = await compose(ADD, { panels: [{ kind: 'chart', source: 'signups_by_month' }] });
    const reported = result.panelCount as number;

    // **Read immediately, with nothing awaited in between.** A DOM assertion can see "the UI never
    // updated"; it cannot see "the UI updated LATE" — and late is the defect, because a handler that
    // reads its result before the commit reports the previous render's totals. Waiting here would make
    // the bug less visible rather than more.
    const onScreen = panelsOnScreen();
    const counter = app.rendered.getByTestId('panel-count').textContent ?? '';

    expect(onScreen).toBe(reported);
    expect(counter).toContain(String(reported));
  });

  it('refuses an undeclared property rather than ignoring it', async () => {
    const before = await readBoard();
    const { text, isError } = await call(app.client, ADD, {
      panels: [{ kind: 'table', source: 'accounts' }],
      // Not in the schema. JSON Schema admits undeclared properties BY DEFAULT, so this case is the
      // only thing standing between `additionalProperties: false` and a contract nothing enforces.
      colour: 'blue',
    });

    // **This one IS an isError**, and the difference matters: the runtime refused it before the handler
    // ran, so nothing in the application chose to disclose anything. Schema refusals name the field and
    // the expected shape on their own.
    expect(isError, 'an undeclared property must be refused, not ignored').toBe(true);
    expect(text).toContain('colour');
    expect((await readBoard()).panelCount).toBe(before.panelCount);
  });

  it('refuses a panel kind it does not offer, and names the ones it does', async () => {
    const before = await readBoard();
    // `heatmap` is outside the declared `enum`, so this is refused by the runtime before the handler.
    const { text, isError } = await call(app.client, ADD, {
      panels: [{ kind: 'heatmap', source: 'accounts' }],
    });

    expect(isError).toBe(true);
    for (const kind of ['table', 'metric', 'chart', 'form']) {
      expect(text, 'a refusal must name the permitted set').toContain(kind);
    }
    expect((await readBoard()).panelCount).toBe(before.panelCount);
  });

  it('refuses a data source it does not offer, and creates no placeholder panel', async () => {
    const before = await readBoard();
    const { text, isError } = await call(app.client, ADD, {
      panels: [{ kind: 'table', source: 'invoices' }],
    });

    expect(isError).toBe(true);
    expect(text).toContain('accounts');
    expect((await readBoard()).panelCount).toBe(before.panelCount);
    expect(panelsOnScreen()).toBe(before.panelCount);
  });

  it('refuses a kind/source PAIR the catalog does not admit, though both halves are legal', async () => {
    const before = await readBoard();
    // `chart` is a kind and `accounts` is a source. Validating them separately would admit this.
    const refusal = await compose(ADD, { panels: [{ kind: 'chart', source: 'accounts' }] });

    expect(refusal.ok, 'the pair must be checked, not each half').toBe(false);
    expect(refusal.refused).toContain('revenue_by_region');
    expect((await readBoard()).panelCount).toBe(before.panelCount);
  });

  it('refuses a call that tries to choose a panel identifier', async () => {
    const before = await readBoard();
    const { isError } = await call(app.client, ADD, {
      panels: [{ kind: 'table', source: 'accounts', id: 'table-99' }],
    });

    // The application mints identifiers. Two panels answering to one identifier is a wrong answer that
    // looks entirely normal — the same shape as the hand-written tab id this repository broke on.
    // Refused by the schema, because the entry object is closed.
    expect(isError).toBe(true);
    expect((await readBoard()).panelCount).toBe(before.panelCount);
  });

  it('adds NOTHING when one entry of a batch is invalid', async () => {
    const before = await readBoard();
    const refusal = await compose(ADD, {
      panels: [
        { kind: 'table', source: 'accounts' },
        { kind: 'chart', source: 'accounts' },
      ],
    });

    expect(refusal.ok).toBe(false);
    // **Not "one was added".** The batch is validated whole before anything is applied, so a refusal
    // cannot depend on where in the list it appeared.
    expect((await readBoard()).panelCount).toBe(before.panelCount);
    expect(panelsOnScreen()).toBe(before.panelCount);
  });

  it('removes a panel and takes its actions away with it', async () => {
    const before = await readBoard();
    const victim = before.panels[0]?.id ?? '';

    const removed = await compose(REMOVE, { id: victim });
    expect(removed.ok).toBe(true);

    const after = await readBoard();
    expect(after.panelCount).toBe(before.panelCount - 1);
    expect(after.panels.map((panel) => panel.id)).not.toContain(victim);
    expect(panelsOnScreen()).toBe(after.panelCount);
  });

  it('refuses to remove a panel that is not there, naming the ids that are', async () => {
    const before = await readBoard();
    const refusal = await compose(REMOVE, { id: 'table-9999' });

    expect(refusal.ok).toBe(false);
    expect(refusal.refused, 'a refusal must name the ids that ARE there').toContain(
      before.panels[0]?.id ?? '',
    );
    expect((await readBoard()).panelCount).toBe(before.panelCount);
  });
});

describe('parity: what the toolbar builds and what the agent builds are one board', () => {
  /** Adds a panel through the human controls, exactly as a person would. */
  function addByHand(kind: string, source: string): void {
    fireEvent.change(app.rendered.getByTestId('add-kind'), { target: { value: kind } });
    fireEvent.change(app.rendered.getByTestId('add-source'), { target: { value: source } });
    fireEvent.click(app.rendered.getByTestId('add-panel'));
  }

  // **Iterated over the vocabulary rather than listed.** A kind added to `PANEL_KIND` and not to this
  // loop must be visible rather than silently unchecked — a hardcoded list is a test that quietly stops
  // covering the thing it names.
  const PAIRS: readonly (readonly [string, string])[] = [
    ['table', 'accounts'],
    ['metric', 'revenue_by_region'],
    ['chart', 'signups_by_month'],
    ['form', 'accounts'],
  ];

  it('covers every kind in the catalog', async () => {
    const { text } = await call(app.client, STATE);
    expect(text.length).toBeGreaterThan(0);
    // The pairs above must name every kind the catalog offers; otherwise the parity case below is
    // testing a subset while reading as though it tested the whole.
    expect(PAIRS.map(([kind]) => kind).sort()).toEqual(['chart', 'form', 'metric', 'table']);
  });

  for (const [kind, source] of PAIRS) {
    it(`produces an identical ${kind} whether a person or the agent adds it`, async () => {
      addByHand(kind, source);
      const afterHand = await readBoard();
      const byHand = afterHand.panels.at(-1);

      const added = await compose(ADD, { panels: [{ kind, source }] });
      expect(added.ok).toBe(true);
      const byAgent = (await readBoard()).panels.at(-1);

      expect(byHand?.kind).toBe(kind);
      expect(byAgent?.kind).toBe(kind);
      expect(byAgent?.source).toBe(byHand?.source);
      // Everything either side can observe, except the identifier — which is unique by construction and
      // is the one thing that MUST differ.
      expect(byAgent?.settings).toEqual(byHand?.settings);
      expect(byAgent?.id).not.toBe(byHand?.id);
    });
  }

  it('reports a panel a person removed with the mouse as gone', async () => {
    const before = await readBoard();
    const victim = before.panels.at(-1)?.id ?? '';

    fireEvent.click(app.rendered.getByTestId(`remove-${victim}`));

    const after = await readBoard();
    expect(after.panels.map((panel) => panel.id)).not.toContain(victim);
    expect(after.panelCount).toBe(before.panelCount - 1);
  });

  it('refuses to exceed the board ceiling, naming the maximum', async () => {
    const before = await readBoard();
    const room = 12 - before.panelCount;

    if (room > 0) {
      const filled = await compose(ADD, {
        panels: Array.from({ length: room }, () => ({ kind: 'metric', source: 'accounts' })),
      });
      expect(filled.ok).toBe(true);
    }
    expect((await readBoard()).panelCount).toBe(12);

    const refusal = await compose(ADD, { panels: [{ kind: 'metric', source: 'accounts' }] });
    expect(refusal.ok).toBe(false);
    expect(refusal.refused, 'a refusal must name the maximum').toContain('12');
    expect((await readBoard()).panelCount).toBe(12);
  });
});
