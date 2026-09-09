import {
  type BrowserConnection,
  connectClient,
  type Gateway,
  startGateway,
} from '@agent-mcp/mock-agent';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  AgentCapabilities,
  ConfirmationDecision,
  ConfirmationRequest,
  McpObservedCall,
  McpRegistrationEvent,
  McpRegistryChangeEvent,
  ObservedPayloads,
} from '../../../src/index.ts';
import { AgentMcpProvider, type UnexpectedStateReport } from '../../../src/react/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// The whole stack, with nothing stubbed: a real provider rendered into a document, its real transport
// dialing the mock agent's real gateway, driven by a real MCP client.
//
// `InMemoryTransport` would be simpler and is deliberately not used, for a reason this repository
// measured: it passes message objects BY REFERENCE and never serializes them, which is how an earlier
// probe reported unserializable results were fine when in fact they produce total silence.
//
// **Assertions go through the client**, never through the library's own ownership record. A record
// that agrees with a broken `tools/list` is a test of the record.
//
// The renderer runs here with a per-file `// @vitest-environment jsdom` docblock in each case file,
// no `globals`, and `cleanup()` called explicitly — this project is `node` by default and has no
// setup file. Skipping the cleanup leaves a tree mounted, its tools registered, and the next case
// asserting against a registry its predecessor polluted.

type AgentClient = Awaited<ReturnType<typeof connectClient>>;

export interface Stack {
  /** The agent's view. Everything an assertion about behaviour should go through. */
  readonly client: AgentClient;
  /** Renders children inside a mounted provider, and resolves once it reports connected. */
  readonly rendered: ReturnType<typeof render>;
  /** Everything that reached the provider's unexpected-state destination. */
  readonly unexpected: readonly UnexpectedStateReport[];
  /**
   * Every observability event the provider delivered, in the order it arrived.
   *
   * All three phases in ONE list rather than three, because the properties worth asserting are about
   * their ORDER and their pairing — a start before its terminal, exactly one terminal per call — and
   * three separate lists would lose exactly that.
   */
  readonly observed: readonly McpObservedCall[];
  /** Every registry reconciliation reported, in order. */
  readonly reconciliations: readonly McpRegistryChangeEvent[];
  /** Every declaration refused before it became a tool. */
  readonly registrations: readonly McpRegistrationEvent[];
  /** Every connection state the provider reported, in order. */
  readonly states: readonly string[];
  /**
   * How many times the provider asked for a connection URL — one per connection ATTEMPT.
   *
   * A monotonic counter, and that is why it exists. An absence asserted by "the state list looks the
   * same after some turns" can be satisfied by a teardown and redial that finished before the
   * comparison ran; a count that never decreases cannot.
   */
  dials(): number;
  /**
   * How many change events the document's tool registry has emitted since `stack()` returned.
   *
   * **Never a registration count.** A withdraw-and-register cycle leaves the count of registrations at
   * exactly one — correct at rest and correct after every cycle — which is precisely how a cycle per
   * rerender once shipped past a suite that counted registrations. The change event is what an agent
   * observes as a `tools/list_changed` storm, and it is monotonic, so an absence asserted on it
   * cannot be satisfied by something that happened and was undone.
   */
  registryChanges(): number;
  /**
   * How many `notifications/tools/list_changed` frames the page has actually written to the socket.
   *
   * Counted on the WIRE. "The listing is different when I ask again" is a weaker claim that a polling
   * agent would also satisfy — and nothing polls, by design, so the notification is the entire
   * mechanism by
   * which an agent learns anything changed. A page whose listing is right and whose notifications are
   * missing looks perfect to a test that re-lists and is silently stale to a real agent.
   */
  notifications(): number;
  /** Ends the channel from the agent's side, the way a stopped agent runtime would. */
  closeFromPeer(): void;
  /**
   * How many connections the gateway has accepted — monotonic, so it measures a RECOVERY rather than a
   * state list that a teardown and redial could reproduce.
   */
  connectionCount(): number;
  /** The live connection, for a case that must attach a client to the one a recovery produced. */
  latest(): BrowserConnection | undefined;
  /**
   * The gateway this page is dialling, so a case can count credentials at the minter.
   *
   * Counting there rather than at the page is the difference between "two attempts happened" and "two
   * credentials were issued and both were used" — and a retry that takes a credential and abandons it
   * leaks one, which is the shape a fresh-credential bug leaves behind.
   */
  readonly gateway: Gateway;
  /** Every credential the page has dialled with, in order. */
  credentials(): readonly string[];
  /**
   * Rerenders the SAME provider with a different capability set — a prop change, not a remount.
   *
   * That is the whole point of the method. The claim under test is that a capability change costs an
   * application nothing: no reconnection, no registry churn, no remount. A helper that rebuilt the
   * tree would be demonstrating the opposite while appearing to demonstrate this.
   */
  grant(capabilities: AgentCapabilities): void;
  /**
   * Rerenders the SAME provider with different children — an application changing, not remounting.
   *
   * `rendered.rerender` on its own would drop the provider, because the element the harness rendered
   * is the provider wrapping these children. A case that did that would unmount the whole library and
   * then assert against what was left, which is a different scenario wearing this one's name.
   */
  setChildren(children: ReactNode): void;
}

const sharedValidator = createAjvValidator();

const toClose: Array<() => Promise<void> | void> = [];

export async function closeAll(): Promise<void> {
  cleanup();
  for (const close of toClose.splice(0)) await close();
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Declares the page a secure context.
 *
 * jsdom does not implement `isSecureContext`, and the boundary treats an environment that cannot say
 * whether it is secure as not being one — silence is not a secure context. A real page answers this
 * itself; here it has to be stated.
 */
export function declareSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Mounts a provider with `children` beneath it and attaches a real client to the connection it makes.
 *
 * The order mirrors the real one: the gateway is listening, the provider mounts and dials, the gateway
 * accepts, and only then does the client attach and send `initialize`. A client attaching before the
 * page connected would miss the handshake.
 */
export interface StackOptions {
  /**
   * How long a credential this gateway mints stays valid.
   *
   * Present so a case can drive the expiry boundary deterministically rather than waiting out the
   * default. The interesting boundary is where a backoff interval approaches a credential's lifetime —
   * which in a real deployment is the schedule's 30 s maximum against a recommended 30 s lower bound,
   * and is far too slow to wait for.
   */
  readonly ticketTtlMs?: number;
  /**
   * Who answers a tool that declares `confirmation: 'required'`.
   *
   * Absent means the provider is given none, which is itself a case worth driving — a tool that needs
   * a person and has nobody to ask is REFUSED rather than admitted.
   */
  readonly confirmation?: (request: ConfirmationRequest) => Promise<ConfirmationDecision>;
  /**
   * What observability events may carry.
   *
   * Absent means the provider's own default, which is `metadata` in every build — so a case that says
   * nothing here is asserting against the configuration an application gets without asking for one.
   */
  readonly payloads?: ObservedPayloads;
  /**
   * What the agent reaching this page may do.
   *
   * Absent means `APPLICATION_ONLY`. A case that is ABOUT a capability passes its own set, because
   * reading the granted set at the assertion is the whole point of such a case.
   */
  readonly capabilities?: AgentCapabilities;
}

export async function stack(children: ReactNode, options: StackOptions = {}): Promise<Stack> {
  declareSecureContext();

  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });

  /**
   * Every connection the gateway has accepted, in order.
   *
   * A LIST rather than one value, because a reconnection produces a second — and a helper that kept
   * only the first would close a socket that is already dead while the live one carried on, which
   * reads exactly like a reconnection that did not happen.
   */
  const connections: BrowserConnection[] = [];

  const gateway: Gateway = await startGateway({
    ...(options.ticketTtlMs === undefined ? {} : { ticketTtlMs: options.ticketTtlMs }),
    onConnection: (connection) => {
      connections.push(connection);
      announce?.(connection);
    },
  });
  toClose.push(() => gateway.close());

  const unexpected: UnexpectedStateReport[] = [];
  const observed: McpObservedCall[] = [];
  const reconciliations: McpRegistryChangeEvent[] = [];
  const registrations: McpRegistrationEvent[] = [];
  const states: string[] = [];
  let dials = 0;
  /** What each attempt actually presented, so a replay is visible rather than inferred. */
  const credentials: string[] = [];

  let currentCapabilities: AgentCapabilities = options.capabilities ?? APPLICATION_ONLY;
  let currentChildren = children;

  const tree = (capabilities: AgentCapabilities, inside: ReactNode): ReactNode => (
    <AgentMcpProvider
      capabilities={capabilities}
      connection={{
        getUrl: () => {
          dials += 1;
          const url = gateway.mintUrl('tab-1');
          credentials.push(new URL(url).searchParams.get('ticket') ?? '');
          return url;
        },
      }}
      server={{ name: 'page-under-test', version: '0.0.0' }}
      validation={{ validator: sharedValidator }}
      onUnexpectedState={(failure: UnexpectedStateReport) => unexpected.push(failure)}
      onConnectionChange={(state: { status: string }) => states.push(state.status)}
      onToolCall={(event) => observed.push(event)}
      onToolResult={(event) => observed.push(event)}
      onToolError={(event) => observed.push(event)}
      onRegistryChange={(event) => reconciliations.push(event)}
      onRegistration={(event) => registrations.push(event)}
      {...(options.payloads === undefined ? {} : { observability: { payloads: options.payloads } })}
      {...(options.confirmation === undefined
        ? {}
        : { confirmation: { resolver: options.confirmation } })}
    >
      {inside}
    </AgentMcpProvider>
  );

  const rendered = render(tree(currentCapabilities, currentChildren));

  const client = await connectClient(await accepted);
  toClose.push(() => client.close());

  // Counted from the browser side of the socket, which is the side that decides to send.
  let notifications = 0;
  const connectionForFrames = await accepted;
  connectionForFrames.socket.on('message', (raw: unknown) => {
    if (String(raw).includes('notifications/tools/list_changed')) notifications += 1;
  });

  // Attached after the provider resolved a registry, which is the only moment one exists to listen on.
  let registryChanges = 0;
  const registryHost = (document as unknown as { modelContext?: EventTarget }).modelContext;
  const countChange = (): void => {
    registryChanges += 1;
  };
  registryHost?.addEventListener('toolchange', countChange);
  toClose.push(() => registryHost?.removeEventListener('toolchange', countChange));

  const connection = await accepted;

  return {
    client,
    rendered,
    unexpected,
    observed,
    reconciliations,
    registrations,
    states,
    closeFromPeer() {
      // The LIVE connection, not the first one. After a recovery the first is already closed, and
      // closing it again is a no-op that looks like a drop the page ignored.
      (connections.at(-1) ?? connection).close();
    },
    connectionCount: () => connections.length,
    gateway,
    credentials: () => credentials,
    latest: () => connections.at(-1),
    grant(capabilities) {
      currentCapabilities = capabilities;
      rendered.rerender(tree(currentCapabilities, currentChildren));
    },
    setChildren(next) {
      currentChildren = next;
      rendered.rerender(tree(currentCapabilities, currentChildren));
    },
    dials: () => dials,
    registryChanges: () => registryChanges,
    notifications: () => notifications,
  };
}

/**
 * Waits until an observable condition holds, naming it when it never does.
 *
 * Never a fixed delay: a duration long enough to pass today is a synchronization mechanism that fails
 * on a slower machine and gets widened instead of fixed.
 */
export async function until(
  holds: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (await holds()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`waited for ${description} and it never became true`);
}

/** The names an agent currently sees, which is the only listing an assertion should trust. */
export async function listedNames(client: AgentClient): Promise<string[]> {
  const listing = await client.listTools();
  return listing.tools.map((tool) => tool.name);
}
