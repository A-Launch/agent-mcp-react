import type { Model, ModelContent, ModelMessage, ModelTool } from './model.ts';

// The chat agent: one conversation, the page's own tools, and the loop between them.
//
// This is the piece that makes the demonstration an agent rather than a remote control. It lists the
// tools the PAGE currently exposes, hands them to the model as the only actions available, runs
// whatever the model calls against the live browser connection, and feeds the results back until the
// model has nothing left to call.
//
// Three things here are load-bearing and easy to get wrong:
//
//   1. **The tool list is read when it is known to have changed, and not otherwise.** The page's tool
//      set changes with what is mounted — opening an account drawer adds three tools, closing it
//      removes them — and the page SAYS SO: it sends `notifications/tools/list_changed`, and the
//      runtime marks the tab's listing stale when one arrives. Without that signal a loop has to
//      re-list before every single model round trip, which is a workaround for a missing mechanism
//      rather than a design; this one never re-lists on a guess.
//   2. **MCP tool names are translated, not passed through.** MCP names are dot-separated
//      (`customers.set_filters`); the Messages API accepts `^[a-zA-Z0-9_-]{1,64}$` and would refuse
//      the request outright. The mapping is built per turn and inverted from the same map, so a
//      renamed tool cannot silently resolve to a stale one.
//   3. **A tool that fails comes back to the model as a tool result, not as a thrown error.** A
//      refusal — an unknown account, a value outside a vocabulary — is information the model can act
//      on. Turning it into a transport failure would end the turn and lose it.

/** What the chat page is told, as it happens. A closed set; the page branches on these names. */
export const CHAT_EVENT = {
  /** Progress the operator should see: listing tools, thinking, calling. */
  status: 'status',
  /** Prose from the model. */
  message: 'message',
  /** A tool the model decided to call, with the arguments it chose. */
  toolCall: 'tool_call',
  /** What the page returned for that call. */
  toolResult: 'tool_result',
  /** The turn could not continue. Carries why. */
  error: 'error',
  /** The turn is over. Always the last event, whatever else happened. */
  done: 'done',
} as const;

export type ChatEventName = (typeof CHAT_EVENT)[keyof typeof CHAT_EVENT];

export interface ChatEvent {
  readonly event: ChatEventName;
  readonly data: Record<string, unknown>;
}

export type Emit = (event: ChatEvent) => void;

/**
 * How many model↔tool round trips one message may take.
 *
 * Bounded because an unbounded loop against a live page is a loop that can keep mutating it. Reaching
 * the bound is reported to the page rather than passed off as a finished turn.
 */
const MAX_TURNS = 8;

/**
 * The chat agent's standing instructions.
 *
 * **Page-agnostic on purpose, and it did not start that way.** This prompt used to open "a customer
 * account book" and name that demonstrator's tools directly — `dashboard.describe`, `customers.list`,
 * the account drawer. One gateway serves every page that dials it, so a second demonstrator inherited
 * instructions about screens it does not have, and the demonstration's success came to depend on the
 * model recovering from contradictory guidance rather than on the page being well instrumented.
 *
 * What replaces the specifics is the general shape of the same advice. The page-specific detail is
 * already carried by the tool NAMES, TITLES and DESCRIPTIONS the page publishes, which is where it
 * belongs: an application that instruments itself well needs nothing added here, and one that does not
 * cannot be rescued from here either.
 *
 * Nothing in this prompt may name a tool. A rule that has to be repeated per page is a rule this file is
 * the wrong owner of.
 */
const SYSTEM = [
  'You are an agent operating a live web page through the Model Context Protocol. The tools you are',
  "given are the page's OWN actions: every one of them is wired to the same function a button or a",
  'control on that page calls. There is no browser automation here and no way to reach anything the',
  'tools do not expose. Read each tool’s description — it is written by the page and tells you what',
  'that page is and what the action means there.',
  '',
  'How to work:',
  '- If a tool reads the page’s current state, call it first when you do not already know what is on',
  '  screen. State persists between your turns and a person may have changed it while you were away.',
  '- Prefer one precise call over several speculative ones. Where a tool accepts several fields at',
  '  once, set them in one call rather than one per call.',
  '- Trust what a tool returns over what you expect. A read tool reports what is actually on screen.',
  '- The tool set CHANGES with the page. Tools appear when the part of the page that owns them is',
  '  present and disappear when it is not, so a tool you used earlier may be gone, and an action you',
  '  need may only exist after you create or open the thing it belongs to. If an action you want is',
  '  missing, look for the tool that brings its owner onto the page.',
  '- A tool error is information. Read it and adjust; do not repeat the same call. A refusal usually',
  '  names the values that would have been accepted.',
  '',
  'Answer the person in two or three sentences. State what you changed on the page and what they are',
  'now looking at. Do not describe the tool calls themselves — they are shown alongside your reply.',
].join('\n');

/** One tool as the page describes it. Only the fields this module reads are declared. */
export interface McpToolSummary {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * The page, as this loop needs it.
 *
 * Structural rather than the SDK's `Client`, because what the loop actually depends on is "give me the
 * current tools" and "run this" — and the caller is now free to answer the first from a listing it
 * knows is current instead of asking the page every time. The staleness lives with whoever holds the
 * notification handler; this module does not track it and must not, or there would be two answers to
 * when a listing is out of date.
 */
export interface PageAccess {
  listTools(): Promise<{ tools: McpToolSummary[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/**
 * The Messages API's tool-name grammar. A name outside it is refused for the whole request, not for
 * the one tool — which is why translation happens rather than filtering.
 */
const API_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** MCP name to API name. Dots become double underscores; anything else illegal becomes one. */
function toApiName(mcpName: string): string {
  const candidate = mcpName
    .replace(/\./g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
  return API_NAME.test(candidate) ? candidate : `tool_${candidate.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * Translates the page's tool list into the model's, and returns the inverse mapping alongside.
 *
 * The inverse is returned rather than recomputed because recomputing it is where a rename becomes a
 * silent mis-dispatch: two different MCP names can normalize to the same API name, and a map built
 * once notices the collision where a second normalization pass would not.
 */
function translate(tools: readonly McpToolSummary[]): {
  readonly modelTools: ModelTool[];
  readonly mcpNameOf: Map<string, string>;
} {
  const modelTools: ModelTool[] = [];
  const mcpNameOf = new Map<string, string>();

  for (const tool of tools) {
    const apiName = toApiName(tool.name);
    const clash = mcpNameOf.get(apiName);
    if (clash !== undefined && clash !== tool.name) {
      // Loud, because the alternative is the model calling one tool and the page running another.
      throw new Error(
        `two page tools translate to the same model tool name "${apiName}": "${clash}" and "${tool.name}"`,
      );
    }
    mcpNameOf.set(apiName, tool.name);
    modelTools.push({
      name: apiName,
      // The page's own words, and the MCP name with them: the model needs the real name to explain
      // itself, and the description is where a human-readable name can go without a schema change.
      description:
        `[${tool.name}] ${tool.title === undefined ? '' : `${tool.title}. `}${tool.description ?? ''}`.trim(),
      input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
    });
  }

  return { modelTools, mcpNameOf };
}

/** Renders whatever a tool returned as the text the model sees. */
function resultText(result: unknown): { text: string; isError: boolean } {
  const shaped = result as { content?: { type?: string; text?: string }[]; isError?: boolean };
  const parts = (shaped.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return {
    text: parts.length === 0 ? JSON.stringify(result) : parts.join('\n'),
    isError: shaped.isError === true,
  };
}

export interface ChatSessions {
  /** Runs one turn, emitting events as it goes. Never throws — failures arrive as an error event. */
  send(sessionId: string, text: string, page: PageAccess, emit: Emit): Promise<void>;
  /** Forgets a conversation. The page keeps whatever the agent already changed. */
  reset(sessionId: string): void;
}

export function createChatSessions(model: Model): ChatSessions {
  const conversations = new Map<string, ModelMessage[]>();

  return {
    reset(sessionId): void {
      conversations.delete(sessionId);
    },

    async send(sessionId, text, page, emit): Promise<void> {
      if (!model.available) {
        emit({
          event: CHAT_EVENT.error,
          data: { message: model.reason ?? 'no model is configured' },
        });
        emit({ event: CHAT_EVENT.done, data: { turns: 0 } });
        return;
      }

      const history = conversations.get(sessionId) ?? [];
      const messages: ModelMessage[] = [
        ...history,
        { role: 'user', content: [{ type: 'text', text }] },
      ];

      let turns = 0;
      try {
        for (;;) {
          turns += 1;
          if (turns > MAX_TURNS) {
            // Reported as an error rather than returned as an answer: the turn did not finish, and
            // saying otherwise would hand the person a partial result dressed as a complete one.
            emit({
              event: CHAT_EVENT.error,
              data: {
                message: `stopped after ${String(MAX_TURNS)} tool rounds without a final answer`,
              },
            });
            break;
          }

          emit({ event: CHAT_EVENT.status, data: { text: 'reading the page’s tools' } });
          const listed = await page.listTools();
          const { modelTools, mcpNameOf } = translate(listed.tools);

          emit({
            event: CHAT_EVENT.status,
            data: {
              text: `thinking · ${String(modelTools.length)} tools available`,
              tools: listed.tools.map((tool) => tool.name),
            },
          });

          const reply = await model.complete({ system: SYSTEM, messages, tools: modelTools });
          messages.push({ role: 'assistant', content: reply.content });

          for (const block of reply.content) {
            if (block.type === 'text' && block.text.trim() !== '') {
              emit({ event: CHAT_EVENT.message, data: { text: block.text } });
            }
          }

          const calls = reply.content.filter(
            (block): block is Extract<ModelContent, { type: 'tool_use' }> =>
              block.type === 'tool_use',
          );
          if (calls.length === 0) break;

          const results: ModelContent[] = [];
          for (const call of calls) {
            const mcpName = mcpNameOf.get(call.name);
            if (mcpName === undefined) {
              // The model named a tool that is not in the list it was given this turn — which happens
              // when the page's tool set changed between turns. Answered as a tool result so the
              // model can re-list and recover, rather than ending the conversation.
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                content: `no tool named "${call.name}" is on the page right now`,
                is_error: true,
              });
              continue;
            }

            emit({
              event: CHAT_EVENT.toolCall,
              data: { id: call.id, name: mcpName, arguments: call.input },
            });

            const outcome = await page
              .callTool({ name: mcpName, arguments: call.input })
              .then((result) => resultText(result))
              .catch((cause: unknown) => ({
                text: cause instanceof Error ? cause.message : String(cause),
                isError: true,
              }));

            emit({
              event: CHAT_EVENT.toolResult,
              data: { id: call.id, name: mcpName, ok: !outcome.isError, text: outcome.text },
            });

            results.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: outcome.text,
              ...(outcome.isError ? { is_error: true } : {}),
            });
          }

          messages.push({ role: 'user', content: results });
        }
      } catch (cause) {
        emit({
          event: CHAT_EVENT.error,
          data: { message: cause instanceof Error ? cause.message : String(cause) },
        });
      }

      // Stored whatever happened, including a turn that failed part way: the page really was mutated
      // by the calls that did land, and dropping the history would leave the model's next turn
      // reasoning about a page it does not know it changed.
      conversations.set(sessionId, messages);
      emit({ event: CHAT_EVENT.done, data: { turns } });
    },
  };
}
