import { useMcpTool } from '@agent-mcp/react';
import { type ReactNode, useState } from 'react';
import { ACTOR } from '../domain/vocabulary.ts';
import { useDashboard } from '../state/dashboard.tsx';

// Saved views: a name for the current filters and sort, and the two tools that store and recall them.
//
// This is the part of the demonstration that shows an agent building on its own earlier work. It saves
// a view, filters somewhere else, and comes back — through the same store the person's "Save view"
// button writes to, so a view an agent saved is one a person can click.
//
// **It is also where `permissions.available` is demonstrated**, on the one tool here that genuinely
// has nothing to do until something else has happened: there is no view to restore until a view has
// been saved. An agent connected to an empty dashboard does not see `views.apply` at all, and it
// appears the moment the first view is stored — by the ordinary React lifetime of a value in the
// store, with nothing in this application managing a tool list.

export function SavedViews(): ReactNode {
  const dashboard = useDashboard();
  const [draft, setDraft] = useState('');
  const saved = dashboard.current().views;

  useMcpTool({
    name: 'views.save',
    title: 'Save the current view',
    description:
      'Store the filters and sort currently in force under a name, so they can be restored later. ' +
      'Saving over an existing name replaces it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'What to call this view.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (input) => {
      const view = dashboard.saveView(input.name as string, ACTOR.agent);
      return { saved: view.name, filters: view.filters, sort: view.sort };
    },
  });

  useMcpTool({
    name: 'views.apply',
    title: 'Restore a saved view',
    description: 'Replace the current filters and sort with a previously saved view.',
    // Offered only once there is something to restore. It costs no registry churn: availability lives
    // on the ownership record, so this changes as often as the store does without the tool being
    // withdrawn and re-registered.
    //
    // **The handler's own check below stays, and that is the point rather than duplication.** A
    // permission governs this library's bridge: `views.apply` is still in the document's shared
    // registry with no views saved, and any script in this page still reaches it. Moving the check out
    // of the handler would stop enforcing it for every caller that is not the agent.
    permissions: { available: saved.length > 0 },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The name the view was saved under.' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (input, context) => {
      // Existence is domain knowledge a schema cannot carry, so this check stays: an agent that
      // invented a view name learns so immediately rather than believing a restore happened.
      const view = dashboard.applyView(input.name as string, ACTOR.agent);
      // Answered from what the table actually shows, after the commit
      // (docs/design.md#a-call-settles-after-the-commit) — not from a second run of
      // the selection against the view's filters, which is what this used to do.
      await context.afterRender();
      return { applied: view.name, matched: dashboard.current().totals.matched };
    },
  });

  const submit = (): void => {
    if (draft.trim() === '') return;
    dashboard.saveView(draft, ACTOR.person);
    setDraft('');
  };

  return (
    <section className="views" aria-label="Saved views">
      <h3>Saved views</h3>
      <div className="note-compose">
        <input
          type="text"
          className="text-input"
          value={draft}
          placeholder="Name this view"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button type="button" onClick={submit} disabled={draft.trim() === ''}>
          Save
        </button>
      </div>
      {dashboard.views.length === 0 ? (
        <p className="muted">Nothing saved yet.</p>
      ) : (
        <div className="chips" data-testid="views">
          {dashboard.views.map((view) => (
            <button
              key={view.name}
              type="button"
              className="chip"
              onClick={() => dashboard.applyView(view.name, ACTOR.person)}
            >
              {view.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
