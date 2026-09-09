// The board page's client for the local agent runtime.
//
// **This module speaks HTTP and decides nothing.** It does not interpret a tool result, does not choose
// what to call, and holds no conversation state. The MCP client lives in the agent process because that
// is where the socket this page dialled is held; this is the page's other, independent channel to the
// same process — the conversation it displays, not the control interface it exposes.
//
// **Why this is not shared with `examples/agent-chat`.** That page lets an operator CHOOSE among
// connected tabs; this one always addresses the page it is part of. A shared module would have to
// express both, which is an abstraction over two needs that differ. The cost is named rather than
// hidden: the runtime's origin and endpoint shapes now appear in two examples, and a third copy is the
// point at which the mock agent's HTTP surface needs a documented owner instead of three transcriptions.

/** Where the local agent runtime lives. The `:450xx` block; see the run-dev-stack skill. */
export const AGENT_ORIGIN = 'http://localhost:45000';

export interface AgentStatus {
  readonly model: { readonly available: boolean; readonly name: string; readonly reason?: string };
  readonly tabs: readonly { readonly tabId: string | null; readonly state: string }[];
}

/** One server-sent event, split into its name and its parsed payload. */
export interface StreamEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (body as { error?: string }).error ?? `the agent answered ${String(response.status)}`;
    throw new Error(message);
  }
  return body;
}

export async function fetchStatus(): Promise<AgentStatus> {
  return (await readJson(await fetch(`${AGENT_ORIGIN}/agent`))) as AgentStatus;
}

export async function resetChat(tabId: string): Promise<void> {
  await fetch(`${AGENT_ORIGIN}/chat/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The session is this page's identity for the same reason `tab` is — see `streamChat`.
    body: JSON.stringify({ session: tabId }),
  });
}

/**
 * Sends one message and yields the agent's events as they arrive.
 *
 * **`tab` and `session` go in the BODY, not the query string, and both are required.** The runtime
 * destructures `{ session, message, tab }` from the JSON body on `POST /chat`; only `GET /tools` reads a
 * query parameter, so a `?tab=` here would be silently ignored and the request would be treated as
 * unaddressed.
 *
 * `tab` is required because the runtime refuses an unaddressed control request whenever more than one
 * page is connected — and during development the other demonstrator on `:45010` routinely is, so
 * relying on auto-selection would work on a quiet machine and return HTTP 400 exactly when the demo is
 * being shown to someone.
 *
 * `session` is required for a worse reason: it defaults to the literal `'default'`, so two chat pages
 * that omit it share one conversation. That never errors — each page is simply told about panels that
 * never existed on its own board.
 *
 * **This is routing, not authorization.** The gateway redeems the connection ticket at the socket
 * upgrade and reads the tab id strictly afterwards, so the id never enters an admission decision;
 * addressing a request to a page that has already been admitted is a different thing from authorizing
 * it. And the page does not invent the id — the library mints one per document and `useMcpTabId`
 * publishes it. A hand-written id is unique only by luck, and two copies of one page then claim one
 * identity, which this repository's own demonstrator did on 2026-08-25.
 *
 * Server-sent events over a POST, which is why this is hand-parsed rather than `EventSource`:
 * `EventSource` can only issue a GET, and the message does not belong in a query string.
 */
export async function* streamChat(tabId: string, message: string): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${AGENT_ORIGIN}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: tabId, message, tab: tabId }),
  });

  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `the agent answered ${String(response.status)}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    // Events are separated by a blank line and a chunk can end mid-event. Splitting on the separator
    // and keeping the remainder is what stops a large tool result from being parsed as two halves.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseEvent(raw);
      if (parsed !== undefined) yield parsed;
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function parseEvent(raw: string): StreamEvent | undefined {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    // A frame that does not parse is reported rather than dropped: the agent sent something, and
    // silence about it is the hidden unknown this project refuses.
    return {
      event: 'error',
      data: { message: `the agent sent an unreadable event: ${raw.slice(0, 200)}` },
    };
  }
}
