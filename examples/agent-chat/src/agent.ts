// The chat page's client for the local agent runtime.
//
// **This page mounts no provider, registers no tool and opens no WebSocket.** It is the agent's face,
// not an instrumented application: the MCP client lives in the agent process because it holds the
// socket the dashboard dialled, and a second client here would be a different agent looking at a
// different page. Everything below is ordinary HTTP against that process.
//
// Boundary: this module speaks to the agent runtime and decides nothing. It does not interpret a tool
// result, does not decide what to call, and holds no conversation state.

/** Where the local agent runtime lives. The `:450xx` block; see the run-dev-stack skill. */
export const AGENT_ORIGIN = 'http://localhost:45000';

export interface AgentStatus {
  readonly model: { readonly available: boolean; readonly name: string; readonly reason?: string };
  readonly tabs: readonly {
    readonly tabId: string | null;
    readonly state: string;
    readonly reason?: string;
  }[];
}

export interface PageTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
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

export async function fetchTools(tab: string | null): Promise<readonly PageTool[]> {
  const query = tab === null || tab === '' ? '' : `?tab=${encodeURIComponent(tab)}`;
  const body = (await readJson(await fetch(`${AGENT_ORIGIN}/tools${query}`))) as {
    tools?: PageTool[];
  };
  return body.tools ?? [];
}

/** Calls one tool directly, with no model in the loop. The manual path, and labelled as such. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  tab: string | null,
): Promise<{ text: string; ok: boolean }> {
  const response = await fetch(`${AGENT_ORIGIN}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args, ...(tab === null || tab === '' ? {} : { tab }) }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  if (!response.ok) {
    return { text: body.error ?? `the agent answered ${String(response.status)}`, ok: false };
  }
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return { text: text === '' ? JSON.stringify(body) : text, ok: body.isError !== true };
}

export async function resetChat(session: string): Promise<void> {
  await fetch(`${AGENT_ORIGIN}/chat/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session }),
  });
}

/** One server-sent event, already split into its name and its parsed payload. */
export interface StreamEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/**
 * Sends one message and yields the agent's events as they arrive.
 *
 * Server-sent events over a POST, which is why this is hand-parsed rather than `EventSource` —
 * `EventSource` can only issue a GET, and the message does not belong in a query string.
 */
export async function* streamChat(
  session: string,
  message: string,
  tab: string | null,
): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${AGENT_ORIGIN}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, message, ...(tab === null || tab === '' ? {} : { tab }) }),
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

    // Events are separated by a blank line, and a chunk can end mid-event. Splitting on the separator
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
    // A frame that does not parse is reported as an error event rather than dropped: the agent sent
    // something, and silence about it is the hidden unknown this project refuses.
    return {
      event: 'error',
      data: { message: `the agent sent an unreadable event: ${raw.slice(0, 200)}` },
    };
  }
}
