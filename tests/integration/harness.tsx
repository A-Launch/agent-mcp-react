import { RoutedScreensInMemory } from 'agent-mcp-example-customer-dashboard/src/router.tsx';
import { DashboardProvider } from 'agent-mcp-example-customer-dashboard/src/state/dashboard.tsx';
import { type BrowserConnection, connectClient, startGateway } from 'agent-mcp-mock-agent';
// Imported for its SIDE EFFECT, exactly as the demonstrator's own entry point imports it: it declares
// `shell.go_to` at module scope, before anything renders. Without this line the suite would mount the
// screens and miss the one tool that is not owned by a screen — and step 13a, which checks that a
// shell-owned tool SURVIVES the navigation that removes the others, would have nothing to find.
import 'agent-mcp-example-customer-dashboard/src/shell-tools.ts';
// **The PURE entry point, and this is not a style choice.** `@testing-library/react` registers an
// automatic `cleanup()` in `afterEach` whenever globals are enabled — which this project enables. That
// unmounts the tree after EVERY case, and this suite's whole design is one application advanced by
// fourteen cases in order. With the auto-cleanup active, step 4 met a closed connection and step 6
// met an empty `<body />`: the world was being destroyed between steps, which is precisely the
// "rebuilt per case" failure this file is built to avoid, arriving from the test library rather than
// from the suite. `/pure` is the same API with the automatic teardown removed.
import { cleanup, render } from '@testing-library/react/pure';
import { type AgentCapabilities, AgentMcpProvider } from '../../src/index.ts';
import type { BuiltInTool } from '../../src/runtime/built-ins.ts';
import { createAjvValidator } from '../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';

// What makes this layer different from `tests/transport/react/`, which is otherwise the same shape:
// **it mounts the DEMONSTRATOR, not a fixture.**
//
// Both stand up a real gateway, connect a real MCP client and render a real provider into jsdom. The
// transport suite mounts components written to exercise one mechanism; this one mounts
// `examples/customer-dashboard` — its own pages, its own store, its own tools, declared by the
// components that own each feature. A change that breaks the demonstrator breaks this suite, and
// that is the entire reason the layer exists: real provider, real transport, real store, no stubbed
// runtime. See CONTRIBUTING.md#8-testing.
//
// **The one thing that is not exactly what ships**, recorded here as well as in the example's
// `router.tsx` because a reader of this file should not have to go looking: the screens are mounted
// on a COMPONENT router with in-memory history rather than the browser's data router. A data router
// navigates through `fetch`, and Node's `fetch` refuses an `AbortSignal` that is not its own while
// jsdom installs its own — so every `fetch(url, { signal })` fails here, measured with a bare fetch
// and no router involved. The routes, pages, components and tools are identical; only the history
// backend differs. And step 11 of the acceptance scenario is *"the USER navigates away"*, which a
// person does by clicking a link — which is what the scenario does.

const toClose: Array<() => Promise<void> | void> = [];

/** One running application, and the agent's view of it. */
export interface Application {
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

/**
 * Starts a gateway, mounts the demonstrator, and connects an agent to it.
 *
 * The suite starts its own gateway rather than expecting one: `pnpm test:integration` is one of the
 * commands the health gate runs after any change (CONTRIBUTING.md#3-the-gate), and a gate command
 * that needs a server started first is a gate that gets skipped.
 */
/**
 * **What this composes, and what it therefore cannot catch.**
 *
 * Not `App`. `App` reads its connection URL from `AMR_*` environment configuration and its capability
 * profile from an operator variable, and this suite must point the page at a gateway it started
 * itself — so the provider is constructed here with those two supplied directly. Everything below
 * that seam IS the demonstrator: its store, its routes, its pages, its components and every tool they
 * declare, imported rather than reproduced.
 *
 * The cost, stated because a reader is entitled to know the shape of the hole: a regression confined
 * to `App`'s own wiring — the nesting of its providers, which validator it installs, how it selects a
 * capability profile — would leave this suite green. That surface belongs to the live demonstration
 * and to `pnpm test:e2e`.
 */
export interface ApplicationOptions {
  /**
   * What this page's agent may reach. Defaults to Level 1 only, which is what the acceptance
   * scenario runs under.
   *
   * Parameterised rather than hardcoded: the DOM cases need `dom.inspect`, and the acceptance
   * narrative must keep running under exactly the profile it always has — a scenario whose
   * capability set widened to accommodate a later feature would stop being evidence about the one it
   * was written for.
   */
  readonly capabilities?: AgentCapabilities;
  /** Level 2 and Level 3 tools this page supplies. The acceptance scenario uses none. */
  readonly builtInTools?: readonly BuiltInTool[];
}

export async function startApplication(options: ApplicationOptions = {}): Promise<Application> {
  declareSecureContext();

  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });
  const gateway = await startGateway({ onConnection: (connection) => announce?.(connection) });
  toClose.push(() => gateway.close());

  const rendered = render(
    <AgentMcpProvider
      capabilities={options.capabilities ?? APPLICATION_ONLY}
      {...(options.builtInTools === undefined ? {} : { builtInTools: options.builtInTools })}
      connection={{ getUrl: () => gateway.mintUrl('acceptance-tab') }}
      server={{ name: 'customer-dashboard', version: '0.1.0' }}
      validation={{ validator: createAjvValidator() }}
      onUnexpectedState={(failure) => {
        // Loud rather than collected. Nothing in the acceptance scenario should reach this
        // destination, so anything that does is a broken invariant the scenario must not run past
        // silently — an unexpected state fails loud, and is never swallowed.
        throw failure;
      }}
    >
      <DashboardProvider>
        <RoutedScreensInMemory />
      </DashboardProvider>
    </AgentMcpProvider>,
  );

  const client = await connectClient(await accepted);
  toClose.push(() => client.close());

  return { client, rendered };
}

/** Tears everything down. Called once, after the whole narrative. */
export async function stopApplication(): Promise<void> {
  cleanup();
  for (const close of toClose.splice(0)) await close();
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Waits until an observable condition holds, naming it when it never does.
 *
 * Never a fixed delay. A duration long enough to pass today is a synchronization mechanism that fails
 * on a slower machine and gets widened instead of the cause being fixed.
 *
 * **What it is legitimately waiting for, since the distinction is the whole of whether this is
 * allowed.** Every use here waits on a SOCKET ROUND TRIP — the tool listing an MCP client holds is
 * refreshed by a request and a notification crossing a real WebSocket, so there is no moment in this
 * process at which the answer is already available and being re-checked. That is a genuinely
 * asynchronous boundary, and polling one is what `waitFor` exists for.
 *
 * It is NOT a licence to let a local invariant become true late. Withdrawal itself is synchronous in
 * the unmount effect; if a future change made a tool linger in the registry and this loop absorbed
 * the delay, the loop would be hiding a defect rather than waiting for a message. The tell is which
 * side of the socket the condition lives on: through the client, poll; in the page, do not.
 *
 * Step 13 is the reason that distinction is safe here — it calls the withdrawn tool and requires an
 * immediate refusal, with no waiting of any kind.
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
export async function listedNames(client: Application['client']): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}
