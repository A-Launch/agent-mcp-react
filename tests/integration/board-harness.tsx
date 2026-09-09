import { Board } from '@agent-mcp/example-composable-board/src/components/Board.tsx';
import { useConfirmationSurface } from '@agent-mcp/example-composable-board/src/components/ConfirmationDialog.tsx';
import { resetBoardForTests } from '@agent-mcp/example-composable-board/src/state/board.ts';
import { type BrowserConnection, connectClient, startGateway } from '@agent-mcp/mock-agent';
// Imported for its SIDE EFFECT, exactly as the demonstrator's own entry point imports it: it declares
// `board.add_panel`, `board.remove_panel` and `board.reorder` at module scope, before anything renders.
// Without this line the suite would mount a board with no way to compose it — and the symptom would be
// an empty tool list rather than an error, which is precisely the failure mode worth a comment.
import '@agent-mcp/example-composable-board/src/shell-tools.ts';
// The PURE entry point. `@testing-library/react` registers an automatic `cleanup()` in `afterEach`
// whenever globals are enabled, which this project enables — and these cases build one application and
// advance it, so an automatic teardown between cases would destroy the world mid-narrative.
import { cleanup, render } from '@testing-library/react/pure';
import type { ReactNode } from 'react';
import { AgentMcpProvider } from '../../src/index.ts';
import { createAjvValidator } from '../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';

// The harness for `examples/composable-board`.
//
// **A SECOND harness, and not an accident.** `tests/integration/harness.tsx` is not general: it imports
// `examples/customer-dashboard`'s router, store and shell tools unconditionally — the last for its side
// effect — so driving this demonstrator through it would mount the wrong application and put
// `shell.go_to` into the baseline the tool-surface cases measure against. Two demonstrators need two
// harnesses; what they share is the SHAPE, not the module.
//
// Everything the library does here is real: a real gateway on a real socket, a real MCP client, a real
// provider, and the demonstrator's own store, catalog, panels and tools imported rather than reproduced.
//
// **What this composes, and therefore what it cannot catch.** Not `App`. `App` reads its connection URL
// from a ticket endpoint this suite does not run, so the provider is constructed here with a URL from
// the gateway it started itself. Everything below that seam IS the demonstrator. The cost, stated
// because a reader is entitled to the shape of the hole: a regression confined to `App`'s own wiring —
// its provider nesting, its validator, its hardcoded capability set — leaves this suite green. That
// surface belongs to the live run in `quickstart.md`, and this repository has measured why that is
// not a formality: a fully green suite once missed three defects that one live run in a browser found.

const toClose: Array<() => Promise<void> | void> = [];

/** One running board, and the agent's view of it. */
export interface BoardApplication {
  readonly client: Awaited<ReturnType<typeof connectClient>>;
  readonly rendered: ReturnType<typeof render>;
}

/** Declares the environment a real page is in. jsdom does not implement `isSecureContext`. */
function declareSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

function BoardRoot({ url }: { readonly url: () => string }): ReactNode {
  const confirmation = useConfirmationSurface();
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: () => url() }}
      server={{ name: 'composable-board', version: '0.1.0' }}
      validation={{ validator: createAjvValidator() }}
      confirmation={{ resolver: confirmation.resolver }}
      onUnexpectedState={(failure) => {
        // Loud rather than collected. Nothing in these cases should reach this destination, so anything
        // that does is a broken invariant they must not run past silently — an unexpected state fails
        // loud, and is never swallowed.
        throw failure;
      }}
    >
      <Board />
      {confirmation.dialog}
    </AgentMcpProvider>
  );
}

/**
 * Starts a gateway, mounts the board, and connects an agent to it.
 *
 * The suite starts its own gateway rather than expecting one: `pnpm test:integration` is named in the
 * health gate, and a gate command that needs a server started first is a gate that gets skipped.
 *
 * **The store is reset first.** It lives at module scope — which is the whole reason the composition
 * tools can be declared at import time — so without this a case would inherit whatever panels the
 * previous file created. The id counter is deliberately NOT reset: a case that depended on ids
 * restarting at 1 would depend on the one property the store does not promise.
 */
export async function startBoard(): Promise<BoardApplication> {
  declareSecureContext();
  resetBoardForTests();

  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });
  const gateway = await startGateway({ onConnection: (connection) => announce?.(connection) });
  toClose.push(() => gateway.close());

  const rendered = render(<BoardRoot url={() => gateway.mintUrl('board-tab')} />);

  const client = await connectClient(await accepted);
  toClose.push(() => client.close());

  return { client, rendered };
}

/** Tears everything down. Called once, after a file's cases. */
export async function stopBoard(): Promise<void> {
  cleanup();
  for (const close of toClose.splice(0)) await close();
  resetBoardForTests();
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Waits until an observable condition holds, naming it when it never does.
 *
 * Never a fixed delay. A duration long enough to pass today is a synchronization mechanism that fails
 * on a slower machine and then gets widened instead of the cause being fixed.
 *
 * **What it is legitimately waiting for.** Every use here waits on a SOCKET ROUND TRIP — a listing or a
 * notification crossing a real WebSocket — which is a genuinely asynchronous boundary and exactly what
 * polling is for. It is NOT a licence to let a local invariant become true late: withdrawal is
 * synchronous in the unmount effect, and a loop that absorbed a delay there would be hiding a defect
 * rather than waiting for a message. The tell is which side of the socket the condition lives on.
 */
export async function until(
  holds: () => boolean | Promise<boolean>,
  description: string,
  turns = 200,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await holds()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waited for ${description} and it never became true`);
}

/** The tool names the AGENT can see. Asserted through the client, never through the registry. */
export async function listedNames(client: BoardApplication['client']): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

/** Calls a tool and returns its text content plus whether it was an error. */
export async function call(
  client: BoardApplication['client'],
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ readonly text: string; readonly isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
  };
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
  return { text, isError: result.isError === true };
}
