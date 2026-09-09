import { useMcpTool } from 'agent-mcp-react';
import { type ReactNode, useState } from 'react';
import type { Account } from '../domain/accounts.ts';
import { ACTOR, HEALTH, type Health, LABEL } from '../domain/vocabulary.ts';
import { useDashboard } from '../state/dashboard.tsx';

// The account drawer, and the three tools that exist only while it is open.
//
// **This component is the lifecycle demonstration.** It is mounted only when an account is selected,
// so `account.set_health`, `account.add_note` and `account.close` appear in the page's tool list when
// a row is opened and are gone from it when the drawer closes — by the ordinary React lifetime of the
// component, with nothing in the application managing registration.
//
// The tools act on the OPEN account and take no account argument, which is the same authority a person
// has here: the drawer edits what the drawer is showing. An agent that wants to edit a different
// account calls `customers.open_account` first, exactly as a person clicks a different row.
//
// What an agent watching from outside sees: the derived listing is correct whenever it is asked for,
// so a client that re-lists sees this set appear and disappear — and it does not have to guess when
// to, because a change to the agent-visible tool set sends `notifications/tools/list_changed`. A
// client that listed once is told rather than left working from a set it cached.

const HEALTHS = Object.values(HEALTH);

export function AccountDetail({ account }: { account: Account }): ReactNode {
  const dashboard = useDashboard();
  const [draft, setDraft] = useState('');
  const notes = dashboard.notesFor(account.id);

  useMcpTool({
    name: 'account.set_health',
    title: 'Change the open account’s health',
    // A person approves this one before it happens. It rewrites a judgement about a customer
    // relationship and records it against the agent, so it is the kind of change somebody should have
    // seen — and it is the demonstration of a confirmation that is resolved BEFORE the handler, never
    // by undoing an applied effect afterwards.
    //
    // With no resolver on the provider, this tool stays listed and every call to it is refused: what
    // would be true of such a deployment is "it cannot be approved here", not "it does not exist".
    permissions: { confirmation: 'required' },
    description:
      'Set the relationship health of the account whose drawer is open. Open a different account ' +
      'first to change that one. This is the same control a person uses in the drawer.',
    inputSchema: {
      type: 'object',
      properties: {
        health: { type: 'string', enum: HEALTHS, description: 'The new health value.' },
        // Asked for as well as confirmed, and the two do different jobs. The confirmation puts a
        // person in the loop; the reason is what the activity log will show afterwards, to somebody
        // who was not.
        reason: {
          type: 'string',
          minLength: 1,
          description: 'Why it is changing. Recorded as a note.',
        },
      },
      required: ['health', 'reason'],
      additionalProperties: false,
    },
    handler: (input) => {
      // The schema declares `health` as one of the four values and `reason` as a required string with
      // a minimum length, so both checks that used to live here are gone.
      const health = input.health as Health;
      const reason = input.reason as string;
      const before = account.health;
      dashboard.setHealth(account.id, health, ACTOR.agent);
      dashboard.addNote(account.id, `health ${before} → ${health}: ${reason.trim()}`, ACTOR.agent);
      return { account: account.name, from: before, to: health };
    },
  });

  useMcpTool({
    name: 'account.add_note',
    title: 'Add a note to the open account',
    description: 'Append a note to the account whose drawer is open.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', minLength: 1, description: 'The note text.' } },
      required: ['note'],
      additionalProperties: false,
    },
    handler: (input) => {
      const count = dashboard.addNote(account.id, input.note as string, ACTOR.agent);
      return { account: account.name, notes: count };
    },
  });

  useMcpTool({
    name: 'account.close',
    title: 'Close the account drawer',
    description:
      'Close the open drawer and return to the list. The per-account tools go away with it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => {
      dashboard.closeAccount(ACTOR.agent);
      return { closed: account.name };
    },
  });

  const submit = (): void => {
    if (draft.trim() === '') return;
    dashboard.addNote(account.id, draft, ACTOR.person);
    setDraft('');
  };

  return (
    <section className="drawer" aria-label={`Account ${account.name}`} data-testid="drawer">
      <header className="drawer-head">
        <div>
          <h2 data-testid="drawer-name">{account.name}</h2>
          <p className="drawer-sub">
            {LABEL[account.segment]} · {LABEL[account.region]} · {LABEL[account.plan]} ·{' '}
            {account.owner}
          </p>
        </div>
        <button
          type="button"
          className="link-button"
          onClick={() => dashboard.closeAccount(ACTOR.person)}
        >
          Close
        </button>
      </header>

      <dl className="drawer-facts">
        <div>
          <dt>ARR</dt>
          <dd>${account.arr.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Seats</dt>
          <dd>{account.seats.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Renewal</dt>
          <dd>
            {account.renewalInDays < 0
              ? `${Math.abs(account.renewalInDays)}d overdue`
              : `${account.renewalInDays}d`}
          </dd>
        </div>
        <div>
          <dt>Open tickets</dt>
          <dd>{account.openTickets}</dd>
        </div>
      </dl>

      <div className="field">
        <span className="field-label">Health</span>
        <div className="chips">
          {HEALTHS.map((health: Health) => (
            <button
              key={health}
              type="button"
              className={account.health === health ? 'chip chip-on' : 'chip'}
              aria-pressed={account.health === health}
              onClick={() => dashboard.setHealth(account.id, health, ACTOR.person)}
            >
              {LABEL[health]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">Notes</span>
        {notes.length === 0 ? (
          <p className="muted">No notes yet.</p>
        ) : (
          <ul className="notes" data-testid="notes">
            {notes.map((note, index) => (
              // Keyed by position as well as text: two identical notes are a legitimate thing to
              // write, and text alone would collide.
              <li key={`${String(index)}:${note}`}>{note}</li>
            ))}
          </ul>
        )}
        <div className="note-compose">
          <input
            type="text"
            className="text-input"
            value={draft}
            placeholder="Add a note"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <button type="button" onClick={submit} disabled={draft.trim() === ''}>
            Add
          </button>
        </div>
      </div>
    </section>
  );
}
