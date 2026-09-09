import { useMcpTabId } from '@agent-mcp/react';
import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { resetChat, streamChat } from '../agent-client.ts';

// The left pane: the conversation, and every action the agent took while having it.
//
// **This pane is not how the agent reaches the board, and that separation is deliberate.** The page has
// two independent channels to the same local process: this HTTP conversation, and the MCP socket the
// provider holds. Neither is built on the other, and a board change is visible whether it came from
// here, from the toolbar, or from an agent acting with no conversation at all.
//
// **The tool log renders the panel ids.** A panel appearing on screen has to be attributable to
// something a person can point at, and the id is the only thing that makes "the agent added this one"
// checkable rather than assumed.
//
// What this component owns: the transcript and the send/reset controls. It owns no board state, decides
// no tool call, and interprets no tool result.

/** One line of the transcript. A closed set, so a new event name cannot render as bare text. */
type Entry =
  | {
      readonly key: string;
      readonly kind: 'person' | 'agent' | 'status' | 'error';
      readonly text: string;
    }
  | {
      readonly key: string;
      readonly kind: 'tool';
      readonly name: string;
      readonly args: string;
      readonly result: string;
      readonly failed: boolean;
    };

function summarise(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function Chat(): ReactNode {
  // One identity for this page instance, minted by the library. It addresses this page to the runtime
  // AND names this page's conversation — see `agent-client.ts` for why both are required.
  const tabId = useMcpTabId();
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const sequence = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  /**
   * Whether the transcript should follow new entries.
   *
   * True while the pane is scrolled to the bottom, which is where it starts and where it stays
   * unless a person deliberately scrolls back. Without this the pane would yank someone out of the
   * history they are reading every time a tool call streams in.
   */
  const following = useRef(true);

  const nextKey = useCallback((): string => {
    sequence.current += 1;
    return `e${String(sequence.current)}`;
  }, []);

  // **The transcript follows itself.** Entries arrive while a turn streams, and a pane that never
  // scrolls leaves a person reading the opening of a conversation whose newest line — the agent's
  // answer, or a refused tool call — sits below the fold with nothing on screen to say it is there.
  // An effect rather than a scroll inside the stream loop: the node has to have GROWN before there
  // is anywhere to scroll to, and that is after the commit.
  useEffect(() => {
    const node = transcript.current;
    // The entry count is READ rather than merely depended on: an effect that lists a dependency it
    // does not use is one a linter will eventually remove, and removing this one would leave the
    // scroll running on every render instead of on every new line.
    if (node === null || entries.length === 0 || !following.current) return;
    node.scrollTop = node.scrollHeight;
  }, [entries]);

  const send = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const message = draft.trim();
      if (message === '' || busy) return;

      setDraft('');
      setBusy(true);
      setEntries((current) => [...current, { key: nextKey(), kind: 'person', text: message }]);

      try {
        for await (const streamed of streamChat(tabId, message)) {
          const data = streamed.data;
          if (streamed.event === 'tool_call') {
            const key = nextKey();
            setEntries((current) => [
              ...current,
              {
                key,
                kind: 'tool',
                name: String(data.name ?? 'unknown'),
                args: summarise(data.arguments),
                result: '',
                failed: false,
              },
            ]);
          } else if (streamed.event === 'tool_result') {
            // Attached to the most recent call of the same name rather than appended as its own line,
            // so a person reads one row per action instead of two halves to pair up by eye.
            const name = String(data.name ?? 'unknown');
            setEntries((current) => {
              // Scanned backwards by hand rather than with `findLastIndex`, which is ES2023 while this
              // repository's lib target is ES2022 — it would have compiled against a newer lib and
              // thrown in an older engine.
              let index = -1;
              for (let at = current.length - 1; at >= 0; at -= 1) {
                const candidate = current[at];
                if (
                  candidate !== undefined &&
                  candidate.kind === 'tool' &&
                  candidate.name === name &&
                  candidate.result === ''
                ) {
                  index = at;
                  break;
                }
              }
              if (index === -1) return current;
              const found = current[index];
              if (found === undefined || found.kind !== 'tool') return current;
              const updated: Entry = {
                ...found,
                result: summarise(data.text),
                failed: data.ok === false,
              };
              return [...current.slice(0, index), updated, ...current.slice(index + 1)];
            });
          } else if (streamed.event === 'message') {
            setEntries((current) => [
              ...current,
              { key: nextKey(), kind: 'agent', text: String(data.text ?? '') },
            ]);
          } else if (streamed.event === 'status') {
            setEntries((current) => [
              ...current,
              { key: nextKey(), kind: 'status', text: String(data.text ?? '') },
            ]);
          } else if (streamed.event === 'error') {
            setEntries((current) => [
              ...current,
              { key: nextKey(), kind: 'error', text: String(data.message ?? 'the turn failed') },
            ]);
          }
          // `done` needs no line. It is the turn ending, not something that happened on the page.
        }
      } catch (cause) {
        // Reported, never swallowed. "The chat did nothing" is the most expensive way to learn that the
        // runtime is not running or that the request was refused as unaddressed.
        setEntries((current) => [
          ...current,
          {
            key: nextKey(),
            kind: 'error',
            text: cause instanceof Error ? cause.message : String(cause),
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, draft, nextKey, tabId],
  );

  const clear = useCallback(() => {
    void resetChat(tabId);
    setEntries([]);
  }, [tabId]);

  return (
    <section className="pane pane-chat" aria-label="Chat">
      <div className="pane-head">
        <h1>Describe your dashboard</h1>
        <button type="button" onClick={clear} disabled={busy}>
          Reset
        </button>
      </div>

      <div
        className="transcript"
        data-testid="transcript"
        ref={transcript}
        onScroll={(event) => {
          const node = event.currentTarget;
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {entries.map((entry) =>
          entry.kind === 'tool' ? (
            <div
              key={entry.key}
              className={entry.failed ? 'tool-call tool-call-failed' : 'tool-call'}
              data-testid="tool-call"
            >
              {entry.name}({entry.args}){entry.result === '' ? '' : ` → ${entry.result}`}
            </div>
          ) : (
            <div key={entry.key} className={`turn turn-${entry.kind}`}>
              {entry.text}
            </div>
          ),
        )}
      </div>

      <form className="composer" onSubmit={(event) => void send(event)}>
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          type="text"
          value={draft}
          placeholder="a table of accounts and a tile with total revenue"
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || draft.trim() === ''}>
          {busy ? 'Working…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
