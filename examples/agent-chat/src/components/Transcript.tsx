import type { ReactNode } from 'react';
import { ENTRY, type Entry } from '../transcript.ts';

// The conversation, rendered.
//
// A tool call is shown in full — name, the exact arguments the model chose, and what the page sent
// back — rather than summarised. That is the point of this page: the prose is the agent's account of
// what it did, and the card underneath it is what actually crossed the socket. A chat that showed only
// the prose would be asking the reader to take the agent's word for it.

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function ToolCall({ entry }: { entry: Entry }): ReactNode {
  const state = entry.result === undefined ? 'running' : entry.result.ok ? 'ok' : 'refused';

  return (
    <div className={`call call-${state}`}>
      <header className="call-head">
        <code className="call-name">{entry.name}</code>
        <span className={`call-state state-${state}`}>{state}</span>
      </header>
      <pre className="call-args">{pretty(entry.args ?? {})}</pre>
      {entry.result === undefined ? (
        <p className="call-waiting">waiting for the page…</p>
      ) : (
        <pre className="call-result">{entry.result.text}</pre>
      )}
    </div>
  );
}

export function Transcript({
  entries,
  busy,
}: {
  readonly entries: readonly Entry[];
  readonly busy: boolean;
}): ReactNode {
  if (entries.length === 0) {
    return (
      <div className="empty-state">
        <h2>Ask the agent to change the page.</h2>
        <p>
          It can only act through the tools the dashboard registered — the same functions that
          page’s own controls call. Try one of the suggestions below.
        </p>
      </div>
    );
  }

  return (
    <ol className="transcript" data-testid="transcript">
      {entries.map((entry) => {
        if (entry.kind === ENTRY.call) {
          return (
            <li key={entry.key} className="turn turn-call">
              <ToolCall entry={entry} />
            </li>
          );
        }
        if (entry.kind === ENTRY.status) {
          return (
            <li key={entry.key} className="turn turn-status">
              <span className="spinner" aria-hidden="true" />
              {entry.text}
            </li>
          );
        }
        return (
          <li key={entry.key} className={`turn turn-${entry.kind}`}>
            <span className="who">
              {entry.kind === ENTRY.person ? 'you' : entry.kind === ENTRY.agent ? 'agent' : 'error'}
            </span>
            <div className="said">{entry.text}</div>
          </li>
        );
      })}
      {busy && entries.every((entry) => entry.kind !== ENTRY.status) ? (
        <li className="turn turn-status">
          <span className="spinner" aria-hidden="true" />
          working
        </li>
      ) : null}
    </ol>
  );
}
