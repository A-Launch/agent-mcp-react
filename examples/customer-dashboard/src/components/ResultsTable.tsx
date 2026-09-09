import { useMcpTool } from '@agent-mcp/react';
import type { ReactNode } from 'react';
import type { Account } from '../domain/accounts.ts';
import { ACTOR, LABEL, SORT_FIELD, type SortField } from '../domain/vocabulary.ts';
import { useDashboard } from '../state/dashboard.tsx';
import { readSort } from '../state/filters.ts';

// The results table: the sortable header, the rows, and the three tools that drive it.
//
// `customers.list` is the tool that keeps an agent honest. It returns the rows that are ON SCREEN, in
// the order they are on screen, computed by the same function the table renders from — so an agent
// that summarises "the top five by ARR" is summarising what a person is looking at rather than its own
// idea of the dataset. It takes a `limit` because a page of forty-eight accounts is small and the next
// one will not be.

const COLUMNS: readonly SortField[] = [
  SORT_FIELD.name,
  SORT_FIELD.arr,
  SORT_FIELD.seats,
  SORT_FIELD.health,
  SORT_FIELD.renewalInDays,
  SORT_FIELD.openTickets,
];

const SORT_FIELDS = Object.values(SORT_FIELD);

/** The row shape an agent receives. A deliberate projection, not the account object. */
function forAgent(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    name: account.name,
    segment: account.segment,
    region: account.region,
    plan: account.plan,
    arr: account.arr,
    seats: account.seats,
    health: account.health,
    renewalInDays: account.renewalInDays,
    openTickets: account.openTickets,
    owner: account.owner,
  };
}

function renewal(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `${days}d`;
}

export function ResultsTable(): ReactNode {
  const dashboard = useDashboard();
  const { rows, sort } = dashboard;

  useMcpTool({
    name: 'customers.list',
    title: 'Read the visible rows',
    description:
      'Return the accounts currently shown in the table, in the order they are shown. Reflects the ' +
      'filters and sort in force right now; changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'How many rows to return, from the top. Defaults to 20.',
        },
      },
      additionalProperties: false,
    },
    handler: (input) => {
      // No type check: the declared schema says `limit` is a number, and the library refused the call
      // before this handler was entered if it was not. What remains is the domain clamp.
      const limit = Math.max(
        1,
        Math.min(Math.trunc((input.limit as number | undefined) ?? 20), 200),
      );
      return {
        // Reported rather than left implicit: an agent handed 20 of 48 rows with no count would
        // summarise a page it was only shown part of, and say so with confidence.
        showing: Math.min(limit, rows.length),
        matched: rows.length,
        sort,
        rows: rows.slice(0, limit).map(forAgent),
      };
    },
  });

  useMcpTool({
    name: 'customers.set_sort',
    title: 'Sort the table',
    description:
      'Order the table by one column. Either field or direction may be omitted to keep it.',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: SORT_FIELDS },
        direction: { type: 'string', enum: ['asc', 'desc'] },
      },
      additionalProperties: false,
    },
    handler: (input) => {
      const next = readSort(input, sort);
      dashboard.setSort(next, ACTOR.agent);
      return next;
    },
  });

  useMcpTool({
    name: 'customers.open_account',
    title: 'Open an account',
    description:
      'Open the detail drawer for one account, by id or by exact name. This is what a person does by ' +
      'clicking a row, and it is what makes the per-account tools available.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          minLength: 1,
          description: 'The account id (acct_007) or its exact name.',
        },
      },
      required: ['account'],
      additionalProperties: false,
    },
    handler: (input) => {
      // The schema establishes that `account` is a non-empty string. What it cannot establish is that
      // such an account EXISTS — that is domain knowledge, so it stays here, and it throws so the
      // runtime turns it into a tool error the agent can act on. A no-op would leave the agent calling
      // per-account tools that are not registered.
      const opened = dashboard.openAccount((input.account as string).trim(), ACTOR.agent);
      return { opened: forAgent(opened) };
    },
  });

  return (
    <div className="table-wrap">
      <table className="table" data-testid="results">
        <thead>
          <tr>
            {COLUMNS.map((field) => {
              const on = sort.field === field;
              return (
                <th key={field} scope="col" className={on ? 'sorted' : undefined}>
                  <button type="button" onClick={() => dashboard.toggleSort(field, ACTOR.person)}>
                    {LABEL[field]}
                    <span className="caret">
                      {on ? (sort.direction === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="empty">
                No account matches these filters.
              </td>
            </tr>
          ) : (
            rows.map((account) => (
              <tr
                key={account.id}
                className={dashboard.selected?.id === account.id ? 'row selected' : 'row'}
                onClick={() => dashboard.openAccount(account.id, ACTOR.person)}
              >
                <td>
                  {/*
                    **A real button, not a clickable row.** The row's `onClick` above is a pointer
                    convenience and was, until this change, the ONLY way to open an account: a `<tr>`
                    has no tab stop and no Enter handling, so a keyboard could not reach the drawer at
                    all — while the agent could, through `customers.open_account`. This page's own
                    subtitle says everything an agent can do here a person can do too, and that was
                    false for anybody not using a mouse.
                    The fix is a control that is genuinely one, rather than `role="button"` and a
                    tabIndex bolted onto a table row: a fake button has to reimplement Enter, Space and
                    the focus ring that a real one brings for free.
                  */}
                  <button
                    type="button"
                    className="row-open"
                    onClick={() => dashboard.openAccount(account.id, ACTOR.person)}
                    aria-current={dashboard.selected?.id === account.id ? 'true' : undefined}
                  >
                    <span className="row-name">{account.name}</span>
                    <span className="row-sub">
                      {LABEL[account.segment]} · {LABEL[account.region]} · {LABEL[account.plan]}
                    </span>
                  </button>
                </td>
                <td className="num">${account.arr.toLocaleString('en-US')}</td>
                <td className="num">{account.seats.toLocaleString('en-US')}</td>
                <td>
                  <span className={`pill pill-${account.health}`}>{LABEL[account.health]}</span>
                </td>
                <td className={account.renewalInDays < 0 ? 'num overdue' : 'num'}>
                  {renewal(account.renewalInDays)}
                </td>
                <td className="num">{account.openTickets}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
