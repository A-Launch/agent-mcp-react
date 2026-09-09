import { useMcpTool } from 'agent-mcp-react';
import type { ReactNode } from 'react';
import { ACTOR, HEALTH, LABEL } from '../domain/vocabulary.ts';
import { useDashboard } from '../state/dashboard.tsx';
import { activeFilterNames } from '../state/filters.ts';

// The aggregate strip above the table, and the one read tool that describes the whole page.
//
// `dashboard.describe` is the tool an agent calls FIRST, and it exists because the alternative is an
// agent that guesses. It reports the active filters, the sort, the counts and the open drawer — the
// same numbers rendered below it, from the same computation, so the answer an agent gets and the
// answer a person reads cannot disagree.
//
// It is a read: it calls no transition and appears nowhere in the activity log. Nothing in this
// library distinguishes a read from a write — there is no risk level a tool can declare — so that
// separation is the application's discipline here rather than something the runtime enforces.

const HEALTHS = Object.values(HEALTH);

function money(value: number): string {
  return `$${value.toLocaleString('en-US')}`;
}

export function SummaryBar(): ReactNode {
  const dashboard = useDashboard();
  const { totals, filters, sort } = dashboard;

  useMcpTool({
    name: 'dashboard.describe',
    title: 'Describe what is on screen',
    description:
      'Report the dashboard as it currently stands: which filters are applied, how the table is ' +
      'sorted, how many accounts match, the totals for those accounts, and which account drawer is ' +
      'open. Reads only; changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // **The one tool here that promises a shape.** An agent receives this as structured data as well
    // as text, so it reads `matched` as a number rather than parsing it out of a string and hoping.
    // The promise is enforced: a handler that returned something else would be refused rather than
    // forwarded, because a tool that lies about its own output is worse than one that fails.
    outputSchema: {
      type: 'object',
      properties: {
        matched: { type: 'number' },
        of: { type: 'number' },
        totalArr: { type: 'number' },
        totalSeats: { type: 'number' },
        openTickets: { type: 'number' },
        activeFilters: { type: 'array', items: { type: 'string' } },
        openAccount: { type: ['string', 'null'] },
        savedViews: { type: 'array', items: { type: 'string' } },
      },
      required: ['matched', 'of', 'activeFilters'],
    },
    handler: () => ({
      filters,
      activeFilters: activeFilterNames(filters),
      sort,
      matched: totals.matched,
      of: totals.total,
      totalArr: totals.arr,
      totalSeats: totals.seats,
      openTickets: totals.openTickets,
      byHealth: totals.byHealth,
      openAccount: dashboard.selected?.name ?? null,
      savedViews: dashboard.views.map((view) => view.name),
    }),
  });

  useMcpTool({
    name: 'dashboard.audit_accounts',
    title: 'Run a slow audit over the matching accounts',
    description:
      'Walk the accounts currently in view one at a time, as a slow back-office job would. Takes ' +
      'several seconds and reports how far it got. No account is modified; the walk does write one ' +
      'line to the activity feed when it ends, so a person can see it finish or stop. Safe to ' +
      'cancel at any time.',
    inputSchema: {
      type: 'object',
      properties: {
        msPerAccount: {
          type: 'number',
          description: 'How long to spend on each account. Defaults to 400.',
          minimum: 1,
          maximum: 5_000,
        },
      },
      additionalProperties: false,
    },
    // **The cancellable one** (docs/design.md#cancellation). Every other tool here finishes before an
    // agent could change its
    // mind, so none of them demonstrates the thing the library actually guarantees.
    //
    // The signal is respected, which is what a handler SHOULD do. It is worth being precise
    // about what that buys, because the guarantee does not depend on it: a handler that ignored the
    // signal would still have its CALL settled — the runtime races it — but it would keep walking
    // accounts after the agent had been told the call was over. Respecting it is how an application
    // stops doing work nobody wants, not how the agent is kept honest.
    handler: async (input, context) => {
      const pace = typeof input.msPerAccount === 'number' ? input.msPerAccount : 400;
      const inView = dashboard.rows;
      let audited = 0;

      // **One listener for the whole walk, not one per account.**
      //
      // The obvious shape adds an `{ once: true }` abort listener inside the loop. `once` removes it
      // when it FIRES — and on a call that completes normally it never fires, so every one of them
      // stays attached for the life of the tool's declaration. The signal here is composed with that
      // declaration lifetime, so nothing collects them in between: a page that runs this audit a few
      // times accumulates listeners in proportion to accounts × calls.
      //
      // A single promise that every step waits on has the same effect and attaches once.
      let wake: (() => void) | undefined;
      const cancelled = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const onAbort = (): void => wake?.();
      context.signal.addEventListener('abort', onAbort, { once: true });

      try {
        for (const account of inView) {
          if (context.signal.aborted) break;
          // Whichever comes first: the pace elapsing, or the call being cancelled. Waiting only on the
          // timer would finish the current account before noticing, which on a slow pace is the
          // difference between stopping now and stopping in half a second.
          await Promise.race([
            new Promise<void>((resolve) => setTimeout(resolve, pace)),
            cancelled,
          ]);
          if (context.signal.aborted) break;
          audited += 1;
          void account;
        }
      } finally {
        context.signal.removeEventListener('abort', onAbort);
      }

      const completed = audited === inView.length;
      // **Written to the page, so cancellation is visible to a person watching.** From a browser
      // window it otherwise is not: when the agent cancels, its own client has already stopped
      // listening and the protocol layer discards whatever this returns, so the call would simply
      // stop existing with nothing to see.
      dashboard.noteActivity(
        completed
          ? `audit · finished ${String(audited)} of ${String(inView.length)}`
          : `audit · cancelled after ${String(audited)} of ${String(inView.length)}`,
        ACTOR.agent,
      );
      return { audited, of: inView.length, completed };
    },
  });

  return (
    <div className="summary" data-testid="summary">
      <div className="summary-stat">
        <span className="stat-value" data-testid="matched">
          {totals.matched}
        </span>
        <span className="stat-label">of {totals.total} accounts</span>
      </div>
      <div className="summary-stat">
        <span className="stat-value">{money(totals.arr)}</span>
        <span className="stat-label">ARR in view</span>
      </div>
      <div className="summary-stat">
        <span className="stat-value">{totals.seats.toLocaleString('en-US')}</span>
        <span className="stat-label">seats</span>
      </div>
      <div className="summary-stat">
        <span className="stat-value">{totals.openTickets}</span>
        <span className="stat-label">open tickets</span>
      </div>
      <div className="summary-health">
        {HEALTHS.map((health) => (
          <span key={health} className={`pill pill-${health}`}>
            {totals.byHealth[health]} {LABEL[health]}
          </span>
        ))}
      </div>
      <div className="summary-sort">
        sorted by <strong>{LABEL[sort.field]}</strong> {sort.direction}
      </div>
    </div>
  );
}
