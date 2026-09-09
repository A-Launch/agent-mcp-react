import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from '@modelcontextprotocol/client';
import {
  type ChatEvent,
  createChatSessions,
  type McpToolSummary,
  type PageAccess,
} from './chat.ts';
import { connectClient } from './client.ts';
import { type BrowserConnection, type Gateway, startGateway } from './gateway.ts';
import { createModel, type Model } from './model.ts';

// The mock agent runtime: the gateway, one MCP client per accepted browser connection, and the small
// HTTP control surface the CLI drives.
//
// All three live in one process deliberately. The client acts on a socket this process is holding, so
// a separate `list` process could not reach it; the control surface exists precisely so the CLI can
// stay a thin HTTP caller instead of a second runtime with its own copy of the connection state
// — one owner per truth, everything else derived from it.
//
// Selecting among tabs is the agent runtime's job, not the library's
// (docs/connecting-to-an-agent.md#multiple-tabs) — which is why that policy
// lives here, and why it is the simplest one that cannot silently pick wrong: one tab is unambiguous,
// several require the caller to name one.

/** Whether a connected tab has an MCP server answering on it, and why not when it does not. */
export const TAB_STATE = {
  /** `initialize` completed. The tab can be listed and called. */
  ready: 'ready',
  /** The socket is open but the handshake has not completed yet. */
  connecting: 'connecting',
  /** The socket is open and nothing answered MCP on it. The reason is carried alongside. */
  unavailable: 'unavailable',
} as const;

export type TabState = (typeof TAB_STATE)[keyof typeof TAB_STATE];

export interface TabSummary {
  readonly tabId: string | null;
  readonly state: TabState;
  /** Present only for `unavailable`, and stating what actually went wrong. */
  readonly reason?: string;
}

interface Tab {
  readonly connection: BrowserConnection;
  state: TabState;
  client?: Client;
  reason?: string;
  /**
   * The page's tools as last read, and whether that reading is still good.
   *
   * `stale` starts true because nothing has been read yet, and is set true again whenever the page
   * sends `notifications/tools/list_changed`. This is the ONLY thing that invalidates it — no timer,
   * no per-turn refresh, no "just in case". That is the point of the page's change notification:
   * without one an agent must re-list before every model round trip because it has no way to know,
   * and a listing fetched on a schedule reports a change after the fact.
   */
  tools?: McpToolSummary[];
  toolsStale: boolean;
}

export interface MockAgent {
  readonly gateway: Gateway;
  tabs(): TabSummary[];
  /** The model behind `/chat`, so a caller can report whether one is configured without sending. */
  readonly model: Model;
  close(): Promise<void>;
}

export interface MockAgentOptions {
  readonly port?: number;
  readonly onEvent?: (line: string) => void;
  /**
   * How long to wait for a connected page to answer `initialize` before recording the tab as
   * `unavailable`. Bounded so that "no MCP server here" is a state an operator reaches rather than
   * waits out.
   */
  readonly handshakeTimeoutMs?: number;
  /**
   * The model the chat agent reasons with. Injected so a test can drive the loop without a network
   * call and without an API key; the server builds the real one from the process environment.
   */
  readonly model?: Model;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

export async function startMockAgent(options: MockAgentOptions = {}): Promise<MockAgent> {
  const tabs = new Map<BrowserConnection, Tab>();
  const say = options.onEvent ?? ((): void => {});
  const model = options.model ?? createModel();
  const chat = createChatSessions(model);

  const summarise = (tab: Tab): TabSummary => ({
    tabId: tab.connection.tabId,
    state: tab.state,
    ...(tab.reason === undefined ? {} : { reason: tab.reason }),
  });

  /**
   * Resolves which tab a control request addresses.
   *
   * Returns a refusal rather than a guess whenever the request does not identify exactly one tab.
   * Picking "the first one" would make a multi-tab session succeed against an arbitrary tab, which is
   * the silent-success shape this project treats as a defect.
   *
   * **Ambiguity is refused in BOTH directions, and the second one is easy to miss.** Naming a tab is
   * not a way past the guard: a tab id is metadata a page chooses for itself
   * (docs/connecting-to-an-agent.md#the-page-instances-identity), and nothing makes an id a page
   * supplies unique. A hand-written one is unique only by luck — `examples/customer-dashboard` used a
   * literal until two copies of it in one browser claimed a single identity, which is why the library
   * mints one per page instance and the demonstrator appends THAT. Answering from whichever connected
   * first would report a page the caller never addressed, and every result would look perfectly
   * normal.
   */
  const selectTab = (
    requested: string | null,
  ): { tab: Tab } | { error: string; status: number } => {
    const all = [...tabs.values()];
    if (requested !== null && requested !== '') {
      const matches = all.filter((tab) => tab.connection.tabId === requested);
      if (matches.length === 0) {
        return { error: `no connected tab with id ${requested}`, status: 404 };
      }
      if (matches.length > 1) {
        return {
          error:
            `${String(matches.length)} connected tabs share the id ${requested}, so the request is ` +
            'ambiguous — give each page a distinct tabId',
          status: 400,
        };
      }
      return { tab: matches[0] as Tab };
    }
    if (all.length === 0) return { error: 'no browser is connected', status: 409 };
    if (all.length > 1) {
      const ids = all.map((tab) => tab.connection.tabId ?? '(no id)').join(', ');
      return { error: `several tabs are connected; name one with ?tab= — ${ids}`, status: 400 };
    }
    return { tab: all[0] as Tab };
  };

  /**
   * The page as the chat loop sees it: tools read only when the page has said they changed.
   *
   * The cache is invalidated by exactly one thing — the notification handler installed above — and
   * that is what makes this a use of the page's change notification rather than a second guess about
   * freshness. A `count`
   * of how many times the page was actually asked is carried so the demonstration can show the
   * difference rather than assert it.
   */
  const pageFor = (tab: Tab, client: Client): PageAccess & { listings(): number } => {
    let listings = 0;
    return {
      async listTools() {
        if (tab.tools === undefined || tab.toolsStale) {
          listings += 1;
          const listed = (await client.listTools()) as { tools: McpToolSummary[] };
          tab.tools = listed.tools;
          tab.toolsStale = false;
        }
        return { tools: tab.tools };
      },
      callTool: (request) => client.callTool(request),
      listings: () => listings,
    };
  };

  const requireReady = (tab: Tab): Client | { error: string; status: number } => {
    if (tab.state === TAB_STATE.ready && tab.client !== undefined) return tab.client;
    return {
      error: `tab ${tab.connection.tabId ?? '(no id)'} is ${tab.state}${
        tab.reason === undefined ? '' : `: ${tab.reason}`
      }`,
      status: 409,
    };
  };

  const gateway = await startGateway({
    ...(options.port === undefined ? {} : { port: options.port }),

    onRefusal: (refusal) => say(`refused     ticket ${refusal}`),

    onConnection: (connection) => {
      const tab: Tab = { connection, state: TAB_STATE.connecting, toolsStale: true };
      tabs.set(connection, tab);
      connection.socket.on('close', () => {
        tabs.delete(connection);
        say(`disconnected tabId=${connection.tabId ?? '(none)'}`);
      });
      say(`connected   tabId=${connection.tabId ?? '(none)'}`);

      // The handshake is attempted, and its failure is reported rather than thrown. A page that opens
      // the socket without serving MCP is a real state — it is exactly what a page looks like before
      // the library's runtime exists.
      //
      // The SDK tears the transport down when `connect()` fails, so the socket closes and the close
      // handler above drops the tab. That is why the cause is emitted as an event before the tab
      // disappears: without it an operator sees a connection arrive and vanish with no reason
      // anywhere, which is exactly the hidden unknown this project refuses: an unexpected state fails
      // loud. `unavailable` remains the state a tab
      // holds in the window between the failure and the close.
      void connectClient(connection, {
        ...(options.handshakeTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.handshakeTimeoutMs }),
      })
        .then((client) => {
          tab.client = client;
          tab.state = TAB_STATE.ready;

          // The page tells us when its tool set changed. Nothing is fetched here — the notification
          // carries no tools by design — so all this does is mark what we hold as no longer good.
          client.setNotificationHandler('notifications/tools/list_changed', () => {
            tab.toolsStale = true;
            say(`tools changed tabId=${connection.tabId ?? '(none)'}`);
          });

          say(`mcp ready   tabId=${connection.tabId ?? '(none)'}`);
        })
        .catch((cause: unknown) => {
          tab.state = TAB_STATE.unavailable;
          tab.reason = cause instanceof Error ? cause.message : String(cause);
          say(`mcp absent  tabId=${connection.tabId ?? '(none)'} — ${tab.reason}`);
        });
    },

    routes: {
      'GET /agent': (_request, response) => {
        // What the chat page renders before anyone types: whether a model is configured, which one,
        // and which tabs it could act on. The API key itself never appears here or anywhere else a
        // caller can reach.
        json(response, 200, {
          model: {
            available: model.available,
            name: model.name,
            ...(model.reason === undefined ? {} : { reason: model.reason }),
          },
          tabs: [...tabs.values()].map(summarise),
        });
      },

      'POST /chat/reset': (request, response) => {
        void readJsonBody(request)
          .then((body) => {
            const { session } = body as { session?: string };
            chat.reset(session ?? 'default');
            // Only the conversation is forgotten. Whatever the agent already changed on the page is
            // still changed — saying "reset" and leaving the page mutated would be a lie an operator
            // would only catch by looking.
            json(response, 200, { reset: session ?? 'default', note: 'the page keeps its state' });
          })
          .catch((cause: unknown) =>
            json(response, 400, { error: `unreadable body: ${String(cause)}` }),
          );
      },

      'POST /chat': (request, response) => {
        void readJsonBody(request)
          .then(async (body) => {
            const { session, message, tab } = body as {
              session?: string;
              message?: string;
              tab?: string;
            };
            if (typeof message !== 'string' || message.trim() === '') {
              json(response, 400, { error: 'a message is required' });
              return;
            }

            const selected = selectTab(tab ?? null);
            if ('error' in selected) {
              json(response, selected.status, { error: selected.error });
              return;
            }
            const client = requireReady(selected.tab);
            if ('error' in client) {
              json(response, client.status, { error: client.error });
              return;
            }

            // Server-sent events rather than one JSON reply. A turn is several tool calls against a
            // live page, and a page that only learns what happened after the last one cannot show a
            // person the agent working — which is the whole thing this demonstration is for.
            response.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
              connection: 'keep-alive',
            });

            const emit = (event: ChatEvent): void => {
              if (response.writableEnded) return;
              response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
            };

            say(`chat        ${message.slice(0, 80)}`);
            const page = pageFor(selected.tab, client);
            await chat.send(session ?? 'default', message, page, emit);
            // Printed because it is the number the change notification exists to change. Without one
            // it equals the number of model round trips; with one it is a single listing plus one per
            // notification received.
            say(`chat done   tools/list requests this turn: ${String(page.listings())}`);
            response.end();
          })
          .catch((cause: unknown) => {
            // Reached only when the body could not be read or the stream broke. Once the SSE headers
            // are out there is no status code left to send, so the failure goes down the stream in
            // the vocabulary the page already handles.
            if (response.headersSent) {
              response.write(
                `event: error\ndata: ${JSON.stringify({ message: String(cause) })}\n\n`,
              );
              response.end();
              return;
            }
            json(response, 400, { error: String(cause) });
          });
      },

      'GET /tabs': (_request, response) => {
        json(response, 200, { tabs: [...tabs.values()].map(summarise) });
      },

      'GET /tools': (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const selected = selectTab(url.searchParams.get('tab'));
        if ('error' in selected) {
          json(response, selected.status, { error: selected.error });
          return;
        }
        const client = requireReady(selected.tab);
        if ('error' in client) {
          json(response, client.status, { error: client.error });
          return;
        }
        void client
          .listTools()
          .then((result) => json(response, 200, result))
          .catch((cause: unknown) => json(response, 502, { error: String(cause) }));
      },

      'POST /call': (request, response) => {
        void readJsonBody(request)
          .then((body) => {
            const {
              tab,
              name,
              arguments: args,
            } = body as {
              tab?: string;
              name?: string;
              arguments?: Record<string, unknown>;
            };
            if (typeof name !== 'string' || name === '') {
              json(response, 400, { error: 'a tool name is required' });
              return;
            }
            const selected = selectTab(tab ?? null);
            if ('error' in selected) {
              json(response, selected.status, { error: selected.error });
              return;
            }
            const client = requireReady(selected.tab);
            if ('error' in client) {
              json(response, client.status, { error: client.error });
              return;
            }
            // **A caller that hangs up cancels the tool call.** Without this there is no way to
            // exercise cancellation (docs/design.md#cancellation) through the running stack at all:
            // every tool here answers instantly except
            // the slow ones, and an operator with only `POST /call` could never change their mind.
            //
            // `curl --max-time 1` on a long call is now a real client cancellation — the notification
            // crosses the socket and the page's handler sees its signal abort.
            const cancel = new AbortController();
            // `response.on('close')`, not `request.on('aborted')`. The second is deprecated and does
            // not fire on Node 24 — measured, by watching a demonstrator tool run to completion after
            // its caller had gone. `close` fires either way, so the guard is whether the response was
            // actually finished: if it was, this is the normal end of a served request.
            response.on('close', () => {
              if (response.writableFinished) return;
              cancel.abort(new Error('the caller hung up'));
            });
            void client
              .callTool({ name, arguments: args ?? {} }, { signal: cancel.signal })
              .then((result) => json(response, 200, result))
              .catch((cause: unknown) => {
                // The response socket is already gone when the caller hung up; writing to it would
                // throw where nothing is listening for the throw.
                if (cancel.signal.aborted) return;
                json(response, 502, { error: String(cause) });
              });
          })
          .catch((cause: unknown) =>
            json(response, 400, { error: `unreadable body: ${String(cause)}` }),
          );
      },
    },
  });

  return {
    gateway,
    model,
    tabs: () => [...tabs.values()].map(summarise),
    close: async () => {
      for (const tab of tabs.values()) await tab.client?.close();
      tabs.clear();
      await gateway.close();
    },
  };
}
