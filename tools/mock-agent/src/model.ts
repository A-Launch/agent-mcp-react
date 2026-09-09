// The model behind the chat: a direct caller of the Anthropic Messages API, over `fetch`.
//
// No SDK dependency, deliberately. The request is one JSON body and the response is one JSON body,
// and adding a package to construct them would put a version of somebody else's types between this
// demonstrator and the wire — which is the opposite of what a demonstrator is for.
//
// **Availability is reported, never faked.** With no API key this module says so, once, in the words
// an operator can act on, and every send returns that same statement. There is no offline planner
// standing in behind it: a keyword matcher pretending to be a model would make the demonstration
// claim something untrue about what drove the tool call. A missing key is an unexpected state, and an
// unexpected state fails loud rather than resolving into a convenience default.
//
// The key is read from the process environment at startup and is never logged, never returned from an
// endpoint, and never sent anywhere except the Anthropic API.

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-5';
const API_VERSION = '2023-06-01';

/** One tool as the Messages API wants it. Names here are API names, not MCP names. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export type ModelContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ModelContent[];
}

export interface ModelReply {
  readonly content: readonly ModelContent[];
  readonly stopReason: string | null;
}

export interface Model {
  /** Whether a completion can actually be requested. */
  readonly available: boolean;
  /** Why not, when it is not. Written for the operator who has to fix it. */
  readonly reason?: string;
  readonly name: string;
  complete(request: {
    readonly system: string;
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ModelTool[];
  }): Promise<ModelReply>;
}

/**
 * Builds the model client from the process environment.
 *
 * Called once at startup so that "no key" is a state the chat page can render before anyone types,
 * rather than a failure discovered on the first message.
 */
export function createModel(env: NodeJS.ProcessEnv = process.env): Model {
  const key = env.ANTHROPIC_API_KEY;
  const name = env.AMR_MODEL ?? DEFAULT_MODEL;
  const baseUrl = env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;

  if (key === undefined || key === '') {
    const reason =
      'ANTHROPIC_API_KEY is not set in the mock agent process, so nothing can decide which tool to ' +
      'call. Restart it as `ANTHROPIC_API_KEY=… pnpm dev:agent`. The page and its tools work ' +
      'without it — the tool console on the right calls them directly.';
    return {
      available: false,
      reason,
      name,
      complete: () => Promise.reject(new Error(reason)),
    };
  }

  return {
    available: true,
    name,
    async complete(request): Promise<ModelReply> {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: name,
          max_tokens: 2048,
          system: request.system,
          messages: request.messages,
          ...(request.tools.length === 0 ? {} : { tools: request.tools }),
        }),
      });

      if (!response.ok) {
        // The API's own message is the diagnosis — an unknown model name, an exhausted credit
        // balance and a malformed schema are three different problems with three different fixes,
        // and collapsing them into "the model call failed" costs the operator all of it.
        const detail = await response.text().catch(() => '');
        throw new Error(
          `the model API answered ${String(response.status)}: ${detail.slice(0, 600)}`,
        );
      }

      const body = (await response.json()) as {
        content?: ModelContent[];
        stop_reason?: string | null;
      };
      return { content: body.content ?? [], stopReason: body.stop_reason ?? null };
    },
  };
}
