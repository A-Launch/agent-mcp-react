import { type ReactNode, useState } from 'react';
import { callTool, type PageTool } from '../agent.ts';

// The tool console: the page's live tool list, and a way to call one by hand.
//
// **You are the planner here, and the page says so.** This is not a fallback agent — nothing in this
// panel decides anything. It exists for two reasons: it is the whole demonstration when no model is
// configured, and it is the ground truth to check the agent against when one is. The tools listed are
// read from the dashboard through `tools/list`, not from anything this page holds.
//
// The list is refreshed on demand rather than followed. Nothing pushes
// `notifications/tools/list_changed` yet, so a page that showed a live-looking list would be showing a
// stale one with confidence — the Refresh button is honest about what it is.

function example(tool: PageTool): string {
  const schema = tool.inputSchema as
    | { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] }
    | undefined;
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  const seed: Record<string, unknown> = {};
  for (const name of required) {
    const property = properties[name];
    const enumerated = property?.enum;
    if (Array.isArray(enumerated) && enumerated.length > 0) seed[name] = enumerated[0];
    else if (property?.type === 'number') seed[name] = 0;
    else if (property?.type === 'boolean') seed[name] = true;
    else seed[name] = '';
  }
  return JSON.stringify(seed, null, 2);
}

export function ToolConsole({
  tools,
  tab,
  onRefresh,
  refreshing,
  error,
}: {
  readonly tools: readonly PageTool[];
  readonly tab: string | null;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly error: string | undefined;
}): ReactNode {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [args, setArgs] = useState('{}');
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [calling, setCalling] = useState(false);

  const select = (tool: PageTool): void => {
    const next = open === tool.name ? undefined : tool.name;
    setOpen(next);
    setOutcome(undefined);
    if (next !== undefined) setArgs(example(tool));
  };

  const run = async (name: string): Promise<void> => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args === '' ? '{}' : args) as Record<string, unknown>;
    } catch (cause) {
      // Refused before anything is sent, and named: a malformed body would come back as a generic
      // 400 from the gateway and read as though the tool rejected it.
      setOutcome({ ok: false, text: `those arguments are not valid JSON — ${String(cause)}` });
      return;
    }
    setCalling(true);
    setOutcome(
      await callTool(name, parsed, tab).catch((cause: unknown) => ({
        ok: false,
        text: cause instanceof Error ? cause.message : String(cause),
      })),
    );
    setCalling(false);
  };

  return (
    <aside className="console" aria-label="Tool console">
      <header className="console-head">
        <div>
          <h2>Page tools</h2>
          <p className="hint">
            Read from the dashboard over <code>tools/list</code>. Calling one here puts no model in
            the loop — you are the planner.
          </p>
        </div>
        <button type="button" className="link-button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'reading…' : 'Refresh'}
        </button>
      </header>

      {error !== undefined ? <p className="console-error">{error}</p> : null}

      {tools.length === 0 && error === undefined ? (
        <p className="hint">No tools. Is the dashboard open on :45010?</p>
      ) : null}

      <ul className="tool-list">
        {tools.map((tool) => (
          <li key={tool.name} className={open === tool.name ? 'tool tool-open' : 'tool'}>
            <button type="button" className="tool-head" onClick={() => select(tool)}>
              <code>{tool.name}</code>
              <span className="tool-title">{tool.title ?? ''}</span>
            </button>
            {open === tool.name ? (
              <div className="tool-body">
                <p className="tool-desc">{tool.description}</p>
                <textarea
                  className="args"
                  value={args}
                  spellCheck={false}
                  rows={Math.min(10, args.split('\n').length + 1)}
                  onChange={(event) => setArgs(event.target.value)}
                />
                <button
                  type="button"
                  className="call-button"
                  disabled={calling}
                  onClick={() => void run(tool.name)}
                >
                  {calling ? 'calling…' : `Call ${tool.name}`}
                </button>
                {outcome === undefined ? null : (
                  <pre className={outcome.ok ? 'call-result' : 'call-result bad'}>
                    {outcome.text}
                  </pre>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}
