import {
  type BrowserConnection,
  connectClient,
  type Gateway,
  startGateway,
} from '@agent-mcp/mock-agent';
import type { AgentCapabilities } from '../../../src/index.ts';
import type {
  BuiltInTool,
  ConfirmationResolver,
  DeclaredPermissions,
  OwnershipRecord,
  RuntimeError,
  ToolCallContext,
  ToolHandler,
} from '../../../src/runtime/index.ts';
import { createMcpRuntime, type McpRuntime } from '../../../src/runtime/index.ts';
import { createBrowserWebSocketTransport } from '../../../src/transport/index.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { ensureRegistry, register } from '../../../src/webmcp/index.ts';
import { resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// A whole stack, with nothing stubbed: this library's runtime over this library's transport, dialing
// the mock agent's real gateway, driven by a real MCP client.
//
// `InMemoryTransport` would be simpler and is deliberately not used. It is sound for protocol
// semantics and unsound for anything touching the wire, because it passes message objects BY
// REFERENCE and never serializes them — which is how one of this feature's research probes reported
// that unserializable results were fine when in fact they produce total silence. A suite can be wrong
// in exactly that way.
//
// The registry here is the real one too, resolved through the boundary. Registering a tool means
// putting it in the document's registry AND recording it in the ownership record, which is precisely
// what `useMcpTool` does inside an effect.

/**
 * The mock agent's MCP client, typed from the factory rather than imported.
 *
 * `@modelcontextprotocol/client` is a dependency of `tools/mock-agent`, not of the library — the
 * browser is the SERVER here, so the root package has no business resolving a client package.
 */
type AgentClient = Awaited<ReturnType<typeof connectClient>>;

/** Everything a case needs, torn down by `closeAll()`. */
export interface Stack {
  readonly runtime: McpRuntime;
  readonly client: AgentClient;
  /**
   * The gateway's record of the connection this stack is holding, including the identity it presented.
   *
   * Exposed so a case can assert what the connection CARRIED rather than assume it. The harness has
   * always dialled with a tab id, which made "the runtime derives nothing from a connection" a claim
   * about an identity-bearing connection only by accident — and an accident is not something a later
   * change can be held to.
   */
  readonly connection: BrowserConnection;
  /** Registers a tool the way this library does: into the registry, and into the ownership record. */
  register(
    name: string,
    handler: ToolHandler,
    description?: string,
    permissions?: DeclaredPermissions,
  ): Promise<() => void>;
  /**
   * Changes what the connection may reach, without reconnecting or re-registering anything.
   *
   * The point of the method is that there is nothing else to do: the runtime reads the set at each
   * gate, so a case grants or withdraws a capability and the very next call sees it. A harness that
   * had to rebuild the runtime here would be a harness proving the opposite of what these cases claim.
   */
  grant(capabilities: AgentCapabilities): void;
  /** Installs, replaces or removes the confirmation surface, without rebuilding anything. */
  askWith(resolver: ConfirmationResolver | undefined): void;
  /** Rewrites what a registered tool declares about reaching it, the way a `refresh` would. */
  reoffer(name: string, permissions: DeclaredPermissions | undefined): void;
  /**
   * The same registration, with a deliberate gap between the registry write and the ownership write.
   *
   * The gap is not artificial in kind, only in size: `src/react/registration.ts` writes the registry
   * first and records ownership after, so the registry's change event is ALWAYS queued while the
   * record still knows nothing. Widening the window makes the consequence observable instead of
   * leaving it to microtask luck — with only the registry as a change source, a listing derived in
   * that window excludes the new tool as another script's, and the agent is told to re-list and finds
   * nothing.
   */
  registerWithLateOwnership(name: string, handler: ToolHandler): Promise<() => void>;
  /**
   * Registers a tool that declares schemas, compiling them the way the gateway does.
   *
   * Compiled here rather than handed in already-compiled, so a case exercises the same path an
   * application takes: a schema that cannot compile fails here, at declaration, exactly as it would in
   * a page.
   */
  registerWithSchemas(
    name: string,
    handler: ToolHandler,
    schemas: { input?: Record<string, unknown>; output?: Record<string, unknown> },
    permissions?: DeclaredPermissions,
  ): Promise<() => void>;
  /** Registers directly into the registry, bypassing this library — a tool another script owns. */
  registerForeign(name: string): Promise<void>;
  /** Records an entry with NO registry registration, to construct a divergence on purpose. */
  recordWithoutRegistering(name: string, handler?: ToolHandler): void;
  /** Everything that reached the unexpected-state destination. */
  readonly unexpected: readonly RuntimeError[];
  /**
   * Ends the socket without shutting the runtime down — a gateway restarting, a laptop sleeping.
   *
   * Distinct from `shutdown()` on purpose: the runtime learns about it only through the protocol
   * layer's close path, which is the path that used to leave `serving` true.
   */
  dropSocket(): void;
  /**
   * Makes every subsequent notification send fail, with the connection otherwise up.
   *
   * Exists so the "nothing was reported" cases in the lifecycle suite can be paired with one where
   * something must be. Without the pairing, a publisher that reported nothing ever would pass them.
   */
  breakSending(cause: Error): void;
  /**
   * Every JSON-RPC message the PAGE has put on the wire, in order.
   *
   * Recorded because "no response was sent" is otherwise unfalsifiable from the client's side: a
   * client that rejected its own call looks identical whether the page answered or said nothing.
   */
  readonly sent: readonly unknown[];
}

const toClose: Array<() => Promise<void> | void> = [];

export async function closeAll(): Promise<void> {
  for (const close of toClose.splice(0)) await close();
  resetResolutionForTests();
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Declares the page a secure context.
 *
 * jsdom does not implement `isSecureContext`, and the registry boundary treats an environment that
 * cannot say whether it is secure as not being one — silence is not a secure context. A real browser
 * page served over HTTPS or from localhost answers this itself; here it has to be stated.
 */
function declareSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Stands up a runtime connected to a real gateway, with a real client attached.
 *
 * The order matters and mirrors the real one: the runtime connects (which starts the transport and
 * dials), the gateway accepts, and only then does the client attach and send `initialize`. A client
 * attaching before the server is connected would miss the handshake.
 */
/** What a case can vary about the stack it mounts. */
export interface StackOptions {
  /**
   * The Level 2 and Level 3 tools this runtime ships.
   *
   * Synthetic, always: a case supplies its own table rather than the shipped one. They go through the
   * same internal seam `src/dom/` uses, which is what makes a case here a test of the route rather
   * than of a shape invented for the test.
   */
  readonly builtIns?: readonly BuiltInTool[];
  /**
   * An ownership record the CALLER owns, rather than letting the runtime create one.
   *
   * Present so a case can assert the property a reconnection depends on: the record outlives the
   * runtime, because a runtime is per-connection and a registration is not.
   */
  readonly ownership?: OwnershipRecord;
}

export async function stack(options: StackOptions = {}): Promise<Stack> {
  declareSecureContext();

  let announce: ((connection: BrowserConnection) => void) | undefined;
  const accepted = new Promise<BrowserConnection>((resolve) => {
    announce = resolve;
  });

  const gateway: Gateway = await startGateway({
    onConnection: (connection) => announce?.(connection),
  });
  toClose.push(() => gateway.close());

  const unexpected: RuntimeError[] = [];
  // Mutable, and read through a closure rather than copied into the runtime — which is the point of
  // the option's shape. A case that grants or withdraws a capability mid-connection is asserting that
  // the gate reads the set at the call, and it could not do that against a snapshot.
  let capabilities: AgentCapabilities = APPLICATION_ONLY;
  let resolver: ConfirmationResolver | undefined;
  const runtime = createMcpRuntime({
    ...(options.ownership === undefined ? {} : { ownership: options.ownership }),
    serverInfo: { name: 'page-under-test', version: '0.0.0' },
    onUnexpectedState: (failure) => unexpected.push(failure),
    capabilities: () => capabilities,
    confirmationResolver: () => resolver,
    ...(options.builtIns === undefined ? {} : { builtIns: options.builtIns }),
  });

  // The real transport, with one seam: after `breakSending`, an outgoing tool-list-changed frame
  // rejects. Every other message is untouched, so the connection stays genuinely up — which is what
  // makes the resulting alarm the one the publisher is supposed to raise.
  let failNotificationSends: Error | undefined;
  const transport = createBrowserWebSocketTransport({ getUrl: () => gateway.mintUrl('tab-1') });
  const sent: unknown[] = [];
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const method = (message as { method?: unknown }).method;
    if (failNotificationSends !== undefined && method === 'notifications/tools/list_changed') {
      throw failNotificationSends;
    }
    sent.push(message);
    return send(message, options);
  };

  await runtime.connect(transport);
  toClose.push(() => runtime.shutdown());

  const connection = await accepted;
  const client = await connectClient(connection);
  toClose.push(() => client.close());

  const controllers: AbortController[] = [];
  toClose.push(() => {
    for (const controller of controllers.splice(0)) controller.abort();
  });

  return {
    runtime,
    client,
    connection,
    unexpected,
    sent,

    dropSocket() {
      connection.socket.terminate();
    },

    grant(next) {
      capabilities = next;
    },

    askWith(next) {
      resolver = next;
    },

    reoffer(name, permissions) {
      const entry = runtime.ownership.entryFor(name);
      if (entry === undefined) throw new Error(`no entry for ${name}`);
      const { permissions: _replaced, ...carried } = entry;
      runtime.ownership.add(name, {
        ...carried,
        ...(permissions === undefined ? {} : { permissions }),
      });
    },

    breakSending(cause) {
      // Broken at the WIRE, not by reaching into the runtime. The runtime deliberately exposes no
      // path to its protocol layer, and a test that added one would be creating the public route past
      // the gates that `src/index.ts` exists to refuse. What fails here is the frame this
      // notification actually needs written — which is also the real-world shape of the failure.
      failNotificationSends = cause;
    },

    async register(name, handler, description = `the ${name} tool`, permissions) {
      const controller = new AbortController();
      controllers.push(controller);
      // The DECLARATION lifetime, kept separate from the registration controller for the same reason
      // the hook keeps them apart: one ends when this registration is withdrawn, the other when the
      // tool stops being declared at all. This harness never replaces a descriptor, so the two happen
      // to end together here — modelling them as one object would still be wrong, because the entry
      // would then carry a signal that means something different from what the hook puts there.
      const lifetime = new AbortController();
      controllers.push(lifetime);
      const declaration = {
        name,
        description,
        inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
        // The registry-facing handler. It exists because the registry requires one and any page script
        // can reach it — the bridged path does NOT go through here, because the bridge invokes the
        // handler it registered, directly (docs/design.md#tool-results).
        handler: (args: Record<string, unknown>) =>
          handler(args, {
            signal: lifetime.signal,
            afterRender: () => Promise.resolve(),
          }),
      };
      await register(declaration, controller.signal, runtime.ownership);
      runtime.ownership.add(name, {
        controller,
        handler,
        declaration,
        lifetime: lifetime.signal,
        ...(permissions === undefined ? {} : { permissions }),
      });
      return () => {
        controller.abort();
        lifetime.abort();
        runtime.ownership.remove(name);
      };
    },

    async registerWithLateOwnership(name, handler) {
      const controller = new AbortController();
      controllers.push(controller);
      const declaration = {
        name,
        description: `the ${name} tool`,
        inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
        handler: (args: Record<string, unknown>) =>
          handler(args, {
            signal: new AbortController().signal,
            afterRender: () => Promise.resolve(),
          }),
      };
      await register(declaration, controller.signal, runtime.ownership);
      await new Promise((resolve) => setTimeout(resolve, 20));
      runtime.ownership.add(name, { controller, handler, declaration });
      return () => {
        controller.abort();
        runtime.ownership.remove(name);
      };
    },

    async registerWithSchemas(name, handler, schemas, permissions) {
      const controller = new AbortController();
      controllers.push(controller);
      const validator = createAjvValidator();
      const declaration = {
        name,
        description: `the ${name} tool`,
        inputSchema: (schemas.input ?? { type: 'object', properties: {} }) as Record<
          string,
          unknown
        >,
        handler: (args: Record<string, unknown>) =>
          handler(args, {
            signal: new AbortController().signal,
            afterRender: () => Promise.resolve(),
          }),
      };
      await register(declaration, controller.signal, runtime.ownership);
      runtime.ownership.add(name, {
        controller,
        handler,
        declaration,
        ...(schemas.output === undefined ? {} : { outputSchema: schemas.output }),
        ...(permissions === undefined ? {} : { permissions }),
        validators: {
          ...(schemas.input === undefined ? {} : { input: await validator.compile(schemas.input) }),
          ...(schemas.output === undefined
            ? {}
            : { output: await validator.compile(schemas.output) }),
        },
      });
      return () => {
        controller.abort();
        runtime.ownership.remove(name);
      };
    },

    async registerForeign(name) {
      // Straight into the document's registry, with no ownership record entry. This is what another
      // library, a widget or an extension's page script does — and the registry is shared with all of
      // them, so it is the normal condition rather than an attack.
      const { registry } = await ensureRegistry();
      const controller = new AbortController();
      controllers.push(controller);
      await registry.registerTool(
        {
          name,
          description: `${name}, registered by somebody else`,
          inputSchema: { type: 'object', properties: {} },
          execute: () => ({ content: [{ type: 'text', text: 'from a foreign script' }] }),
        },
        { signal: controller.signal },
      );
    },

    recordWithoutRegistering(name, handler = () => 'never reachable') {
      // The record believes we registered something the registry does not have — a broken invariant,
      // constructed on purpose because it is the one condition the runtime must report rather than
      // treat as a normal absence.
      runtime.ownership.add(name, {
        controller: new AbortController(),
        handler,
        declaration: { name, description: name, handler: () => undefined },
      });
    },
  };
}

/** A context whose signal never fires, for unit-level calls that are not about cancellation. */
export function inertContext(): ToolCallContext {
  return { signal: new AbortController().signal, afterRender: () => Promise.resolve() };
}
