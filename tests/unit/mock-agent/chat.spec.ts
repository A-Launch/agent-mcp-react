import { describe, expect, it } from 'vitest';
import {
  CHAT_EVENT,
  type ChatEvent,
  type ChatSessions,
  createChatSessions,
} from '../../../tools/mock-agent/src/chat.ts';
import type { Model, ModelMessage, ModelReply } from '../../../tools/mock-agent/src/model.ts';

/**
 * The MCP client as `send` receives it, derived from the function rather than imported.
 *
 * `@modelcontextprotocol/client` is a dependency of `tools/mock-agent`, not of the repository root, so
 * a direct import here resolves for Vitest and fails `tsc` — and the layer that would have caught that
 * is the typecheck, not the suite. Deriving the type keeps the stand-in honest without reaching into
 * another package's dependency graph.
 */
type PageClient = Parameters<ChatSessions['send']>[2];

// The chat agent's loop, with a scripted model and a scripted page.
//
// Neither end is real here, on purpose: what these cases pin down is the loop's own behaviour — the
// name translation, what happens to a tool failure, what a missing model produces — and a real model
// would make each of those a different assertion every run. The socket and the browser are exercised
// where they belong, in the transport suite and by hand against the running stack.

/** A page whose tool list and results are dictated by the case. */
function pageWith(
  tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[],
  results: Record<string, { text: string; isError?: boolean }> = {},
): { client: PageClient; calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  const client = {
    listTools: () => Promise.resolve({ tools }),
    callTool: ({ name, arguments: args }: { name: string; arguments?: unknown }) => {
      calls.push({ name, args });
      const result = results[name] ?? { text: 'ok' };
      return Promise.resolve({
        content: [{ type: 'text', text: result.text }],
        ...(result.isError === true ? { isError: true } : {}),
      });
    },
  } as unknown as PageClient;
  return { client, calls };
}

/** A model that replies with a scripted sequence, one entry per round trip. */
function modelSaying(...replies: ModelReply[]): Model & { seen: ModelMessage[][] } {
  const seen: ModelMessage[][] = [];
  let turn = 0;
  return {
    available: true,
    name: 'scripted',
    seen,
    complete: (request) => {
      seen.push([...request.messages]);
      const reply = replies[turn] ?? {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
      };
      turn += 1;
      return Promise.resolve(reply);
    },
  };
}

function collect(): { emit: (event: ChatEvent) => void; events: ChatEvent[] } {
  const events: ChatEvent[] = [];
  return { emit: (event) => events.push(event), events };
}

describe('the chat agent calls the page’s own tools', () => {
  it('translates a dotted MCP name for the model and back again before calling', async () => {
    const { client, calls } = pageWith([
      { name: 'customers.set_filters', description: 'filter', inputSchema: { type: 'object' } },
    ]);
    const model = modelSaying(
      {
        content: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'customers__set_filters',
            input: { segments: ['startup'] },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'filtered' }], stopReason: 'end_turn' },
    );
    const { emit, events } = collect();

    await createChatSessions(model).send('s', 'filter it', client, emit);

    // The model was offered a name the Messages API accepts — a dot would have the API refuse the
    // whole request, not just that tool.
    expect(calls).toEqual([{ name: 'customers.set_filters', args: { segments: ['startup'] } }]);
    const call = events.find((event) => event.event === CHAT_EVENT.toolCall);
    // And the page's real name is what the operator is shown, not the translated one.
    expect(call?.data.name).toBe('customers.set_filters');
  });

  it('refuses a tool list whose translated names collide, rather than dispatching one as the other', async () => {
    // Two distinct page tools that normalize to the same API name: the dot in the first becomes the
    // double underscore the second already has. Left to run, the model would call one name and the
    // page would run whichever of the two the map happened to hold.
    const { client } = pageWith([
      { name: 'a.b', description: 'first' },
      { name: 'a__b', description: 'second' },
    ]);
    const { emit, events } = collect();

    await createChatSessions(modelSaying()).send('s', 'go', client, emit);

    const failure = events.find((event) => event.event === CHAT_EVENT.error);
    expect(failure?.data.message).toContain('translate to the same model tool name');
    expect(events.at(-1)?.event).toBe(CHAT_EVENT.done);
  });

  it('feeds a refused tool back to the model as a result, so the turn can recover', async () => {
    const { client } = pageWith([{ name: 'customers.open_account', description: 'open' }], {
      'customers.open_account': { text: 'no account matches "Nope Inc"', isError: true },
    });
    const model = modelSaying(
      {
        content: [
          {
            type: 'tool_use',
            id: 'c1',
            name: 'customers__open_account',
            input: { account: 'Nope Inc' },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'that account does not exist' }], stopReason: 'end_turn' },
    );
    const { emit, events } = collect();

    await createChatSessions(model).send('s', 'open it', client, emit);

    const result = events.find((event) => event.event === CHAT_EVENT.toolResult);
    expect(result?.data.ok).toBe(false);
    // The turn continued: a refusal is information, and turning it into a transport failure would end
    // the conversation and throw away the one thing the model needed to read.
    expect(model.seen).toHaveLength(2);
    expect(events.some((event) => event.event === CHAT_EVENT.error)).toBe(false);
  });

  it('asks the page for its tools on every round trip, and never assumes the set held still', async () => {
    let listed = 0;
    const client = {
      listTools: () => {
        listed += 1;
        return Promise.resolve({ tools: [{ name: 'x.y', description: 'x' }] });
      },
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
    } as unknown as PageClient;
    const model = modelSaying(
      {
        content: [{ type: 'tool_use', id: 'c1', name: 'x__y', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    );

    await createChatSessions(model).send('s', 'go', client, collect().emit);

    // Once per round trip, and that is the loop's correct behaviour rather than a workaround: its own
    // tool call in round one can change the set — opening an account drawer adds three tools — so a
    // single listing taken at the start would leave round two planning against a page that no longer
    // exists.
    //
    // What the change notification bought is what that ASK costs. The loop asks its `PageAccess`; the mock
    // agent's implementation of that serves the answer it already holds and reaches the wire only when
    // the page has sent `notifications/tools/list_changed`. This case counts the asks, which must stay
    // one per round trip; the wire count is a property of the caller and is proven where the caller
    // lives — against a real socket, and in the live run.
    expect(listed).toBe(2);
  });
});

describe('the chat agent says what it cannot do', () => {
  it('reports the missing model instead of answering as though it had one', async () => {
    const reason = 'ANTHROPIC_API_KEY is not set';
    const absent: Model = {
      available: false,
      reason,
      name: 'none',
      complete: () => Promise.reject(new Error(reason)),
    };
    const { client, calls } = pageWith([{ name: 'a.b', description: 'a' }]);
    const { emit, events } = collect();

    await createChatSessions(absent).send('s', 'do something', client, emit);

    expect(events.map((event) => event.event)).toEqual([CHAT_EVENT.error, CHAT_EVENT.done]);
    expect(events[0]?.data.message).toBe(reason);
    // Nothing was attempted against the page. A chat with no model must not fall back to guessing.
    expect(calls).toEqual([]);
  });

  it('stops a runaway turn and says so, rather than returning a partial answer as a finished one', async () => {
    const { client } = pageWith([{ name: 'a.b', description: 'a' }]);
    // A model that never stops calling.
    const endless: Model = {
      available: true,
      name: 'endless',
      complete: () =>
        Promise.resolve({
          content: [{ type: 'tool_use', id: 'c', name: 'a__b', input: {} }],
          stopReason: 'tool_use',
        }),
    };
    const { emit, events } = collect();

    await createChatSessions(endless).send('s', 'go', client, emit);

    const failure = events.find((event) => event.event === CHAT_EVENT.error);
    expect(failure?.data.message).toContain('without a final answer');
    expect(events.at(-1)?.event).toBe(CHAT_EVENT.done);
  });
});
