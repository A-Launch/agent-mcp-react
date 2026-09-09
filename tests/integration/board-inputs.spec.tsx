import { fireEvent } from '@testing-library/react/pure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BoardApplication, call, startBoard, stopBoard, until } from './board-harness.tsx';

// User story 4: the agent proposes, a person submits, and a secret field is never readable.
//
// **The secret value is checked against EVERYTHING the agent received**, accumulated across the whole
// file rather than per assertion. A case that only inspected one response would pass while the value
// leaked through another — and the leak that matters is the one nobody thought to look at.
//
// The omission case also asserts the POSITIVE half: a non-secret field's value IS reported. Without it
// the case would pass just as well against a `getState` that returned nothing at all, which is the
// instrument-cannot-fail shape this repository has been caught building before.

const ADD = 'board.add_panel';
const STATE = 'board.get_state';

/** Distinctive enough that finding it anywhere is unambiguous. */
const SECRET = 'hunter2-do-not-disclose';
const ACCOUNT = 'Zenith Aerospace';

let app: BoardApplication;
let formId = '';
let tableId = '';

/** Everything the agent has been told, in this file, ever. */
const everythingTheAgentSaw: string[] = [];

async function agentCall(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const outcome = await call(app.client, name, args);
  everythingTheAgentSaw.push(outcome.text);
  return outcome;
}

beforeAll(async () => {
  app = await startBoard();

  const created = await agentCall(ADD, {
    panels: [
      { kind: 'form', source: 'accounts' },
      { kind: 'table', source: 'accounts' },
    ],
  });
  const result = JSON.parse(created.text) as { created: { id: string; kind: string }[] };
  formId = result.created.find((panel) => panel.kind === 'form')?.id ?? '';
  tableId = result.created.find((panel) => panel.kind === 'table')?.id ?? '';

  await until(
    async () => (await app.client.listTools()).tools.some((t) => t.name === `panel.${formId}.fill`),
    'the form’s own actions to reach the agent',
  );
});

afterAll(async () => {
  await stopBoard();
});

describe('an agent filling a form a person has to submit', () => {
  it('sets the fields and creates nothing', async () => {
    const { text, isError } = await agentCall(`panel.${formId}.fill`, {
      name: ACCOUNT,
      owner_email: 'ada@zenith.test',
      plan: 'enterprise',
      initial_password: SECRET,
    });
    expect(isError, text).toBe(false);

    // The result names WHICH fields were filled and no values — uniformly, so the shape does not vary
    // by secrecy.
    expect(JSON.parse(text)).toEqual({
      filled: ['name', 'owner_email', 'plan', 'initial_password'],
    });

    // The values are on the screen for a person.
    const nameField = app.rendered.getByTestId(`field-${formId}-name`) as HTMLInputElement;
    const secretField = app.rendered.getByTestId(
      `field-${formId}-initial_password`,
    ) as HTMLInputElement;
    expect(nameField.value).toBe(ACCOUNT);
    expect(secretField.value).toBe(SECRET);

    // And nothing was created. Filling is not submitting.
    const rows = app.rendered.getByTestId(`rows-${tableId}`).textContent ?? '';
    expect(rows).toContain('24 rows');
  });

  it('reports a non-secret field’s value and OMITS the secret field’s key entirely', async () => {
    const { text } = await agentCall(STATE);
    const state = JSON.parse(text) as {
      panels: { id: string; settings: { fields?: Record<string, unknown>[] } }[];
    };
    const form = state.panels.find((panel) => panel.id === formId);
    const fields = form?.settings.fields ?? [];

    const owner = fields.find((field) => field.name === 'owner_email');
    const secret = fields.find((field) => field.name === 'initial_password');

    // **The positive half.** Without it this case would pass against a `getState` that reported nothing.
    expect(owner).toMatchObject({ value: 'ada@zenith.test', filled: true });

    // **The negative half, asserted as ABSENCE of the key.** Not `"***"`, not `null`, not `""` — a
    // placeholder is itself a value that can be read back and echoed into a fill, and it discloses that
    // the field is set.
    expect(secret).toMatchObject({ name: 'initial_password', filled: true });
    expect(Object.hasOwn(secret ?? {}, 'value'), 'the secret field must have NO value key').toBe(
      false,
    );
  });

  it('leaves the form unsubmitted when a person declines', async () => {
    const before = app.rendered.getByTestId(`rows-${tableId}`).textContent ?? '';

    // Issued and NOT awaited: the confirmation resolves BEFORE the handler, so the call is parked until
    // a person answers.
    const inflight = agentCall(`panel.${formId}.submit`);

    await until(
      () => app.rendered.queryByTestId('confirmation') !== null,
      'the confirmation prompt to appear',
    );

    // **If this prompt never appears the page is not instrumented** — it is not that the agent did not
    // try. With the dialog wired and the resolver not, every call is refused
    // `MCP_TOOL_CONFIRMATION_UNAVAILABLE` and no prompt is ever shown. That fails safe, which is exactly
    // why only a live run or this case catches it.
    fireEvent.click(app.rendered.getByText('No'));

    const settled = await inflight;
    expect(settled.isError, 'a declined confirmation must settle as a refusal').toBe(true);

    // And nothing was created.
    expect(app.rendered.getByTestId(`rows-${tableId}`).textContent).toBe(before);
  });

  it('creates the account when a person approves, and the table bound to accounts shows it', async () => {
    const inflight = agentCall(`panel.${formId}.submit`);

    await until(
      () => app.rendered.queryByTestId('confirmation') !== null,
      'the confirmation prompt to appear',
    );
    fireEvent.click(app.rendered.getByText('Yes, do it'));

    const settled = await inflight;
    expect(settled.isError, settled.text).toBe(false);
    expect(JSON.parse(settled.text)).toMatchObject({ ok: true, created: ACCOUNT });

    // **The observable consequence.** A submission that reported success while no row appeared is the
    // false-success shape this project treats as its characteristic defect — and it is why the account
    // list is mutable rather than a constant.
    expect(app.rendered.getByTestId(`rows-${tableId}`).textContent).toContain('25 rows');
    expect(app.rendered.getByTestId(`panel-${tableId}`).textContent).toContain(ACCOUNT);
  });

  it('refuses an incomplete submission by naming the fields, never the values', async () => {
    // The form emptied itself on submission, so this one is genuinely incomplete.
    const { isError: fillFailed } = await agentCall(`panel.${formId}.fill`, {
      initial_password: SECRET,
    });
    expect(fillFailed).toBe(false);

    const inflight = agentCall(`panel.${formId}.submit`);
    await until(
      () => app.rendered.queryByTestId('confirmation') !== null,
      'the confirmation prompt to appear',
    );
    fireEvent.click(app.rendered.getByText('Yes, do it'));

    const settled = await inflight;
    const refusal = JSON.parse(settled.text) as { ok: boolean; refused: string };

    expect(refusal.ok).toBe(false);
    expect(refusal.refused, 'a refusal must name the fields at fault').toContain('name');
    expect(refusal.refused).toContain('owner_email');
    expect(refusal.refused, 'and must never carry a received value').not.toContain(SECRET);
  });

  it('never disclosed the secret value in ANYTHING the agent received', () => {
    // The whole file's traffic, checked once. A per-response assertion would pass while the value
    // leaked through a response nobody thought to look at.
    const everything = everythingTheAgentSaw.join('\n');

    expect(everything.length, 'the agent must actually have received something').toBeGreaterThan(
      200,
    );
    expect(everything).toContain('ada@zenith.test');
    expect(everything, 'the secret value must appear nowhere at all').not.toContain(SECRET);
  });
});
