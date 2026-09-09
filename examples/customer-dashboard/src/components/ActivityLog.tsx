import type { ReactNode } from 'react';
import { ACTOR } from '../domain/vocabulary.ts';
import { useDashboard } from '../state/dashboard.tsx';

// The activity log: every transition the dashboard made, newest first, labelled with who caused it.
//
// It registers no tool. That is deliberate — the log is the evidence a person reads to check the
// claim this whole example makes, and a tool that could write to it would be a way for an agent to
// describe its own behaviour rather than have it recorded.
//
// Entries are written by the dashboard's transitions themselves, which is why a person's click and an
// agent's call appear in the same list in the order they actually happened. Two lists, or an
// agent-only feed, would let the two drift and would hide precisely the interleaving worth watching.

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour12: false });
}

export function ActivityLog(): ReactNode {
  const dashboard = useDashboard();

  const latest = dashboard.activity[0];

  return (
    <section className="activity" aria-label="Activity">
      {/*
        **The one place agent-driven change is ANNOUNCED, not merely displayed.**

        Everything on this page is visual: the table narrows, a pill changes colour, the drawer opens.
        A sighted person sees an agent act. A screen-reader user was told nothing at all — the DOM
        changed silently, and the whole claim this demonstrator makes ("everything an agent can do
        here, a person can do too") quietly excluded them from noticing it had happened.

        Fed by the activity log rather than by each component, which is why one region covers every
        transition: the dashboard records an entry for every mutation it makes, by either actor, so
        anything that can change the page passes through here. A region per feature would announce
        whatever its author remembered.

        `polite` rather than `assertive`: an agent filtering a table is worth knowing about and is not
        worth interrupting a sentence for. The confirmation dialog is where an agent's action becomes
        urgent, and that is an `alertdialog` already.
      */}
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {latest === undefined
          ? ''
          : `${latest.actor === ACTOR.agent ? 'Agent' : 'You'}: ${latest.summary}`}
      </p>
      <h3>Activity</h3>
      {dashboard.activity.length === 0 ? (
        <p className="muted">Nothing has changed yet.</p>
      ) : (
        <ol className="activity-list" data-testid="activity">
          {dashboard.activity.map((entry) => (
            <li key={entry.id} className={`activity-item actor-${entry.actor}`}>
              <span className="activity-actor">
                {entry.actor === ACTOR.agent ? 'agent' : 'person'}
              </span>
              <span className="activity-summary">{entry.summary}</span>
              <span className="activity-time">{clock(entry.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
