import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AgentStatus,
  fetchStatus,
  fetchTools,
  type PageTool,
  resetChat,
  streamChat,
} from './agent.ts';
import { ToolConsole } from './components/ToolConsole.tsx';
import { Transcript } from './components/Transcript.tsx';
import { type Entry, failed, fold, personSaid } from './transcript.ts';

// The chat page: the agent's face, on the other side of the desk from the dashboard.
//
// **Nothing on this page is instrumented.** It imports no part of `@agent-mcp/react`, mounts no
// provider, registers no tool and opens no WebSocket. The socket belongs to the dashboard, which
// dialled outward to the agent process; this page is an ordinary HTTP client of that same process.
// That separation is the architecture, not a simplification: the MCP client has to live where the
// socket is held, and a client here would be a second agent looking at a different page.
//
// What it shows, and why each part is on screen:
//   - The model, named, or the exact reason there is none. Never a chat that silently does nothing.
//   - Which browser tab the agent is acting on. A session that quietly targeted an arbitrary tab
//     would be the silent success this project treats as a defect.
//   - Every tool call in full, beside the agent's prose about it, so the account can be checked.

const SESSION = 'chat';

const SUGGESTIONS = [
  'What am I looking at?',
  'Show me enterprise accounts in EMEA that are at risk, biggest first.',
  'Which of those renews within 60 days?',
  'Open the largest one and tell me why it might be at risk.',
  'Mark it churning — the sponsor left. Then save this view as "EMEA fire drill".',
] as const;

export function App(): ReactNode {
  const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [tools, setTools] = useState<readonly PageTool[]>([]);
  const [toolsError, setToolsError] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // The tab the agent acts on. Read from the runtime rather than assumed: with no tab connected there
  // is nothing to act on, and saying so beats sending a message that fails at the far end.
  const tab = status?.tabs.find((entry) => entry.state === 'ready')?.tabId ?? null;
  const ready = status?.tabs.some((entry) => entry.state === 'ready') === true;

  const readStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchStatus());
      setStatusError(undefined);
    } catch (cause) {
      setStatusError(
        cause instanceof Error
          ? `${cause.message} — is \`pnpm dev:agent\` running on :45000?`
          : String(cause),
      );
    }
  }, []);

  const readTools = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      setTools(await fetchTools(tab));
      setToolsError(undefined);
    } catch (cause) {
      setTools([]);
      setToolsError(cause instanceof Error ? cause.message : String(cause));
    }
    setRefreshing(false);
  }, [tab]);

  // Polled, and deliberately so. Whether a tab is connected is state held in another process, and
  // there is no channel from it to here — a page that showed a one-time reading would keep claiming
  // "no dashboard" long after one opened.
  useEffect(() => {
    void readStatus();
    const timer = setInterval(() => void readStatus(), 3_000);
    return () => clearInterval(timer);
  }, [readStatus]);

  useEffect(() => {
    if (ready) void readTools();
  }, [ready, readTools]);

  // Follows the conversation as it grows. Keyed on the COUNT rather than the array: the array is
  // replaced on every event, including the one that only fills in a tool result, and scrolling on
  // each of those fights a person who has scrolled up to read an earlier call.
  const bottom = useRef<HTMLDivElement | null>(null);
  const turnCount = entries.length;
  useEffect(() => {
    if (turnCount === 0) return;
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turnCount]);

  const send = async (text: string): Promise<void> => {
    if (text.trim() === '' || busy) return;
    setDraft('');
    setEntries((current) => [...current, personSaid(text)]);
    setBusy(true);
    try {
      for await (const event of streamChat(SESSION, text, tab)) {
        setEntries((current) => fold(current, event));
      }
      // The page's tool set may have changed during the turn — opening an account drawer registers
      // three more. Re-read once the turn ends so the console beside the chat is not stale.
      void readTools();
    } catch (cause) {
      setEntries((current) => [
        ...current,
        failed(cause instanceof Error ? cause.message : String(cause)),
      ]);
    }
    setBusy(false);
  };

  const clear = async (): Promise<void> => {
    await resetChat(SESSION);
    setEntries([]);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Agent chat</h1>
          <p className="hint">
            Driving <a href="http://localhost:45010">the customer book</a> on :45010 through its own
            MCP tools.
          </p>
        </div>
        <div className="badges">
          <span className={`badge ${status?.model.available === true ? 'badge-ok' : 'badge-off'}`}>
            {status === undefined
              ? 'checking the agent…'
              : status.model.available
                ? `model · ${status.model.name}`
                : 'no model'}
          </span>
          <span className={`badge ${ready ? 'badge-ok' : 'badge-off'}`}>
            {ready ? `tab · ${tab ?? '(unnamed)'}` : 'no dashboard connected'}
          </span>
          <button
            type="button"
            className="link-button"
            onClick={() => void clear()}
            disabled={busy}
          >
            New conversation
          </button>
        </div>
      </header>

      {statusError === undefined ? null : <p className="banner banner-bad">{statusError}</p>}

      {status !== undefined && !status.model.available ? (
        <p className="banner">
          <strong>No model is configured.</strong> {status.model.reason}
        </p>
      ) : null}

      {status !== undefined && !ready && statusError === undefined ? (
        <p className="banner">
          No dashboard is connected. Open <a href="http://localhost:45010">localhost:45010</a> — the
          page dials this agent when it mounts.
        </p>
      ) : null}

      <div className="page-body">
        <main className="chat">
          <div className="scroll">
            <Transcript entries={entries} busy={busy} />
            <div ref={bottom} />
          </div>

          {entries.length === 0 ? (
            <div className="suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  disabled={!ready || status?.model.available !== true}
                  onClick={() => void send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <input
              type="text"
              value={draft}
              placeholder={
                status?.model.available === true
                  ? 'Ask the agent to change the page'
                  : 'Set ANTHROPIC_API_KEY on the agent to chat — or call a tool by hand on the right'
              }
              disabled={busy || !ready || status?.model.available !== true}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={busy || draft.trim() === '' || !ready}>
              Send
            </button>
          </form>
        </main>

        <ToolConsole
          tools={tools}
          tab={tab}
          onRefresh={() => void readTools()}
          refreshing={refreshing}
          error={toolsError}
        />
      </div>
    </div>
  );
}
