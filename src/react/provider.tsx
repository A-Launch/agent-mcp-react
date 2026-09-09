import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Adopter, PendingDeclaration } from '../actions/queue.ts';
import { adopt as adoptDeclarations, release as releaseDeclarations } from '../actions/queue.ts';
import { IS_DEVELOPMENT } from '../build-mode.ts';
import type { BuiltInTool } from '../runtime/built-ins.ts';
import type {
  ConfirmationResolver,
  DeclaredPermissions,
  ObservationBus,
  OwnershipEntry,
} from '../runtime/index.ts';
import {
  type AgentCapabilities,
  CALL_PHASE,
  CALL_ROUTE,
  capabilitySignature,
  createMcpRuntime,
  createObservationBus,
  createOwnershipRecord,
  DENIES_EVERYTHING,
  describeProblems,
  type McpRuntime,
  normalizeCapabilities,
  OBSERVED_PAYLOADS,
  type ObservedPayloads,
  RUNTIME_FAILURE,
  RuntimeError,
} from '../runtime/index.ts';
import type { SchemaValidator } from '../runtime/validation.ts';
import {
  type ConnectionUrlSupplier,
  createBrowserWebSocketTransport,
  isTransportFailureCode,
} from '../transport/index.ts';
import { createReconnectSchedule } from '../transport/reconnect.ts';
import type { ToolDeclaration } from '../webmcp/index.ts';
import {
  claimDocument,
  ensureRegistry,
  REGISTRATION_REFUSED,
  REGISTRY_UNAVAILABLE,
  releaseDocument,
  WebMcpBoundaryError,
} from '../webmcp/index.ts';
import {
  CONNECTION_STATUS,
  type ConnectionStatus,
  type McpConnectionState,
  permitsTransition,
} from './connection-state.ts';
import {
  type AgentMcpBinding,
  AgentMcpBindingContext,
  McpCapabilitiesContext,
  McpConnectionContext,
} from './context.ts';
import { sameDescriptor, sameValue } from './descriptor.ts';
import { AgentMcpReactError, REACT_REFUSED, type UnexpectedStateReport } from './errors.ts';
import type {
  McpObservedCall,
  McpRegistrationEvent,
  McpRegistryChangeEvent,
  McpToolCallEvent,
  McpToolErrorEvent,
  McpToolResultEvent,
} from './observability.ts';
import { createRegistrationGateway } from './registration.ts';
import { declarationOf, type McpToolDefinition } from './use-mcp-tool.ts';

// `AgentMcpProvider`: mounting it makes the page an MCP server an agent can reach, and unmounting it
// leaves the document exactly as it was.
//
// What it owns: the document claim, registry resolution, one runtime, one connection attempt, and the
// connection state an application reads. All of it in an effect, after commit — a render that never
// commits must expose nothing, and module scope would break server rendering
// (docs/design.md#the-provider).
//
// What it does NOT own, so that each absence reads as a decision: the gate decisions themselves — the
// runtime enforces them, reading the set this provider holds — the socket and the backoff arithmetic,
// which belong to the transport, what any tool IS, which the components and the application shell
// declare, and any application state.
//
// **It accepts no prop it does not act on.** `capabilities` is required and it is enforced: it is
// checked before the registry is resolved, held in a ref the gates read live, and a change to it tells
// the agent. A capability prop that changed nothing would let an author believe an agent was
// restricted when it was not, which is worse than the prop being absent.

export interface AgentMcpProviderProps {
  readonly connection: {
    /**
     * Produces the connection URL for one attempt. Called once per attempt and never cached here.
     *
     * This is the seam a production credential service sits behind: the library takes a function, not
     * a credential, so nothing it holds can leak one.
     */
    readonly getUrl: ConnectionUrlSupplier;
  };
  readonly server: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * Where a broken invariant goes — an ownership divergence detected while serving a request.
   *
   * **Required, and deliberately not optional.** A list request still succeeds for every other tool
   * when one name diverges, so there is no response to carry the alarm, and a provider that could be
   * built without a destination is one whose alarms default to silence. It is never the agent: a
   * registry-integrity report is the operator's business.
   *
   * It is NOT where a refused DECLARATION goes — that is `onRegistration`, which carries every cause
   * with the code that refused it.
   *
   * **A refused declaration no longer throws, and that reverses what this line used to say.** The
   * argument for throwing was that an application cannot log past it. The argument against won: MCP is
   * a second control interface onto one application, and a misconfigured second interface must not
   * take down the first — an author who forgot a validator got a white screen, with the console
   * message naming the exact import sitting underneath a page that no longer rendered. What has not
   * changed is that the tool is not registered: refused is still refused, on every route.
   */
  readonly onUnexpectedState: (failure: UnexpectedStateReport) => void;
  /**
   * Tools this LIBRARY ships, supplied by the application — Level 2 and Level 3
   * (docs/dom-inspection.md, docs/javascript-evaluation.md).
   *
   * Invariant: **these are never registered.** They do not enter the document's shared tool registry
   * in any configuration, including one whose capability set grants them, because anything in that
   * registry is invokable by every script on the page with not one gate in the path
   * (docs/design.md#security-invariants). They exist only in the runtime's built-in table and the only
   * route to them is the bridged `tools/call` handler, where the capability gate runs.
   *
   * **Supplied rather than imported here, and that is the whole design.** This module does not import
   * the Level 2 directory: it has its own subpath export so a build that never asks for it never
   * contains it — the three levels of control are separate layers and one confers nothing on another
   * — and a static import from the provider would put it in every build of every application. So there
   * are TWO independent conditions and neither implies the other — the application opts in by
   * importing, the operator opts in by granting:
   *
   *   imported + granted     → reachable over the bridge
   *   imported + withheld    → `MCP_TOOL_CAPABILITY_DENIED` at invocation, absent from the listing
   *   not imported + granted → `MCP_TOOL_NOT_FOUND`; a granted capability is not a tool
   *   neither                → the build contains none of it
   *
   * Named for what it carries rather than for its first caller: `tools` would read as registration,
   * which is the one thing these never do, and `domTools` would name one caller in a seam
   * `runtime.evaluate` uses next.
   */
  readonly builtInTools?: readonly BuiltInTool[];
  /**
   * A call beginning, on EITHER route (docs/observing-tool-calls.md).
   *
   * Optional to pass, and genuinely optional in effect — unlike `validation`, which is optional to
   * pass and not optional at all in what it decides. With no observer supplied and no inspector
   * mounted, not one record is built: no id is issued, no timestamp is taken, nothing is copied.
   *
   * **It reports page-script calls too**, tagged with the route they arrived by. A surface that showed
   * only the agent's calls would let an operator read silence as "nobody called this tool", when any
   * widget or extension on the page can invoke it through the shared registry with none of this
   * library's gates in the path.
   */
  readonly onToolCall?: (event: McpToolCallEvent) => void;
  /** A call that settled with a result. */
  readonly onToolResult?: (event: McpToolResultEvent) => void;
  /**
   * A call that settled with a refusal, a throw or a cancellation.
   *
   * The event names WHICH gate step decided it, so a capability denial and an availability refusal are
   * never one indistinguishable "denied" — they send an operator to different places, because one is
   * an operator's decision about the connection and the other the application's about one tool.
   */
  readonly onToolError?: (event: McpToolErrorEvent) => void;
  /**
   * What events may carry.
   *
   * `metadata` unless explicitly set otherwise, in EVERY build including development. A build flag is
   * not consent to capture sensitive data, and a default that differed by build would leave the shape
   * that ships the one never exercised.
   *
   * **A call refused before the handler never reaches the application at all**, so a value-carrying
   * event for one hands over data the application would otherwise never have seen — and an argument
   * that failed validation is the likeliest of all to be malformed or secret.
   */
  readonly observability?: { readonly payloads: ObservedPayloads };
  /**
   * The document's tool registry changed (docs/observing-tool-calls.md#the-registry-change-event).
   *
   * Fires for a change made by ANY script on the page, not only this library's own — a widget or an
   * extension registering a tool reaches the same registry — and carries `agentVisibleMoved` so the
   * two cases are never confused. A foreign registration reports `false` and sends the agent nothing,
   * which is the case that is otherwise invisible: an operator's first sign would be a call refused as
   * `foreign`, after the fact and on a different channel.
   */
  readonly onRegistryChange?: (event: McpRegistryChangeEvent) => void;
  /**
   * A declaration this library refused before it ever became a tool.
   *
   * There is no call to attach this to and never will be: the refusal happens at DECLARATION, because
   * by the time a call arrives the name is already held in a registry shared with every script on the
   * page and there is nothing left to refuse. Without this an author sees a tool silently missing from
   * `tools/list` with nothing anywhere to explain why.
   *
   * **Every cause arrives here**, and `code` says which: a missing validator, a duplicate name, a
   * foreign name, a reserved prefix. A refused declaration never unmounts the application — see
   * `onUnexpectedState` for what changed and why.
   */
  readonly onRegistration?: (event: McpRegistrationEvent) => void;
  /**
   * Installs the development-only inspection channel at `window.__AGENT_MCP__`
   * (docs/observing-tool-calls.md#the-inspector).
   *
   * **Both conditions, never either.** The channel exists only when this is `true` AND the build is a
   * development build. "Explicitly enabled in development" is a conjunction, and a global that
   * appeared because one of the two held would be a debug surface shipped to production by an
   * application that never asked for one.
   *
   * What it installs is a CHANNEL, not the inspector: a frozen object with a subscription and a
   * snapshot reader and nothing callable. The inspector itself lives behind `agent-mcp-react/devtools`
   * and reads this — which is what keeps a panel out of the bundle of an application that never
   * imports one, and what keeps this module from importing a development affordance.
   *
   * **It is metadata-only in every configuration**, including when `observability` asked the hooks for
   * values. Any script on the page can read a global; an application callback is a far narrower
   * boundary than that.
   */
  readonly devtools?: { readonly enabled: boolean };
  /**
   * How declared schemas are enforced.
   *
   * **Optional to pass, not optional in effect.** A tool that declares an `inputSchema` or an
   * `outputSchema` and finds no validator here **is not registered** — it does not enter the document's
   * registry and it does not appear in `tools/list`. Advertising a contract nothing checks would make
   * a schema documentation again, which is the condition this exists to end.
   *
   * An application whose tools declare no schemas needs nothing here and carries none of the cost: the
   * validator lives in a subpath precisely so it is absent from a bundle that does not use it.
   *
   * ```ts
   * import { createAjvValidator } from 'agent-mcp-react/validation';
   * const validator = createAjvValidator();
   * <AgentMcpProvider validation={{ validator }} ... />
   * ```
   *
   * A value rather than a module imported for its side effects: a validator that arrives because
   * somebody imported something is one whose presence cannot be reasoned about from the code that
   * depends on it.
   */
  readonly validation?: { readonly validator: SchemaValidator };
  /**
   * What the agent reaching this page may do — **required, with no default profile**.
   *
   * Authority only narrows: absent is denied, never defaulted. An omitted member is `false` and draws
   * no complaint; an **unknown** member is refused loudly, because an author who wrote one believes
   * they granted something. A set that cannot be understood starts nothing at all: no registry is
   * resolved, no document claim is taken, no tool is registered and no socket is opened.
   *
   * ```tsx
   * <AgentMcpProvider capabilities={{ application: true, dom: { inspect: false, interact: false }, evaluate: false }} ... />
   * ```
   *
   * **One capability confers no other.** `application` does not admit DOM tools, `dom.inspect` does not
   * admit `dom.interact`, and nothing short of `evaluate` reaches Level 3.
   *
   * **What this governs is THIS LIBRARY'S BRIDGE, and nothing else**
   * (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page). Setting
   * `application: false` refuses an agent's calls; it does not unregister anything. Every Level 1 tool
   * stays in the document's shared tool registry, where any script on the page — a widget, an
   * extension, the application's own code — can still invoke it with none of these gates in the path.
   * Moving a domain rule out of a handler and into a capability therefore stops enforcing it for every
   * caller that is not this agent.
   *
   * Read live: changing it applies to the next call, and tells a connected agent that what it may
   * reach has changed.
   */
  readonly capabilities: AgentCapabilities;
  /**
   * How a person is asked to approve a call, for tools that declare `confirmation: 'required'`.
   *
   * ```tsx
   * <AgentMcpProvider
   *   confirmation={{ resolver: (request) => askThePerson(request) }}
   *   …
   * />
   * ```
   *
   * The resolver is handed the tool's name and title, a **detached, deeply frozen** snapshot of the
   * already-validated arguments, and a signal that aborts if the call is cancelled — so a dialog left
   * open for a call nobody is waiting for can close itself. It returns `'approved'` or `'refused'`, or
   * a promise of one.
   *
   * **Anything else denies**: a throw, a rejection, a dismissed dialog that yields `undefined`, a `true`
   * from an author who assumed a boolean. There is no truthiness test here, deliberately — the last of
   * those would otherwise read as consent.
   *
   * **Its absence is not permission.** A tool requiring confirmation with no resolver is refused and
   * stays listed, because what is true is "it cannot be approved here", not "it does not exist".
   *
   * **Do not write one that approves everything.** It is the line an embedder copies, and copying it
   * converts every `confirmation: 'required'` in the application into unconditional consent — silently,
   * and in the one place an author went out of their way to ask for a person.
   *
   * A confirmation is human-scale: nothing here times out, because a timeout would be this library
   * choosing on an operator's behalf. The call still always settles, because it is raced against its
   * own cancellation.
   */
  readonly confirmation?: { readonly resolver: ConfirmationResolver };
  readonly onConnectionChange?: (state: McpConnectionState) => void;
  readonly children: ReactNode;
}

/**
 * A layout effect where there is a document, and a passive one where there is not.
 *
 * `useLayoutEffect` runs synchronously after the commit, before the browser paints and before the task
 * yields — which is what the capability ref needs, and nothing else here does. React logs a warning
 * for it during server rendering, where it never runs at all, so the server gets the passive one.
 * There is no behavioural difference on the server: the provider registers nothing and connects
 * nothing there (docs/design.md#the-provider).
 */
const useCommitEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Distinguishes providers in a claim refusal, so the message names something a reader can find. */
let providerSequence = 0;

// **Serving one declaration made outside React**, and the two functions below are the whole of what a
// provider does for the imperative path (docs/tools-outside-react.md).
//
// What is NOT here is the point: no second gateway, no second ownership record, no runtime of its own.
// A shell-owned tool goes through exactly the registration this provider performs for a hook's tool,
// so every gate, refusal and lifetime rule reaches it without being restated.

/** Per-declaration registration state, keyed by the declaration rather than by name. */
interface ServedDeclaration {
  controller: AbortController;
  declaration: ToolDeclaration;
  /**
   * Read at CALL time by both routes, so a changed handler takes effect with no registry cycle.
   *
   * The same mechanism `useMcpTool` uses for a rerender, and for the same reason: the registry never
   * carried the handler, so replacing the registration to change it would be a `tools/list_changed`
   * storm produced by the field that changes most.
   */
  readonly current: { current: McpToolDefinition };
  readonly validators: { current: OwnershipEntry['validators'] };
  readonly lifetimeCell: { current: AbortController | undefined };
  /** Compared SEPARATELY from the descriptor: the registry cannot carry it, the listing can. */
  outputSchema: Record<string, unknown> | undefined;
  permissions: DeclaredPermissions | undefined;
}

const servedDeclarations = new WeakMap<PendingDeclaration, ServedDeclaration>();

/**
 * Registers, or re-registers, one declaration into this provider's gateway.
 *
 * **A repeat call with an UNCHANGED descriptor does nothing at all**
 * (docs/tools-outside-react.md#the-handle). The comparison is `sameDescriptor`'s, reached through
 * `replace`'s own path rather than re-derived here: an application calling `update()` inside a store
 * subscription would otherwise produce a `tools/list_changed` storm while the tool stayed correct
 * throughout, which is exactly how the equivalent defect went unnoticed for a rerender — the
 * registration count stayed right while the registry churned.
 */
function registerDeclared(
  entry: PendingDeclaration,
  gateway: ReturnType<typeof createRegistrationGateway>,
  binding: AgentMcpBinding,
): void {
  const definition = entry.definition;
  const served = servedDeclarations.get(entry);

  if (served !== undefined) {
    // **The handler first, and unconditionally.** It is read live through this cell by both routes, so
    // a changed handler is in effect from here with no registry work at all. Comparing it would be
    // wrong in both directions: a new function identity is the normal case, and a genuinely new
    // handler must not wait for a cycle that a descriptor comparison would decide not to perform.
    served.current.current = definition;

    const outputChanged = !sameValue(served.outputSchema, definition.outputSchema);
    const descriptorChanged = !sameDescriptor(
      served.declaration,
      declarationFor(definition, served, binding),
    );

    if (!descriptorChanged && !outputChanged) {
      // **Nothing the registry carries changed.** Availability may still have, and it has its own
      // write path precisely so a value that tracks application state costs no cycle — the same
      // reasoning `refresh()` was built for.
      if (!sameValue(served.permissions, definition.permissions)) {
        served.permissions = definition.permissions;
        void gateway
          .refresh({
            name: served.declaration.name,
            controller: served.controller,
            // Passed even when undefined: `RefreshRequest` requires the field, because clearing
            // permissions is a real change and an omitted key could not express it.
            permissions: definition.permissions,
          })
          .catch((cause: unknown) => reportDeclarationFailure(binding, cause));
      }
      return;
    }

    // A genuine change to something the agent's listing shows: exactly one withdraw-and-register.
    const declaration = declarationFor(definition, served, binding);
    const controller = new AbortController();
    const previous = served.declaration;
    const previousController = served.controller;
    served.controller = controller;
    served.declaration = declaration;
    served.outputSchema = definition.outputSchema;
    served.permissions = definition.permissions;
    void gateway
      .replace({
        previous,
        previousController,
        declaration,
        handler: (input, context) => served.current.current.handler(input, context),
        controller,
        lifetime: entry.lifetime.signal,
        ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
        ...(definition.permissions === undefined ? {} : { permissions: definition.permissions }),
        onCompiled: (compiled) => {
          served.validators.current = compiled;
        },
      })
      .then(() => {
        entry.registered = true;
      })
      .catch((cause: unknown) => {
        reportDeclarationFailure(binding, cause);
      });
    return;
  }

  const fresh: ServedDeclaration = {
    controller: new AbortController(),
    // Filled immediately below; the declaration needs the cells, and the cells belong to this record.
    declaration: undefined as unknown as ToolDeclaration,
    current: { current: definition },
    validators: { current: undefined },
    // The DECLARATION's lifetime, not this registration's. A call already running must survive a
    // descriptor change, and for a shell-owned tool it must survive the provider too — which is why
    // the queue owns this controller and only `remove()` aborts it.
    lifetimeCell: { current: entry.lifetime },
    outputSchema: definition.outputSchema,
    permissions: definition.permissions,
  };
  fresh.declaration = declarationFor(definition, fresh, binding);
  servedDeclarations.set(entry, fresh);
  void gateway
    .enqueue({
      declaration: fresh.declaration,
      handler: (input, context) => fresh.current.current.handler(input, context),
      controller: fresh.controller,
      lifetime: entry.lifetime.signal,
      ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
      ...(definition.permissions === undefined ? {} : { permissions: definition.permissions }),
      onCompiled: (compiled) => {
        fresh.validators.current = compiled;
      },
    })
    .then(() => {
      entry.registered = true;
    })
    .catch((cause: unknown) => {
      reportDeclarationFailure(binding, cause);
    });
}

/** Builds the registry descriptor over a served declaration's live cells. One implementation. */
function declarationFor(
  definition: McpToolDefinition,
  served: Pick<ServedDeclaration, 'current' | 'validators' | 'lifetimeCell'>,
  binding: AgentMcpBinding,
): ToolDeclaration {
  return declarationOf(definition, served.current, served.validators, served.lifetimeCell, binding);
}

/** `remove()` reached the queue: abort the registration this provider made for it. */
function withdrawDeclared(entry: PendingDeclaration): void {
  const served = servedDeclarations.get(entry);
  if (served === undefined) return;
  servedDeclarations.delete(entry);
  served.controller.abort();
  entry.registered = false;
}

/**
 * Where a refused imperative registration goes.
 *
 * The operator's destination, in both builds. A module-scope declaration has no author standing at a
 * component to be thrown at — there is no render to fail and no error boundary above it — so throwing
 * would reach an unhandled rejection and nothing else. Reported rather than swallowed, because an
 * unexpected state must fail loud.
 */
function reportDeclarationFailure(binding: AgentMcpBinding, cause: unknown): void {
  binding.reportOperational(cause);
}

export function AgentMcpProvider(props: AgentMcpProviderProps): ReactNode {
  const {
    connection,
    server,
    validation,
    capabilities,
    confirmation,
    onUnexpectedState,
    onConnectionChange,
    onToolCall,
    onToolResult,
    onToolError,
    observability,
    onRegistryChange,
    onRegistration,
    builtInTools,
    devtools,
    children,
  } = props;

  // **Checked during render, before any effect runs** — which is what makes "before anything is
  // exposed" a mechanism rather than an ordering an edit could undo. Every exposure this library
  // performs (resolving the registry, claiming the document, opening the gateway, dialing) happens in
  // the mount effect below, and an effect never runs before the render that scheduled it.
  //
  // Pure, so calling it on every render costs a walk of four keys and nothing else. It has to be every
  // render: an author may change the prop, and a set checked once at mount is a set that stops being
  // checked exactly when it starts being wrong.
  const normalization = normalizeCapabilities(capabilities);

  // What this render would grant, if it commits.
  //
  // An unusable set denies everything. That is not a fallback profile standing in for a decision — the
  // provider refuses to start at all in that state — it is what a gate must see if anything ever
  // manages to consult it in that window. An unknown state is refused, never quietly defaulted.
  const granted = normalization.ok ? normalization.capabilities : DENIES_EVERYTHING;

  // **The live set every gate reads, and it is written at COMMIT, never during a render.**
  //
  // "Live" means the set the application currently grants, not the set some render once proposed. A
  // render is a proposal: React may discard one — an interrupted concurrent render, a transition that
  // is superseded, a tree that throws below this point — and a ref written during a render that never
  // committed leaves the gate reading authority nobody ever granted. The dangerous direction is the
  // widening one: a discarded render carrying `evaluate: true` would admit Level 3 calls against a
  // page whose committed tree says otherwise, and nothing on screen would show it.
  //
  // So the rule is: **a capability is in force when the render that granted it commits.** The effect
  // below is that rule. It is declared before the mount effect, so at mount the set is in place before
  // the runtime that reads it is built.
  const capabilitiesRef = useRef<AgentCapabilities>(DENIES_EVERYTHING);

  // A primitive that changes exactly when the GRANTED SET does, so the effect that tells the agent
  // fires on a real change and not on `capabilities={{ ... }}` being a new object every render.
  const signature = capabilitySignature(granted);

  // Primitives, so the mount effect below depends on the FACT of a usable set and on the text of what
  // was wrong — never on the identity of a normalization object, which is new on every render and would
  // tear down and rebuild the connection each time.
  const normalizationOk = normalization.ok;
  const problemsText = normalization.ok ? '' : describeProblems(normalization.problems);

  // What `useMcpCapabilities` reads, held stable across renders that did not change the granted set.
  //
  // Keyed on the SIGNATURE rather than published directly, for the same reason the effect below
  // depends on it: `normalizeCapabilities` builds a new object every render, so handing it straight to
  // the context would rerender every consumer on every provider render — including every render caused
  // by the connection state moving, which has nothing to do with capabilities. Keyed this way, a
  // consumer rerenders when the granted set's VALUE changes and at no other time.
  //
  // Deliberately published even when the set is unusable: `granted` is `DENIES_EVERYTHING` there, and
  // that is what the gate is enforcing, so it is also the honest reading. A hook that returned the
  // author's rejected set would describe authority the runtime is refusing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature IS the value of `granted`; depending on the object would defeat the memo, which is the whole point.
  const publishedCapabilities = useMemo(() => granted, [signature]);

  // Read through a ref so the effect does not re-run when an inline callback changes identity. The
  // effect tears down a connection and a claim, so re-running it on a rerender would cost a
  // disconnect and a registry churn for nothing.
  const reportFailureRef = useRef<(failure: unknown) => void>(() => undefined);
  const reportChurnRef = useRef<(name: string, cycles: number) => void>(() => undefined);
  const reportOperationalRef = useRef<(failure: unknown) => void>(() => undefined);
  const afterRenderRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Allocated once, during a render that may never commit — which is safe because neither call
  // touches the registry, the network or the document.
  /**
   * The observation bus, reached through a ref because the binding is built before it exists.
   *
   * The same indirection the failure destinations above use, and for the same reason: `binding` is
   * allocated once by `useState` and must never be replaced — a new binding identity would re-run
   * every declaration effect beneath it — so anything created later reaches it through a ref rather
   * than by rebuilding it.
   */
  const observationRef = useRef<ObservationBus | undefined>(undefined);

  /** The agent-visible tool names at the last reconciliation, for the development channel alone. */
  const bridgedRef = useRef<readonly string[]>([]);

  /** Tells the development channel's subscribers that the snapshot moved. Absent when not installed. */
  const snapshotNotifyRef = useRef<(() => void) | undefined>(undefined);

  const [binding] = useState<AgentMcpBinding>(() => ({
    gateway: createRegistrationGateway((name, cycles) => {
      // A registration that has cycled implausibly often. Reported to the operator's destination, once
      // — the application asked for every one of those cycles, so this is information rather than a
      // refusal, and nothing is suppressed because of it.
      reportChurnRef.current(name, cycles);
    }),
    reportFailure: (failure) => {
      reportFailureRef.current(failure);
    },
    reportOperational: (failure) => {
      reportOperationalRef.current(failure);
    },
    afterRender: () => afterRenderRef.current(),
    reportRegistrationEvent: (event) => {
      try {
        propsRef.current.onRegistration?.(event);
      } catch (cause) {
        reportObserverFailure(cause);
      }
    },
    observeRegistryCall: ({ name, arguments: args }) =>
      observationRef.current?.beginIfObserved(() => ({
        name,
        route: CALL_ROUTE.registry,
        startedAt: Date.now(),
        arguments: args,
      })),
  }));
  /**
   * The ownership record, for this provider's whole life rather than for one connection.
   *
   * **Allocated here and not inside the runtime, because a registration is not per-connection.** A tool
   * belongs to the mounted application; a network event is not a reason to withdraw one. That rule is
   * already stated below, where the gateway is opened BEFORE the socket is dialled — this allocation is
   * the same rule applied to the record's lifetime.
   *
   * What it prevents is a defect the effect below already documents as having happened once: a runtime
   * that brought its own record left every already-mounted tool foreign to it — absent from the agent's
   * listing, refused at the bridge, unrecoverable without a remount, because the declaration hooks
   * depend on the stable `binding` and do not re-run. A reconnection builds a new runtime, so without
   * this it would reproduce that defect on every recovery.
   *
   * `useState` rather than `useRef` for the same reason `binding` uses it: allocated once, during a
   * render that may never commit, and safe there because creating a record touches nothing.
   */
  /**
   * The last state published to the application, for the machine to be consulted against.
   *
   * A ref because it must outlive the connection effect, which is rebuilt when the server metadata
   * changes without the application being told `disconnected` in between.
   */
  const publishedRef = useRef<ConnectionStatus>(CONNECTION_STATUS.disconnected);
  const [ownership] = useState(() => createOwnershipRecord());
  const [holderId] = useState(() => `${server.name}@${server.version} #${++providerSequence}`);

  // **The render barrier** (docs/explanation-commit-and-registration.md). A counter plus a set of
  // resolvers, and a passive effect that drains them.
  //
  // What makes the promise true: React renders a root with every update pending on it, so a bump
  // scheduled after a handler's own dispatch is committed in a render that also carries the dispatch.
  // The passive effect keyed on the counter then runs after that commit. Which is exactly the
  // condition `ToolCallContext.afterRender` documents — a commit including everything scheduled
  // before the call, and that commit's effects — and nothing more.
  //
  // Deliberately NOT `requestAnimationFrame`, tempting as it is: a barrier must never claim that
  // effects completed because a frame elapsed. A frame is a wall-clock event with no relationship to
  // a commit, and on a busy page it can elapse before one or long after the effects.
  const [renderTick, setRenderTick] = useState(0);
  const issuedTickRef = useRef(0);
  /** Set once the provider has torn down. After that there are no more commits to wait for. */
  const tornRef = useRef(false);
  const pendingRendersRef = useRef<{ waitingFor: number; resolve: () => void }[]>([]);

  useEffect(() => {
    // **Only the waiters this commit is actually for.**
    //
    // Child effects run BEFORE a parent's, so a child effect can start a tool call — and register a
    // waiter — during the very commit this drain is running for. Draining everything would resolve
    // that waiter against a commit that predates the update it is waiting on, which is the barrier
    // silently promising less than it says. Each waiter carries the tick its own bump produced, and
    // only ticks this commit has reached are settled.
    //
    // Strict mode double-invokes this effect: the settled waiters are removed before anything is
    // resolved, so the second pass finds nothing rather than resolving twice or iterating a list that
    // moved under it.
    const pending = pendingRendersRef.current;
    const ready = pending.filter((waiter) => waiter.waitingFor <= renderTick);
    if (ready.length === 0) return;
    pendingRendersRef.current = pending.filter((waiter) => waiter.waitingFor > renderTick);
    for (const waiter of ready) waiter.resolve();
  }, [renderTick]);

  useEffect(() => {
    // **Reset on every setup, because a cleanup is not proof of an unmount.** StrictMode runs mount
    // effects setup → cleanup → setup, so this cleanup fires once during a perfectly normal mount. A
    // flag latched there and never cleared makes the barrier resolve instantly for the life of the
    // page — every handler reports success before anything has rendered, which is the exact defect
    // the barrier exists to prevent, arriving through the guard that was supposed to prevent a hang.
    //
    // Found by a live run against a StrictMode page. Every test passed: the flat-tree StrictMode case
    // asserted the change eventually landed rather than that the barrier waited for it.
    tornRef.current = false;

    // The provider is going away, and with it every commit anyone was waiting for. Settled rather than
    // left pending: a handler awaiting a render from a torn-down tree would wait for a commit that can
    // never come, and its call would never settle for the agent either.
    //
    // Its dependency list is empty on purpose — a keyed effect's cleanup runs on every dependency
    // change, not only on unmount, and this must run only when the provider actually goes.
    return () => {
      // Latched BEFORE the drain, so a waiter that arrives afterwards resolves immediately instead of
      // joining a list nothing will ever drain again. That is reachable: the descriptor this library
      // leaves in the shared registry outlives the React tree by however long the registry takes to
      // withdraw it, and a page script calling through it can reach `afterRender()` in that window.
      tornRef.current = true;
      const waiting = pendingRendersRef.current;
      pendingRendersRef.current = [];
      for (const waiter of waiting) waiter.resolve();
    };
  }, []);

  // The live runtime, so the capability-change effect can reach the one the mount effect built. It is
  // never handed to a component: the runtime carries the ownership record every gate is built on, and
  // a value a component can reach is a value an application can reach around the gates with.
  const runtimeRef = useRef<McpRuntime | undefined>(undefined);
  /** The signature last announced to the agent. `undefined` while nothing is connected. */
  const announcedSignatureRef = useRef<string | undefined>(undefined);
  /** Read by the mount effect, which must not depend on the signature and re-dial when it changes. */
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  /**
   * Whether a usable capability set has ever committed on this provider.
   *
   * **Monotonic.** It answers "may the library start?", which is a question about the FIRST usable set
   * and never about the current one. What the current set decides is what a gate admits, and that is
   * read live from the ref above.
   */
  const [hasStarted, setHasStarted] = useState(false);

  const [state, setState] = useState<McpConnectionState>({
    status: CONNECTION_STATUS.disconnected,
  });
  const [mountFailure, setMountFailure] = useState<unknown>(undefined);

  // Re-thrown during a render because a throw inside the asynchronous mount below reaches no error
  // boundary — it becomes a rejected promise nobody is holding. This line is the loud channel; without
  // it "fails loudly" is satisfied on paper and by nothing in practice.
  if (mountFailure !== undefined) throw mountFailure;

  // **A capability set that cannot be understood: development throws, production reports.**
  //
  // Thrown from the render rather than from the effect, because a throw here reaches an error boundary
  // and an author sees it at the line they wrote. Production does not throw — a typo in a capability
  // must not white-screen a working page — and it does not proceed either: the mount effect below
  // refuses to start, so the page registers nothing and dials nothing. Refusing in only one of the two
  // builds would be a gate that exists in development and not in production, which is the shape of
  // every capability defect this feature exists to prevent.
  //
  // Placed after every hook so the hook order is identical on the render that throws and the render
  // that follows a fix.
  if (!normalization.ok && IS_DEVELOPMENT) {
    throw new RuntimeError(
      RUNTIME_FAILURE.capabilitiesUnusable,
      `the capabilities given to AgentMcpProvider cannot be used, so nothing an agent asks for is admitted: ${problemsText}`,
    );
  }

  reportFailureRef.current = setMountFailure;
  reportOperationalRef.current = (failure) => {
    // Reaches the operator's destination rather than the error boundary. Anything arriving here is
    // shaped like the reports that destination already carries — it has a `code` from a closed set, so
    // a receiver branches on the code it already had to handle.
    if (failure instanceof WebMcpBoundaryError) {
      propsRef.current.onUnexpectedState(failure);
      return;
    }
    // Anything else is not something this channel can describe, and swallowing it would leave a hidden
    // unknown where a loud failure belongs. It goes to the loud channel instead.
    reportFailureRef.current(failure);
  };

  afterRenderRef.current = () => {
    // No tree, so no commit — resolving is the true answer rather than a convenience. Scheduling an
    // update on an unmounted provider would do nothing and the caller would wait forever.
    if (tornRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // The tick is allocated here rather than read from the updater, so this waiter knows which
      // commit is its own. Concurrent calls get distinct ticks; React batching may still satisfy
      // several with one commit, which is correct — that commit carries all their updates.
      issuedTickRef.current += 1;
      const waitingFor = issuedTickRef.current;
      pendingRendersRef.current.push({ waitingFor, resolve });
      // Scheduled AFTER the waiter is registered, so the commit this bump causes is one the waiter is
      // already recorded for. The other order loses the wake-up when React processes the update
      // synchronously.
      setRenderTick(waitingFor);
    });
  };

  reportChurnRef.current = (name, cycles) => {
    propsRef.current.onUnexpectedState(
      new WebMcpBoundaryError(
        REGISTRATION_REFUSED.churning,
        `the tool "${name}" has been withdrawn and re-registered ${cycles} times without its component unmounting — its declared descriptor is changing on every render, which costs an agent a tool-list change every time`,
        { subject: name },
      ),
    );
  };

  const propsRef = useRef({
    getUrl: connection.getUrl,
    onUnexpectedState,
    onConnectionChange,
    onToolCall,
    onToolResult,
    onToolError,
    onRegistryChange,
    onRegistration,
    builtInTools,
    payloads: observability?.payloads ?? OBSERVED_PAYLOADS.metadata,
  });
  propsRef.current = {
    getUrl: connection.getUrl,
    onUnexpectedState,
    onConnectionChange,
    onToolCall,
    onToolResult,
    onToolError,
    onRegistryChange,
    onRegistration,
    builtInTools,
    payloads: observability?.payloads ?? OBSERVED_PAYLOADS.metadata,
  };

  // **One bus for this provider's whole life, created here rather than at module scope.**
  //
  // Module scope would share it across provider lifetimes and across two bundled copies of this
  // library, and all three consequences are invisible: a provider whose document claim was REFUSED
  // could still subscribe to the first provider's stream; an old call's terminal could reach a
  // remounted provider; and an inspector imported from one copy would silently see nothing from the
  // other. One bus per provider removes all three by construction.
  //
  // The payload mode is read through the ref rather than captured, so a provider whose prop changed
  // does not keep projecting under the mode it started with.
  /**
   * Reports an application's own observability callback throwing.
   *
   * One function rather than one per call site, because there are now three — the call stream, the
   * registry-change hook and the registration hook — and three spellings of "a consumer failed" is
   * three chances for one of them to reach the wrong destination. That already happened once: a
   * throwing `onRegistryChange` was reported as a failed tool-list notification, telling an operator
   * the agent could not be reached when it had been reached perfectly well.
   */
  const reportObserverFailure = useCallback((cause: unknown): void => {
    propsRef.current.onUnexpectedState(
      new AgentMcpReactError(
        REACT_REFUSED.observerFailed,
        'an observability callback supplied to AgentMcpProvider threw. The call itself was ' +
          'unaffected and the remaining events for it were still delivered; this is a defect in ' +
          "the application's own observer, not in this library.",
        { cause },
      ),
    );
    // Stable, and that is not cosmetic: it is read by the connection effect below, and a function
    // recreated each render would re-run that effect — tearing down and re-dialling the socket on
    // every render. It reads only `propsRef.current`, which is why an empty dependency list is the
    // true one rather than a suppression.
  }, []);

  const [observation] = useState<ObservationBus>(() =>
    createObservationBus({
      payloads: () => propsRef.current.payloads,
      onConsumerFailure: ({ cause }) => {
        // An application's own callback threw. It goes to the operator's destination — the same one a
        // broken invariant uses, because a provider that could be built without a destination is one
        // whose alarms default to silence — but it is LABELLED a consumer failure. The channel now
        // carries two kinds of wrong, and an operator sent to read this library's internals for a bug
        // in their own logging has been misled rather than informed.
        propsRef.current.onUnexpectedState(
          new AgentMcpReactError(
            REACT_REFUSED.observerFailed,
            'an observability callback supplied to AgentMcpProvider threw. The call itself was ' +
              'unaffected and the remaining events for it were still delivered; this is a defect in ' +
              "the application's own observer, not in this library.",
            { cause },
          ),
        );
      },
    }),
  );

  observationRef.current = observation;

  // **The development inspection channel** (docs/observing-tool-calls.md#the-inspector). Installed
  // only when the application asked AND the build is a development build — a conjunction, because a
  // global that appeared because either held would be a debug surface shipped to production by
  // somebody who never asked for one.
  //
  // `IS_DEVELOPMENT` is a constant a bundler folds, so in a production build this whole effect and the
  // branch inside it are removed rather than merely skipped.
  //
  // What is installed is DATA and a subscription. Nothing on it can invoke a tool, grant a capability
  // or register anything — no devtool may widen what the provider granted — and it holds no runtime,
  // no gateway, no ownership record and no registry — the same reason those are kept out of the
  // binding a component can reach.
  // **A LAYOUT effect, and the reason is an ordering defect a live run caught that no suite did.**
  //
  // React runs effects child-before-parent. An inspector mounted as a CHILD of this provider therefore
  // runs its own effect first, and a passive effect here would install the channel afterwards — so the
  // inspector reads `undefined`, renders "no inspection channel", and never looks again. The panel
  // said the channel was absent while the channel was demonstrably present.
  //
  // The suites missed it because they construct the inspector after mounting, which is not how an
  // application does it. The commit order that fixes it is layout(child) → layout(parent) →
  // passive(child): installing here means the channel exists before any child's passive effect looks.
  //
  // Cheap enough to belong in a layout effect: it assigns one frozen object and subscribes.
  useLayoutEffect(() => {
    if (!IS_DEVELOPMENT || devtools?.enabled !== true) return;
    const host = globalThis as unknown as Record<string, unknown>;

    const sinks = new Set<(event: McpObservedCall) => void>();
    const snapshotSinks = new Set<() => void>();
    snapshotNotifyRef.current = () => {
      for (const sink of snapshotSinks) {
        try {
          sink();
        } catch {
          // A panel that threw must not stop the others, and must not reach the application's alarm
          // channel: this is a development surface an operator did not wire.
        }
      }
    };
    const stop = observation.subscribe((event) => {
      // **An ALLOWLIST, not a rest-spread that drops two names.** The hooks may have been opted into
      // `values`; this channel never is. Any script on the page can read a global, which is a far
      // wider boundary than an application callback — and a call refused before the handler ran never
      // reached the application at all, so its arguments would be a first disclosure, not an echo.
      //
      // A denylist was the first shape and a review found what it costs: it copies every field it does
      // not know about, so any future field carries values here by default, and it copied whatever a
      // previous subscriber had written into a field it WAS allowed to see. Naming what may pass
      // means a new field is absent until somebody adds it deliberately.
      const frozen = Object.freeze({
        phase: event.phase,
        callId: event.callId,
        name: event.name,
        route: event.route,
        startedAt: event.startedAt,
        ...(event.settledAt === undefined ? {} : { settledAt: event.settledAt }),
        gates: event.gates,
        ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
        ...(event.failure === undefined ? {} : { failure: event.failure }),
      }) as McpObservedCall;
      for (const sink of sinks) {
        try {
          sink(frozen);
        } catch {
          // A panel that threw must not stop the others, and must not reach the application's alarm
          // channel: this is a development surface an operator did not wire.
        }
      }
    });

    // **Claimed, not assigned.** A second provider mounting into a document that already has one gets
    // its claim REFUSED later, in the asynchronous startup below — but its layout effect runs first
    // and would otherwise overwrite the live provider's channel, then delete it on cleanup, leaving
    // the working provider connected with no channel and no way to reinstall one.
    //
    // So: install only into an empty slot, and remove only what we installed. A refused second
    // provider then touches nothing.
    if (host.__AGENT_MCP__ !== undefined) {
      stop();
      // **Reported, not silently skipped.** A review pointed out that returning quietly leaves an
      // application that asked for the channel with none, and no way to find out why — including when
      // the occupant is a stale or malformed value the inspector itself would reject. An operator
      // reading "the inspector says no channel" would have nothing to go on.
      //
      // Reported rather than overwritten, for the same reason the document claim refuses rather than
      // taking: whatever is there is not ours, and a second provider destroying the first one's
      // surface is the defect this guard was added to fix.
      propsRef.current.onUnexpectedState(
        new AgentMcpReactError(
          REACT_REFUSED.observerFailed,
          'the development inspection channel could not be installed: something already occupies ' +
            'window.__AGENT_MCP__. Another provider on this page owns it, or a stale value was left ' +
            'behind. The inspector will report that no channel is available.',
        ),
      );
      return;
    }

    const installed = Object.freeze({
      version: 1,
      subscribe(sink: (event: McpObservedCall) => void): () => void {
        sinks.add(sink);
        return () => {
          sinks.delete(sink);
        };
      },
      /**
       * Notifies when the SNAPSHOT changes — the connection state, or the bridged tool set.
       *
       * Separate from the call stream because neither of those produces a call, and a panel that
       * redrew only on calls would show "disconnected" on a healthy page until an agent happened to
       * invoke something. That is a surface reporting its own staleness as fact.
       */
      subscribeSnapshot(sink: () => void): () => void {
        snapshotSinks.add(sink);
        return () => {
          snapshotSinks.delete(sink);
        };
      },
      snapshot(): unknown {
        // The tool list comes from the last RECONCILIATION, not from the ownership record. That record
        // deliberately answers no aggregate question — "which tools exist" is exactly what its type
        // refuses — and a devtools surface is not a reason to breach the one rule it holds. The
        // reconciliation already carries the agent-visible names, decided by their single owner.
        return Object.freeze({
          connection: Object.freeze({ status: publishedRef.current }),
          tools: Object.freeze([...bridgedRef.current]),
        });
      },
    });

    host.__AGENT_MCP__ = installed;

    return () => {
      stop();
      sinks.clear();
      snapshotSinks.clear();
      snapshotNotifyRef.current = undefined;
      // Only ours. If something else replaced it meanwhile, deleting would destroy a surface we do
      // not own — the same reasoning the document claim uses when it releases.
      if (host.__AGENT_MCP__ === installed) delete host.__AGENT_MCP__;
    };
  }, [devtools?.enabled, observation]);

  /** Whether any of the three call callbacks is supplied. Read below; see why it gates the subscription. */
  const observesCalls =
    onToolCall !== undefined || onToolResult !== undefined || onToolError !== undefined;

  // Delivery is per-phase, so an application wires only what it wants. Subscribed for the provider's
  // whole life rather than per connection: a tool call arriving over the page's own registry route
  // does not need a socket, and an observability surface that went quiet whenever the agent
  // disconnected would be reporting the connection rather than the calls.
  //
  // **Subscribed only when something is actually listening, and that is a correctness fix rather than
  // a micro-optimisation.** The bus builds no record when it has no subscribers — which is the whole
  // mechanism behind "an application that supplies no callbacks pays nothing". Subscribing
  // unconditionally to route events to possibly-absent props defeated it: the bus always had a
  // subscriber, so it always built a record, and the documented zero-cost path was false for every
  // application that never asked for observability. A review caught it; nothing else could, because
  // the surface behaves identically either way.
  useEffect(
    () =>
      observesCalls
        ? observation.subscribe((event) => {
            const observed = event as McpObservedCall;
            if (observed.phase === CALL_PHASE.start) {
              propsRef.current.onToolCall?.(observed as McpToolCallEvent);
              return;
            }
            if (observed.phase === CALL_PHASE.result) {
              propsRef.current.onToolResult?.(observed as McpToolResultEvent);
              return;
            }
            propsRef.current.onToolError?.(observed as McpToolErrorEvent);
          })
        : undefined,
    [observation, observesCalls],
  );

  // Read through a ref for the same reason as the callbacks above: an inline `validation={{ validator }}`
  // is a new object every render, and depending on it would tear down the connection on every one.
  const validationRef = useRef(validation);
  validationRef.current = validation;

  // The same, for the confirmation surface — and here the live read matters rather than merely being
  // tidy: an application that swaps its dialog implementation must not still be asked through the old
  // one, and a confirmation can be open long enough for that to happen.
  const confirmationRef = useRef(confirmation);
  confirmationRef.current = confirmation;

  useCommitEffect(() => {
    capabilitiesRef.current = granted;
    // **Monotonic, and deliberately never cleared.** It is what stops a capability set that becomes
    // unreadable AFTER the library started from tearing the bridge down — see the mount effect below.
    if (normalizationOk) setHasStarted(true);
    // **A LAYOUT effect, and the choice is about a window rather than about style.** A passive effect
    // is scheduled, so between the commit and the flush there is a real interval in which a socket
    // message can be delivered — and a call arriving there would be gated by the previous set. That is
    // the safe direction for a grant and the wrong one for a WITHDRAWAL: an operator revoking a
    // capability would have it still in force for a call that arrived after the page had already
    // rendered the revocation. A layout effect runs synchronously after the commit, before the task
    // yields, so there is no such interval.
    //
    // `granted` is a new object on every render, so this runs after every commit and writes the same
    // value most times. That is the cost, and it is one assignment: the alternative — keying on the
    // signature so it runs only on a real change — is the same thing with a comparison in front of it,
    // and it would hide the rule this effect exists to state.
  }, [granted, normalizationOk]);

  useEffect(() => {
    let torn = false;
    const { gateway } = binding;

    // **Nothing is exposed under a capability set nobody could read**. Before the registry is
    // resolved, before the document claim, before the gateway opens and before the socket — because a
    // page that had already registered its tools and dialed out by the time anyone objected would be
    // exposed under capabilities nobody wrote.
    //
    // The report is not here. It belongs to its own effect below, because it must also fire for a set
    // that becomes unreadable long after this one ran.
    if (!hasStarted) return;

    /**
     * The state this provider has published, so the machine can be consulted before the next one.
     *
     * Tracked here rather than read back from React state, because a report may follow another within
     * one turn — a drop and its first recovery do — and reading state would compare against a value
     * React has not committed yet.
     */
    // Held in a ref rather than here, so it survives this effect being rebuilt — which happens when the
    // server metadata changes, with no `disconnected` published in between. A value reset here would
    // make the next `connecting` look like it came from `disconnected` when the application last saw
    // `connected`, and the machine would wave through an edge it does not declare.

    /**
     * Publishes a state, unless teardown already happened — a late report would resurrect a corpse.
     *
     * **Consults the machine, which is what makes the transition table a machine rather than a
     * comment.** A transition it does not declare is this library asking for something its own table
     * forbids: no application can cause it, publishing it would put a state on screen the machine says
     * cannot happen, and swallowing it would leave a hidden unknown where a loud failure belongs. So
     * it is reported to the operator's destination and nothing is published.
     */
    const report = (next: McpConnectionState): void => {
      if (torn) return;
      const published = publishedRef.current;
      if (!permitsTransition(published, next.status)) {
        propsRef.current.onUnexpectedState(
          new AgentMcpReactError(
            REACT_REFUSED.transitionForbidden,
            `the connection state machine does not declare a transition from "${published}" to "${next.status}", so nothing was published`,
          ),
        );
        return;
      }
      publishedRef.current = next.status;
      // The development channel's snapshot moved. Nothing else reads this; a panel that redrew only
      // on calls would report a healthy page as disconnected until an agent happened to invoke one.
      snapshotNotifyRef.current?.();
      setState(next);
      propsRef.current.onConnectionChange?.(next);
    };

    /**
     * The schedule for recovering a channel that dropped. One per mount, reset on every SUCCESSFUL
     * connection and on nothing else — resetting per attempt would leave it at its first interval
     * forever, which is a retry storm wearing a backoff's clothing.
     */
    const schedule = createReconnectSchedule();

    /** The timer for the next recovery attempt, so teardown can cancel it. */
    let pending: ReturnType<typeof setTimeout> | undefined;

    /**
     * Builds a runtime for ONE connection.
     *
     * Per connection because one runtime measurably cannot serve two: a second `connect()` resolves —
     * the protocol layer reassigns its transport with no guard — and the next `initialize` then fails.
     * Reusing it would produce a recovery that reports itself established and is not.
     *
     * The ownership record is the provider's and is NOT rebuilt here, which is what lets a recovered
     * connection still reach the tools this application had mounted all along.
     */
    const buildRuntime = (onChannelEnded: () => void): McpRuntime =>
      createMcpRuntime({
        onChannelEnded,
        observation,
        // A consumer's throw from `onRegistryChange`, reported as a CONSUMER failure like every other
        // observer's. Without this it reached the send-failure destination and an operator was told
        // the agent could not be reached, which was false.
        onRegistryChangeFailed: (cause) => reportObserverFailure(cause),
        onRegistryChange: (outcome) => {
          // Kept for the development channel's snapshot, which has no other honest source: the
          // ownership record answers no aggregate question by design.
          bridgedRef.current = outcome.tools;
          snapshotNotifyRef.current?.();
          propsRef.current.onRegistryChange?.(outcome);
        },
        serverInfo: { name: server.name, version: server.version },
        onUnexpectedState: (failure) => propsRef.current.onUnexpectedState(failure),
        // **Read through the ref, so every gate sees the set as it is now.** Handing over
        // `normalization.capabilities` would freeze this connection at the render that started it, and
        // a capability withdrawn afterwards would go on admitting calls for the life of the page.
        capabilities: () => capabilitiesRef.current,
        confirmationResolver: () => confirmationRef.current?.resolver,
        // The same barrier the in-page route gets, from the one owner of it — one owner per truth. A
        // second implementation for the bridged path could wait for something different, and the two
        // would disagree about what a tool's success means depending on who called it.
        renderBarrier: () => binding.afterRender(),
        // The provider's record, not one of the runtime's own. A runtime is per-connection; these
        // registrations are not.
        ownership,
        // **Read through the ref for the same reason the capabilities are**: a reconnection builds a
        // new runtime, and a set captured at the render that started the first connection would be the
        // set every later attempt served.
        //
        // Conditional spread rather than an unconditional key: `exactOptionalPropertyTypes` makes
        // `builtIns: undefined` a different thing from an absent `builtIns`, and the runtime's option
        // is optional because a build with no built-ins is the ordinary case.
        ...(propsRef.current.builtInTools === undefined
          ? {}
          : { builtIns: propsRef.current.builtInTools }),
      });

    let claimed = false;

    let declarationAdopter: Adopter | undefined;

    /**
     * One connection attempt: a new runtime, a new transport, a new credential.
     *
     * A new transport because a transport is single-use by construction, and that is what makes "a
     * fresh credential per attempt" structural — the supplier is invoked inside `start()`, so a new
     * transport necessarily runs it again. Nothing here holds a URL between attempts.
     */
    const attempt = async (): Promise<void> => {
      /**
       * What this attempt has managed so far.
       *
       * `ended` can be set before `connect()` resolves: the runtime's connect does real work after the
       * channel is live, and a peer closing inside that window ends the channel while this function is
       * still awaiting. Reporting `connected` afterwards would leave the page believing in a
       * connection that is already gone, waiting forever for an event that has been and passed.
       */
      const progress = {
        ended: false,
        connected: false,
        runtime: undefined as McpRuntime | undefined,
      };

      const runtime = buildRuntime(() => {
        progress.ended = true;
        // Only once this attempt has reported success does an ending mean "recover". Before that, the
        // await below picks it up — starting a recovery from here would race the attempt still running.
        if (progress.connected && progress.runtime !== undefined) channelEnded(progress.runtime);
      });
      progress.runtime = runtime;
      runtimeRef.current = runtime;
      // The baseline for this connection. What the agent sees on its first listing is what this
      // provider now believes it has been told, so the change effect announces a CHANGE rather than
      // announcing an initial state to a client that has not listed yet.
      announcedSignatureRef.current = signatureRef.current;

      const transport = createBrowserWebSocketTransport({ getUrl: propsRef.current.getUrl });

      try {
        await runtime.connect(transport);
      } catch (cause) {
        // The socket may be open and subscriptions installed by the time this rejects. Left attached,
        // a failed attempt keeps a runtime and a socket alive for every retry — so it is ended here
        // rather than left for a cleanup that only runs at teardown.
        void runtime.shutdown();
        if (runtimeRef.current === runtime) runtimeRef.current = undefined;
        throw cause;
      }

      if (torn) {
        void runtime.shutdown();
        return;
      }

      // **The channel ended while connect was still working.** Not a hypothetical: connect does real
      // work after the channel is live, and this is the window the runtime's own callback exists to
      // close. Reporting `connected` here would be reporting a connection that is already gone.
      if (progress.ended) {
        channelEnded(runtime);
        return;
      }

      // **Reset here and nowhere else.** This is the successful connection the schedule resets on; a
      // reset at the top of an attempt would make every interval the first one.
      progress.connected = true;
      schedule.reset();
      report({ status: CONNECTION_STATUS.connected, connectedAt: Date.now() });
    };

    /**
     * An ESTABLISHED channel ended.
     *
     * Its runtime is finished — terminal by its own contract — so it is shut down, which also withdraws
     * its subscriptions to the shared record. Leaving it attached would publish tool-list changes into
     * a socket that is gone, once per drop.
     */
    const channelEnded = (ended: McpRuntime): void => {
      if (torn) return;
      void ended.shutdown();
      if (runtimeRef.current === ended) runtimeRef.current = undefined;
      scheduleRecovery();
    };

    /**
     * Waits, then tries again — in that order, and the order is the requirement.
     *
     * The credential is obtained inside the attempt, AFTER this wait. Obtaining it first would make its
     * age at redemption equal the interval, which reaches the schedule's maximum of 30 s against a
     * recommended credential lifetime whose lower bound is also 30 s. It would fail at exactly the step
     * a real gateway restart drives you to, and invisibly — expired, spent and "the gateway is down"
     * are one cause to a page.
     */
    const scheduleRecovery = (): void => {
      if (torn) return;
      // Read before advancing, so the first recovery reports attempt 1.
      const attemptNumber = schedule.attempt();
      const delay = schedule.next();
      report({ status: CONNECTION_STATUS.reconnecting, attempt: attemptNumber });

      pending = setTimeout(() => {
        pending = undefined;
        if (torn) return;
        void attempt().catch((cause: unknown) => {
          // A recovery attempt that failed is not an error state: recovery is unbounded and does not
          // give up. The cause is deliberately not carried into the state — a recovery rendered as a
          // failure is the display this whole path exists to replace.
          //
          // **But it is not swallowed either.** A connection failure is the expected cause here and
          // says nothing new; anything else means the library broke while recovering, and a retry loop
          // that discarded those would hide a real defect behind an indefinite reconnect, and an
          // unexpected state must fail loud.
          if (!isConnectionFailure(cause)) reportOperationalRef.current(cause);
          scheduleRecovery();
        });
      }, delay);
    };

    const start = async (): Promise<void> => {
      // The registry first, and through `src/webmcp/` — the only module permitted to touch it, and the
      // one that performs the secure-context check nothing else does.
      try {
        await ensureRegistry();
      } catch (cause) {
        // No document is a normal render path, not a failure (docs/design.md#the-provider): children
        // render, nothing connects, nothing registers, nothing throws. Every other cause means a
        // browser that should have had a registry does not, and those are loud.
        if (isNoDocument(cause)) return;
        throw cause;
      }
      if (torn) return;

      claimDocument(holderId);
      claimed = true;
      if (torn) return;

      // Opened before the connection is attempted, on purpose. Registration and the connection are
      // independent: a tool belongs to the mounted application, not to the network. A page
      // whose agent is unreachable still registers its tools, and still exposes them to every script
      // in the document — which is what the tool-declaration documentation has to say out loud.
      gateway.open(ownership, validationRef.current?.validator);

      // **Tools declared outside React, adopted here** (docs/tools-outside-react.md). The module-scope
      // queue holds DECLARATIONS made by an application shell, a singleton service or a router —
      // possibly before this provider, or any provider, existed. Adopting registers each of them into
      // this gateway, and every future declaration too, for as long as this provider is the one
      // serving.
      //
      // After `gateway.open`, deliberately: a declaration adopted before the gateway was open would
      // sit waiting behind it and land in the same place a moment later, which is harmless but makes
      // the ordering here look optional when it is not — the ownership record has to exist first.
      // Held so the teardown can prove it is releasing ITS OWN adoption rather than a successor's.
      declarationAdopter = {
        register: (entry) => registerDeclared(entry, gateway, binding),
        withdraw: (entry) => withdrawDeclared(entry),
      };
      adoptDeclarations(declarationAdopter);

      report({ status: CONNECTION_STATUS.connecting });
      await attempt();
    };

    void start().catch((cause: unknown) => {
      if (torn) return;
      if (isConnectionFailure(cause)) {
        // **A FIRST attempt that failed, and it is terminal.** Only an established channel is
        // recovered: one that once opened proves the configuration works, while one that never did may
        // be pointing somewhere that will never answer — and retrying that forever would hide a
        // misconfiguration behind a spinner rather than reporting it.
        //
        // The page is still a working page; the agent is simply not reachable. A registry that could
        // not be resolved is the opposite — the library did not start — and falls through.
        report({ status: CONNECTION_STATUS.error, error: asError(cause) });
        return;
      }
      reportFailureRef.current(cause);
    });

    return () => {
      // **Announced before anything is torn down, and this is what keeps the machine honest.** The
      // effect is rebuilt when the server metadata changes, and without this the application would go
      // from `connected` straight to `connecting` — an edge the table does not declare, which the
      // enforcement would then report as a broken invariant on an ordinary prop change.
      //
      // Only when there is something to announce. A provider that never got past `disconnected` — one
      // whose registry could not be resolved, which is a normal path on a server — has not moved, and
      // reporting a transition from a state to itself would be the machine correctly refusing a no-op
      // and raising an alarm about it.
      // **Announced inside a guard, because it runs application code.** `report` calls the
      // application's `onConnectionChange`, and a throw from there would propagate out of this cleanup
      // before `torn` is set and before anything below runs — leaking the retry timer, the runtime and
      // its socket, the gateway and the document claim, on an ordinary unmount. Teardown cannot be
      // conditional on an application behaving.
      if (publishedRef.current !== CONNECTION_STATUS.disconnected) {
        try {
          report({ status: CONNECTION_STATUS.disconnected });
        } catch (cause) {
          reportOperationalRef.current(cause);
        }
      }
      torn = true;
      // Cancelled before anything else. A timer that outlived this cleanup would dial into a torn-down
      // provider — two sockets from one page, which presents as duplicate tool calls rather than as a
      // connection error, and which development-mode double invocation reaches on every mount.
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
      const serving = runtimeRef.current;
      runtimeRef.current = undefined;
      announcedSignatureRef.current = undefined;
      // **Declarations made outside React are RELEASED, not forgotten.** Releasing withdraws each
      // registration this provider made for them — their controllers are owned by the serving code
      // rather than by anything that unmounts, so nothing else would — while KEEPING the declarations,
      // which belong to the application shell and did not unmount. The next provider adopts them
      // again. That split is what "'static' describes OWNERSHIP" means
      // (docs/tools-outside-react.md#static-describes-ownership-not-an-exemption), and holding it in
      // the data rather than as a rule is why a shell-owned tool cannot silently vanish across a
      // remount.
      if (declarationAdopter !== undefined) releaseDeclarations(declarationAdopter);
      // Closed before the runtime is shut down: a registration landing between the two would write an
      // ownership entry into a record nothing serves from.
      gateway.close();
      void serving?.shutdown();
      if (claimed) releaseDocument(holderId);
    };
    // `binding` and `holderId` are allocated once and never change; the server metadata is read at
    // connect time. `hasStarted` is here so that a set which becomes usable starts the library that
    // refused to start without it — and it is MONOTONIC, which is the point.
    //
    // **What is deliberately NOT here is `normalizationOk`, and the reason is a defect this had.** With
    // it, a running provider handed an unreadable set ran this cleanup: the runtime shut down, the
    // gateway closed and the document claim was released. The registrations stayed in the document —
    // correctly, since a capability governs the bridge and not the page — but the NEXT usable render
    // built a runtime with a fresh, empty ownership record, and the hooks do not re-register because
    // their own effect depends on the stable binding. The still-registered tools were then FOREIGN to
    // the new runtime: gone from the agent's listing, refused at the bridge, and unrecoverable without
    // a remount. It also dropped the socket, which only a reconnection would ever restore.
    //
    // "Serves nothing under that capability" does not mean "destroy the bridge". An unreadable set
    // makes the live set deny everything — every bridged call is refused, the operator is told, the
    // page keeps its own tools — and a corrected set admits again with nothing rebuilt.
    // `observation` is created once by `useState` and never replaced, so listing it changes nothing at
    // runtime — but it IS read here, and a dependency list that omits a real read is one a future edit
    // trusts and is wrong about.
  }, [
    binding,
    ownership,
    holderId,
    server.name,
    server.version,
    hasStarted,
    observation,
    reportObserverFailure,
  ]);

  // **The report, on its own, because an unreadable set is not only a mount-time condition.**
  //
  // It fires when the set cannot be read — at mount, or on any later render that made it unreadable —
  // and once per distinct problem rather than once per render. Development has already thrown from the
  // render above; this is the production channel, and it is the only signal an operator gets that the
  // agent is now being refused everything.
  useEffect(() => {
    if (normalizationOk) return;
    propsRef.current.onUnexpectedState(
      new RuntimeError(
        RUNTIME_FAILURE.capabilitiesUnusable,
        `the capabilities given to AgentMcpProvider cannot be used, so this connection is refused every call: ${problemsText}`,
      ),
    );
  }, [normalizationOk, problemsText]);

  // **Telling the agent that what it may reach has changed**.
  //
  // A capability change is neither a registry event nor an ownership event — the two sources the
  // publisher watches — so nothing else would ever mention it, and an agent would keep working from a
  // listing that no longer describes what it can call.
  //
  // Declared AFTER the mount effect so that on a mount this one finds the runtime already recorded and
  // the baseline already taken, and therefore says nothing. It speaks only for a real change: the
  // signature is the granted set's value, not the identity of the object carrying it.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime === undefined) return;
    if (announcedSignatureRef.current === signature) return;
    announcedSignatureRef.current = signature;
    runtime.capabilitiesChanged();
  }, [signature]);

  return (
    <AgentMcpBindingContext.Provider value={binding}>
      <McpCapabilitiesContext.Provider value={publishedCapabilities}>
        <McpConnectionContext.Provider value={state}>{children}</McpConnectionContext.Provider>
      </McpCapabilitiesContext.Provider>
    </AgentMcpBindingContext.Provider>
  );
}

/** Whether a failure means there is no document — the one registry cause that is not an error. */
function isNoDocument(cause: unknown): boolean {
  return codeOf(cause) === REGISTRY_UNAVAILABLE.noDocument;
}

/**
 * Whether a failure came from the connection attempt rather than from starting the library.
 *
 * Decided by membership of the transport's own closed set, never by a string prefix. A prefix test
 * would silently classify a future code that happened to share the shape, and silently miss one that
 * did not. A closed set is declared once and membership is checked against that declaration.
 */
function isConnectionFailure(cause: unknown): boolean {
  const code = codeOf(cause);
  return code !== undefined && isTransportFailureCode(code);
}

function codeOf(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
