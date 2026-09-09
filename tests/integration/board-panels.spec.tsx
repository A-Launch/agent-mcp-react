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

// The three richer panel kinds: a map, a timeline and a deal pipeline.
//
// **What is new here is not "more panels".** Each of these exercises something the first four kinds do
// not: a map whose focus is a MEMBER of a closed set rather than a viewport the agent computes; a
// timeline whose filter is an ARRAY and whose window is an integer with a declared range — both refused
// by the RUNTIME before the handler, which nothing else in this suite covers; and a pipeline that
// CHANGES data behind a person's confirmation, with the change visible in a different panel bound to the
// same source.
//
// The application is built once and advanced, like the other files here: the cases are a sequence, and
// a file that rebuilt the board per case would pass while testing nothing about order.

const ADD = 'board.add_panel';

let app: BoardApplication;
let mapId = '';
let timelineId = '';
let pipelineId = '';
let dealsTableId = '';

async function add(kind: string, source: string): Promise<string> {
  const { text, isError } = await call(app.client, ADD, { panels: [{ kind, source }] });
  expect(isError, text).toBe(false);
  const result = JSON.parse(text) as { ok: boolean; created: { id: string }[] };
  expect(result.ok, text).toBe(true);
  return result.created[0]?.id ?? '';
}

/** Waits until a panel's own action has reached the agent's listing. A socket round trip. */
async function untilListed(name: string): Promise<void> {
  await until(
    async () => (await listedNames(app.client)).includes(name),
    `${name} to appear in the agent's listing`,
  );
}

beforeAll(async () => {
  app = await startBoard();
});

afterAll(async () => {
  await stopBoard();
});

describe('a map an agent can point at a region', () => {
  it('reports the actions it brought, and plots what it was given', async () => {
    const { text, isError } = await call(app.client, ADD, {
      panels: [{ kind: 'map', source: 'sites' }],
    });
    expect(isError, text).toBe(false);
    const created = (
      JSON.parse(text) as { created: { id: string; kind: string; actions: string[] }[] }
    ).created[0];
    mapId = created?.id ?? '';

    // The create call names what the panel declares, so the agent learns what it gained without
    // re-listing — and the names are built from the catalog rather than spelled here.
    expect(created?.actions).toEqual([`panel.${mapId}.set_focus`, `panel.${mapId}.set_measure`]);

    await untilListed(`panel.${mapId}.set_focus`);
    // **`toBe`, not `toContain`.** "13 plotted" CONTAINS "3 plotted", so a containment assertion here
    // would pass for a map that ignored its focus entirely — which is exactly what the break-it run
    // found before this line was changed.
    expect(app.rendered.getByTestId(`plotted-${mapId}`).textContent).toBe('13 plotted');

    // **The geography is drawn, not implied.** Coastlines and borders come from a generated module of
    // Natural Earth arcs; if that module failed to load or decoded to nothing, every assertion above
    // would still pass against an empty blue rectangle. A hundred is far below the real count and far
    // above anything a placeholder would produce.
    const panel = app.rendered.getByTestId(`panel-${mapId}`);
    expect(panel.querySelectorAll('polygon.land').length).toBeGreaterThan(100);
    expect(panel.querySelectorAll('polyline.border').length).toBeGreaterThan(100);
    expect(
      panel.querySelector(`[data-testid="marker-${mapId}-Tokyo"]`),
      'a known site must be on the map',
    ).not.toBeNull();
  });

  it('refuses a map of a source that carries no position', async () => {
    const { text, isError } = await call(app.client, ADD, {
      panels: [{ kind: 'map', source: 'accounts' }],
    });

    // **A refusal, not an error.** The pair is what gets checked — `map` and `accounts` are both legal
    // on their own — and the message names what would have been accepted, so the agent can act on it.
    expect(isError, text).toBe(false);
    const refusal = JSON.parse(text) as { ok: boolean; refused: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.refused).toContain('sites');
    expect(refusal.refused).toContain('revenue_by_region');
  });

  it('narrows to a region without touching the registry', async () => {
    const before = [...(await listedNames(app.client))].sort();

    const { text, isError } = await call(app.client, `panel.${mapId}.set_focus`, { focus: 'emea' });
    expect(isError, text).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ focus: 'emea' });

    // Three sites are in the EMEA window; the rest are off the map now.
    expect(app.rendered.getByTestId(`focus-${mapId}`).textContent).toBe('emea');
    expect(app.rendered.getByTestId(`plotted-${mapId}`).textContent).toBe('3 plotted');

    // A focus is a setting. A descriptor that moved with it would make every pan a withdraw-and-register
    // cycle: a tool-list-change storm, and a window in which the tool does not exist.
    expect([...(await listedNames(app.client))].sort()).toEqual(before);
  });

  it('sizes markers only by a column its source actually has', async () => {
    const good = await call(app.client, `panel.${mapId}.set_measure`, { measure: 'accounts' });
    expect(good.isError, good.text).toBe(false);
    expect(app.rendered.getByTestId(`measure-${mapId}`).textContent).toContain('accounts');

    // `site` is a real column and not a numeric one, so it is outside the declared enum and refused by
    // the RUNTIME before the handler runs.
    const bad = await call(app.client, `panel.${mapId}.set_measure`, { measure: 'site' });
    expect(bad.isError, 'a non-numeric column must be refused').toBe(true);
    expect(bad.text).toContain('measure');
  });
});

describe('a timeline whose filter is a list', () => {
  it('shows every kind until it is told otherwise', async () => {
    timelineId = await add('timeline', 'activity');
    await untilListed(`panel.${timelineId}.set_kinds`);

    expect(app.rendered.getByTestId(`kinds-${timelineId}`).textContent).toBe('every kind');
    expect(app.rendered.getByTestId(`window-${timelineId}`).textContent).toContain('30 days');
  });

  it('accepts an ARRAY of kinds and narrows what it draws', async () => {
    const before = Number(
      (app.rendered.getByTestId(`events-${timelineId}`).textContent ?? '').replace(/\D/g, ''),
    );

    const { text, isError } = await call(app.client, `panel.${timelineId}.set_kinds`, {
      kinds: ['churn', 'ticket'],
    });
    expect(isError, text).toBe(false);
    expect(JSON.parse(text)).toMatchObject({ kinds: ['churn', 'ticket'] });

    const after = Number(
      (app.rendered.getByTestId(`events-${timelineId}`).textContent ?? '').replace(/\D/g, ''),
    );
    expect(after, 'a filter must remove events, not merely relabel the panel').toBeLessThan(before);
    expect(app.rendered.getByTestId(`kinds-${timelineId}`).textContent).toContain('churn');
  });

  it('refuses a member outside the vocabulary, in the runtime', async () => {
    const { text, isError } = await call(app.client, `panel.${timelineId}.set_kinds`, {
      kinds: ['churn', 'meltdown'],
    });

    // The `enum` inside `items` is what catches this, and it is enforced before the handler — the
    // application never sees a list with an unknown member in it.
    expect(isError, 'an unknown event kind must be refused').toBe(true);
    // The refusal names the permitted set and never the value it received.
    expect(text).toContain('kinds');
    // The panel kept the last good filter rather than being left half-applied.
    expect(app.rendered.getByTestId(`kinds-${timelineId}`).textContent).toContain('churn');
  });

  it('clears the filter with an empty list rather than a missing argument', async () => {
    const { text, isError } = await call(app.client, `panel.${timelineId}.set_kinds`, {
      kinds: [],
    });
    expect(isError, text).toBe(false);
    expect(app.rendered.getByTestId(`kinds-${timelineId}`).textContent).toBe('every kind');
  });

  it('refuses a window outside the declared range and accepts one inside it', async () => {
    const zero = await call(app.client, `panel.${timelineId}.set_window`, { days: 0 });
    expect(zero.isError, 'a window of zero days must be refused').toBe(true);

    const fractional = await call(app.client, `panel.${timelineId}.set_window`, { days: 7.5 });
    expect(fractional.isError, 'a fractional number of days must be refused').toBe(true);

    const good = await call(app.client, `panel.${timelineId}.set_window`, { days: 7 });
    expect(good.isError, good.text).toBe(false);
    expect(app.rendered.getByTestId(`window-${timelineId}`).textContent).toContain('7 days');
  });
});

describe('a pipeline that changes data behind a confirmation', () => {
  it('puts the deals on the board twice, in two shapes', async () => {
    pipelineId = await add('pipeline', 'deals');
    dealsTableId = await add('table', 'deals');
    await untilListed(`panel.${pipelineId}.advance_deal`);

    // The same source, rendered two ways. That is what makes the next case's assertion meaningful: a
    // change made through the pipeline has to show up in a panel that knows nothing about it.
    expect(app.rendered.getByTestId(`card-${pipelineId}-Vantage migration`)).toBeTruthy();
    expect(app.rendered.getByTestId(`rows-${dealsTableId}`).textContent).toContain('8 rows');
  });

  it('waits for a person, then moves the deal everywhere it is shown', async () => {
    // Issued and NOT awaited: the confirmation resolves BEFORE the handler, so this parks.
    const inflight = call(app.client, `panel.${pipelineId}.advance_deal`, {
      deal: 'Vantage migration',
    });

    await until(
      () => app.rendered.queryByTestId('confirmation') !== null,
      'the confirmation prompt to appear',
    );
    fireEvent.click(app.rendered.getByText('Yes, do it'));

    const settled = await inflight;
    expect(settled.isError, settled.text).toBe(false);
    expect(JSON.parse(settled.text)).toMatchObject({
      ok: true,
      deal: 'Vantage migration',
      from: 'prospect',
      to: 'qualified',
    });

    // **The observable consequence, in the panel that was not asked.** The card is in the qualified
    // lane, and the table bound to the same source shows the new stage — a handler that reported
    // success while nothing moved is this project's characteristic defect.
    expect(
      app.rendered.getByTestId(`lane-${pipelineId}-qualified`).textContent,
      'the card must be in its new lane',
    ).toContain('Vantage migration');
    expect(app.rendered.getByTestId(`panel-${dealsTableId}`).textContent).toContain('qualified');
  });

  it('refuses a deal that has nowhere to go, as a RESULT', async () => {
    const inflight = call(app.client, `panel.${pipelineId}.advance_deal`, {
      deal: 'Larkfield upgrade',
    });
    await until(
      () => app.rendered.queryByTestId('confirmation') !== null,
      'the confirmation prompt to appear',
    );
    fireEvent.click(app.rendered.getByText('Yes, do it'));

    const settled = await inflight;
    // Approved by a person and still refused by the application: confirmation is not authorization, and
    // the reason travels as a result rather than as a thrown error the runtime would replace.
    expect(settled.isError, settled.text).toBe(false);
    const refusal = JSON.parse(settled.text) as { ok: boolean; refused: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.refused).toContain('won');
  });

  it('refuses a deal nobody has, and names what it does have', async () => {
    const inflight = call(app.client, `panel.${pipelineId}.advance_deal`, { deal: 'Atlantis' });
    await until(
      () => app.rendered.queryByTestId('confirmation') !== null,
      'the confirmation prompt to appear',
    );
    fireEvent.click(app.rendered.getByText('Yes, do it'));

    const refusal = JSON.parse((await inflight).text) as { ok: boolean; refused: string };
    expect(refusal.ok).toBe(false);
    expect(refusal.refused).toContain('Corvid pilot');
  });

  it('moves the same deal the same way when a person clicks instead', async () => {
    // **Parity, asserted rather than described.** The button calls the function the tool calls; if it
    // ever grew a second path, this is the case that would notice.
    fireEvent.click(app.rendered.getByTestId(`advance-${pipelineId}-Corvid pilot`));

    await until(
      () =>
        app.rendered
          .getByTestId(`lane-${pipelineId}-qualified`)
          .textContent?.includes('Corvid pilot') === true,
      'the card a person advanced to reach its new lane',
    );
    expect(app.rendered.getByTestId(`panel-${dealsTableId}`).textContent).toContain('qualified');
  });

  it('narrows to one stage without moving anything', async () => {
    const { text, isError } = await call(app.client, `panel.${pipelineId}.focus_stage`, {
      stage: 'proposal',
    });
    expect(isError, text).toBe(false);

    expect(app.rendered.getByTestId(`stage-${pipelineId}`).textContent).toBe('proposal');
    expect(app.rendered.queryByTestId(`lane-${pipelineId}-prospect`)).toBeNull();
    // Narrowing is a view change: the deal is off screen and still in the table.
    expect(app.rendered.getByTestId(`panel-${dealsTableId}`).textContent).toContain('Corvid pilot');
  });
});
