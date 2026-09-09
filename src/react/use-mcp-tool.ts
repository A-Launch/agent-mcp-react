import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { IS_DEVELOPMENT } from '../build-mode.ts';
import type {
  DeclaredPermissions,
  OwnershipEntry,
  ToolCallContext,
  ToolHandler,
} from '../runtime/index.ts';
import { FAILURE_VOCABULARY, GATE_OUTCOME, reservedPrefixOf } from '../runtime/index.ts';
import { normalize } from '../runtime/invocation.ts';
import { check, VALIDATION } from '../runtime/validation.ts';
import {
  REGISTRATION_REFUSED,
  type ToolDeclaration,
  WebMcpBoundaryError,
} from '../webmcp/index.ts';
import { type AgentMcpBinding, AgentMcpBindingContext } from './context.ts';
import { sameDescriptor, sameValue } from './descriptor.ts';
import { AgentMcpReactError, REACT_REFUSED } from './errors.ts';

// `useMcpTool`: declares one tool for the lifetime of the calling component.
//
// It is a lifecycle-correct binding onto the browser's tool registry, **not a registry of its own**:
// the document's registry is the sole authority on what exists. It keeps no list, answers no question
// about what exists, and holds nothing an agent could be told about except by way of the registry.
//
// What it owns: one abort controller per registration, the effect that hands the declaration to the
// gateway, and the cleanup that aborts. That abort is the entire withdrawal mechanism — the registry
// offers no unregister operation and returns no handle.
//
// **A rerender must not touch the registry at all**, and that rule is why this hook does not use an
// effect dependency list. A dependency list compares by identity, and an `inputSchema` written inline
// is a new object on every render — so the ordinary spelling cost one withdraw-and-register cycle per
// rerender for every tool that declared a schema, while a tool that declared none cost nothing. The
// registration COUNT stayed correct throughout, which is how it went unnoticed. Registration is driven
// from a comparison of what was last registered instead.

export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /**
   * JSON Schema for the arguments. **Binding**: arguments are validated against it in the runtime
   * before the handler runs, and a call that does not match never reaches the handler. The check runs
   * in the runtime rather than inside the handler, so no application re-implements it.
   *
   * Declaring one requires a validator on the provider. Without it the tool is not registered at all.
   */
  readonly inputSchema?: Record<string, unknown>;
  /**
   * JSON Schema for what the tool returns.
   *
   * When declared, the agent receives structured content matching it **alongside** the text rendering,
   * and a handler result that does not match becomes an error rather than data — a tool that lies
   * about its own output is worse than one that fails.
   *
   * It is **not** carried by the document's registry, whose descriptor has no such field. It reaches
   * the agent through the derived listing instead.
   */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * The application transition this tool performs.
   *
   * It receives the call's arguments and the runtime's call context. Whatever it returns is what the
   * agent receives.
   */
  readonly handler: (
    input: Record<string, unknown>,
    context: ToolCallContext,
  ) => unknown | Promise<unknown>;
  /**
   * What the application says about REACHING this tool, as opposed to what it does.
   *
   * ```tsx
   * useMcpTool({
   *   name: 'invoice.mark_paid',
   *   description: 'Mark the open invoice as paid.',
   *   permissions: { available: invoice.status === 'open' },
   *   handler: () => …,
   * });
   * ```
   *
   * `available: false` means the agent's calls are refused with `MCP_TOOL_DISABLED` and the tool is
   * left out of what the agent lists. It is read live, so a value computed from state applies from the
   * next commit — and it costs no registry cycle, which is why it may track something as fast-moving
   * as a text input.
   *
   * **Three things it is NOT, and each of them is a way to get this wrong:**
   *
   * - **It is not a withdrawal.** The registration stays in the document's shared registry, and every
   *   script in the page — including the application's own code — still invokes it. A capability and a
   *   permission govern THIS LIBRARY'S BRIDGE and never the page
   *   (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page). An author who
   *   moves a domain rule out of a handler and into `available` has stopped enforcing it for every
   *   caller that is not this agent.
   * - **It is not a substitute for the handler's own check.** The handler is the only place a rule
   *   applies to all callers. Declare it here as well so the agent is told before it tries, not
   *   instead.
   * - **It is not hidden by being unlisted.** The exclusion from the listing exists so the agent's
   *   picture of the page matches what it can do; the refusal at invocation is the control, because
   *   absence from a listing is not an access control.
   */
  readonly permissions?: DeclaredPermissions;
}

/**
 * Declares one tool. Registers after the calling component commits; withdraws when it unmounts.
 *
 * Throws when there is no provider above the caller. That refusal is loud rather than a no-op on
 * purpose: a hook that quietly did nothing would leave an application believing it instrumented an
 * action and an agent that never sees the tool — the silent success this library exists to prevent,
 * arriving before a call is even made.
 */
export function useMcpTool(definition: McpToolDefinition): void {
  const binding = useContext(AgentMcpBindingContext);
  if (binding === undefined) {
    throw new AgentMcpReactError(
      REACT_REFUSED.providerMissing,
      `useMcpTool("${definition.name}") was called with no AgentMcpProvider above it, so there is nothing to register into. Mount AgentMcpProvider at or near the application root.`,
    );
  }

  // Captured once, in development only. A duplicate name has to say where the later declaration came
  // from, and a plain stack contains the component's name — no fiber, no owner API, no DevTools hook,
  // because this library reads no React internals. Production captures none: the stack is minified
  // there, so it would cost every registration something to produce a string nobody can read.
  const sourceRef = useRef<string | undefined>(undefined);
  if (IS_DEVELOPMENT && sourceRef.current === undefined) {
    sourceRef.current = declarationSource();
  }
  const definitionRef = useRef(definition);

  // Invariant: **the handler becomes current in the same task as the commit.**
  //
  // Written during render, a render that is begun and DISCARDED would already have changed what a live
  // tool does — an aborted render must expose nothing, and that includes changing behaviour. Written in
  // an ordinary post-commit effect, a caller arriving in the next task reads the PREVIOUS render's
  // handler, and every agent call arrives as a message, which is its own task. Measured both ways
  // round: only the layout effect is both current and reached solely by committed renders.
  useLayoutEffect(() => {
    definitionRef.current = definition;
  });

  // The descriptor as the registry will receive it, rebuilt every render and compared by CONTENT — the
  // object's identity is meaningless here, and comparing it is the defect this feature fixed.
  // Filled in by the gateway once the schemas compile, and read by the registry-facing callback. A
  // ref rather than state: the callback handed to the registry is stable for the registration's whole
  // lifetime, so what it reads has to be a cell rather than a captured value.
  const validatorsRef = useRef<OwnershipEntry['validators']>(undefined);
  /**
   * The declaration lifetime for this mount. Created by the mounting effect, aborted only by its
   * cleanup, and handed to every registration and replacement so a call already running survives a
   * descriptor change and does not survive an unmount.
   */
  const lifetimeRef = useRef<AbortController | undefined>(undefined);

  const declaration = declarationOf(definition, definitionRef, validatorsRef, lifetimeRef, binding);

  // A version that advances **only when the declared content actually changed**, used as the effect's
  // one dependency.
  //
  // The effect cannot simply run every render: React runs an effect's CLEANUP before re-running it, so
  // a dependency-free effect would withdraw and re-register on every render — the very storm this hook
  // exists to prevent, arriving by a different route. And it cannot depend on the declaration object,
  // because that is a new object every render. A version is the only thing here that is both stable
  // across a rerender and different after a change.
  //
  // The comparison happens during render, which is safe for the one thing that would make it unsafe: a
  // render that is begun and DISCARDED contributes at most an advanced version, and the committed
  // render that follows compares against the same stored declaration and computes the same version. It
  // decides only WHEN the effect runs; nothing observable changes until it does.
  const renderedRef = useRef<ToolDeclaration | undefined>(undefined);
  const renderedOutputRef = useRef<Record<string, unknown> | undefined>(undefined);
  const versionRef = useRef(0);
  // The output schema is compared alongside the registry descriptor, because it is agent-visible and
  // the registry descriptor cannot carry it. A change to it alone must still re-register: otherwise
  // the tool goes on advertising an output contract its handler no longer honours, and the mismatch
  // surfaces as a result the agent is told violates a schema nobody changed.
  const outputChanged = !sameValue(renderedOutputRef.current, definition.outputSchema);
  if (
    renderedRef.current === undefined ||
    outputChanged ||
    !sameDescriptor(renderedRef.current, declaration)
  ) {
    renderedRef.current = declaration;
    renderedOutputRef.current = definition.outputSchema;
    versionRef.current += 1;
  }
  const version = versionRef.current;

  // **A SECOND version, for the fields the registry cannot carry, and the split is the whole point of
  // this path**. `permissions` is deliberately absent from the descriptor comparison above:
  // routed through it, a tool available only while a form is valid would withdraw and re-register on
  // every keystroke — a `tools/list_changed` storm, an alarm from the churn detector, and a window per
  // cycle in which the tool does not exist for a page script either.
  //
  // Compared by CONTENT for the same reason the descriptor is: `permissions={{ available: x }}` is a
  // new object on every render, and comparing identity would make every render a change.
  //
  // What that buys, stated precisely because the obvious claim is too strong: it stops a gateway task
  // per render, not a notification per render. Measured — comparing by identity leaves the frame count
  // unchanged, because the publisher speaks only when the derived listing actually differs and absorbs
  // the rest. The saving here is work, and the agent's protection from a storm is the publisher's.
  const permissionsRef = useRef<DeclaredPermissions | undefined>(definition.permissions);
  const declaredPermissionsRef = useRef<DeclaredPermissions | undefined>(definition.permissions);
  const permissionsVersionRef = useRef(0);
  if (!sameValue(declaredPermissionsRef.current, definition.permissions)) {
    declaredPermissionsRef.current = definition.permissions;
    permissionsVersionRef.current += 1;
  }
  const permissionsVersion = permissionsVersionRef.current;

  // Read by the registration effects, which run after this render committed. A layout effect for the
  // same reason the handler uses one: current in the same task as the commit, and reached only by
  // renders that actually committed.
  useLayoutEffect(() => {
    permissionsRef.current = definition.permissions;
  });

  // What was last handed to the gateway. A comparison value and a withdrawal handle — never an answer
  // to what a tool IS, which the document's registry answers as the sole authority on it.
  const registeredRef = useRef<ToolDeclaration | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  // **Two effects, and the split is load-bearing.**
  //
  // React runs an effect's cleanup before re-running it. If one effect handled both the first
  // registration and every change, a descriptor change would abort the old registration in that cleanup
  // — delivering the withdrawal as its own change event — and the replacement would then register into
  // an already-empty name. Two events per change, where a genuine descriptor change must cost exactly
  // one, and that is what the whole same-turn sequencing exists to avoid.
  //
  // So the mounting effect never re-runs, and its cleanup is the unmount withdrawal. Changes are a
  // separate effect that withdraws nothing itself: the gateway's replacement performs the abort and the
  // registration together, in one turn, so the registry coalesces them into one event.
  useEffect(() => {
    const declared = renderedRef.current;
    if (declared === undefined) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    registeredRef.current = declared;

    // **The declaration lifetime, and it is deliberately NOT `controller`.** This one is created once
    // per mount and aborted only by this effect's cleanup, so it means "this component stopped
    // declaring the tool" and nothing else. `controller` is replaced — and the old one aborted — on
    // every descriptor change, which is the withdrawal half of a withdraw-and-register cycle.
    //
    // The runtime composes this into every invocation's signal, so withdrawing a tool cancels the
    // calls running under it (docs/design.md#cancellation). Composing the registration controller
    // instead would cancel an in-flight call whenever a rerender changed a description — and a
    // rerender is deliberately free.
    const lifetime = new AbortController();
    lifetimeRef.current = lifetime;

    void binding.gateway
      .enqueue({
        declaration: declared,
        handler: invokeCurrent(definitionRef),
        controller,
        lifetime: lifetime.signal,
        ...(definitionRef.current.outputSchema === undefined
          ? {}
          : { outputSchema: definitionRef.current.outputSchema }),
        // Carried on the FIRST registration too, not only by a later refresh. A tool declared
        // unavailable from its very first render must be unavailable from the moment it exists —
        // otherwise there is a turn in which the agent may call something the application has never
        // offered, and the window is exactly the one an agent listing at mount would find.
        ...(permissionsRef.current === undefined ? {} : { permissions: permissionsRef.current }),
        onCompiled: (compiled) => {
          validatorsRef.current = compiled;
        },
      })
      .catch((cause: unknown) => reportRegistrationFailure(binding, cause, sourceRef.current));

    return () => {
      // The entire withdrawal, and only on unmount. The gateway clears the ownership entry off this
      // same abort, so the registry and the record cannot drift apart. Aborting twice is harmless,
      // which is what strict mode's double-invoked cleanup requires.
      controllerRef.current?.abort();
      // **Read from the ref, never the `lifetime` this effect closed over.** A rename replaces the
      // declaration lifetime — the old tool is genuinely gone and the new name gets its own — so the
      // controller this closure captured is already aborted while the live one is somewhere else.
      // Aborting the captured one leaves the current lifetime open for the life of the page, and a
      // call running under the renamed tool would never learn its component had unmounted: the agent
      // waits for a handler nothing will stop.
      lifetimeRef.current?.abort();
      controllerRef.current = undefined;
      lifetimeRef.current = undefined;
      registeredRef.current = undefined;
    };
  }, [binding]);

  // The change path. Skips its own first run, because the effect above did the first registration.
  const mountedVersionRef = useRef(version);
  useEffect(() => {
    if (version === mountedVersionRef.current) return;
    mountedVersionRef.current = version;

    const declared = renderedRef.current;
    const previous = registeredRef.current;
    const previousController = controllerRef.current;
    if (declared === undefined || previous === undefined || previousController === undefined)
      return;

    const controller = new AbortController();
    controllerRef.current = controller;
    registeredRef.current = declared;

    // **A name change is a genuine withdrawal; every other change is not.** The distinction decides
    // what happens to a call that is running right now.
    //
    // Change the description or the schema and the tool is still there, under the same name, with the
    // same handler — a rerender costs a running call nothing, and cancelling here would take that
    // back. Change the NAME and the old tool is gone: nothing an agent can call resolves to it
    // any more, so a call still running under it has been abandoned exactly as if the component had
    // unmounted, and leaving it running would let it finish against a tool that no longer exists.
    if (previous.name !== declared.name) {
      lifetimeRef.current?.abort();
      lifetimeRef.current = new AbortController();
    }

    void binding.gateway
      .replace({
        previous,
        previousController,
        declaration: declared,
        handler: invokeCurrent(definitionRef),
        controller,
        // The same lifetime signal, carried across — unless the name changed above, in which case this
        // is the new tool's own.
        ...(lifetimeRef.current === undefined ? {} : { lifetime: lifetimeRef.current.signal }),
        ...(definitionRef.current.outputSchema === undefined
          ? {}
          : { outputSchema: definitionRef.current.outputSchema }),
        // Carried through a descriptor change as well, or a rerender that happened to change both
        // would write a fresh entry with the permissions dropped — and a closed tool would silently
        // reopen because its description changed.
        ...(permissionsRef.current === undefined ? {} : { permissions: permissionsRef.current }),
        onCompiled: (compiled) => {
          validatorsRef.current = compiled;
        },
      })
      .catch((cause: unknown) => reportRegistrationFailure(binding, cause, sourceRef.current));

    // No cleanup. This effect withdraws nothing: the replacement above owns both halves of the cycle,
    // which is the only way the pair costs one change event.
  }, [binding, version]);

  // **The refresh path: a permission change, and nothing else, with no registry cycle.**
  //
  // Its own effect rather than a branch inside the one above, because the two must not be able to run
  // for each other's reason. A change to BOTH a descriptor and a permission in one render advances
  // both versions, and the replacement carries the current permissions itself — so this effect firing
  // as well writes the same value onto the entry the replacement just made, which is idempotent and
  // costs one comparison rather than a second registry event.
  //
  // **A LAYOUT effect, and the choice is about a window rather than about style.** An adversarial
  // review found the defect: from a passive effect, React commits `available: false` and the entry
  // still says `true` until the passive flush — and a socket message is a macrotask, so a call
  // arriving in between is admitted to a tool the application has already closed. Every React test
  // stayed green, because `rerender` runs inside `act()` and flushes passive effects.
  //
  // From a layout effect the whole refresh lands in microtasks after the commit, and microtasks drain
  // before the next task — so at steady state a closed tool is closed before any call can arrive. What
  // is left is not a scheduling gap: a refresh queued while a registration or replacement for the same
  // name is still in flight waits behind it, which is the ordering the design requires rather than a hole.
  //
  // Skips its own first run: the mounting registration already carried the declared permissions.
  const appliedPermissionsVersionRef = useRef(permissionsVersion);
  useLayoutEffect(() => {
    if (permissionsVersion === appliedPermissionsVersionRef.current) return;
    appliedPermissionsVersionRef.current = permissionsVersion;

    const declared = renderedRef.current;
    const controller = controllerRef.current;
    if (declared === undefined || controller === undefined) return;

    void binding.gateway
      .refresh({
        name: declared.name,
        controller,
        permissions: permissionsRef.current,
      })
      .catch((cause: unknown) => reportRegistrationFailure(binding, cause, sourceRef.current));
  }, [binding, permissionsVersion]);
}

/**
 * Routes a refused registration to the channel the build calls for.
 *
 * Invariant this function enforces: **the conflict is reported in BOTH builds; only the consequence
 * differs.** Development throws, so an author is stopped at the moment they can fix it and is told
 * where. Production reports to the operator's destination and leaves the original registration
 * standing, because tearing a page down over a name collision is worse than the collision.
 *
 * `IS_DEVELOPMENT` is read here and nowhere else in this module, from the single owner of that
 * question. Three readings of one condition is three chances to invert one, and the inverted
 * one is silent: two sites keep behaving correctly while the third does the development thing in
 * production.
 */
function reportRegistrationFailure(
  binding: {
    reportFailure(failure: unknown): void;
    reportOperational(failure: unknown): void;
    reportRegistrationEvent(event: { name: string; prefix: string; code: string }): void;
  },
  cause: unknown,
  source: string | undefined,
): void {
  // **Observed BEFORE the build branch, so both builds report it.** A reserved prefix is refused at
  // declaration and produces no call, ever — so if this event were emitted on only one of the two
  // paths, an author in the other build would see a tool silently missing from `tools/list` with
  // nothing anywhere to explain it, which is the exact condition this event exists to prevent (see
  // docs/observing-tool-calls.md).
  //
  // Only the reserved-prefix refusal is surfaced here. A duplicate name and a foreign name already
  // reach the operator through the channels below with codes of their own, and re-homing them would
  // move a fact off its one owner and onto a second.
  if (cause instanceof WebMcpBoundaryError && cause.code === REGISTRATION_REFUSED.nameReserved) {
    const prefix = reservedPrefixOf(cause.subject ?? '');
    // **Guarded, because an observer must not be able to swallow the refusal it is observing.**
    // Unguarded, a throwing `onRegistration` escaped here and the registration failure never reached
    // the destination the build calls for — so an author lost the message telling them why their tool
    // is missing, which is the exact condition this event was added to prevent. The binding routes
    // the observer's own failure to the consumer channel.
    try {
      binding.reportRegistrationEvent({
        name: cause.subject ?? '',
        prefix: prefix ?? '',
        code: cause.code,
      });
    } catch {
      // The binding already reports a throwing observer. Nothing further to do here, and rethrowing
      // would put us back where this guard started.
    }
  }
  if (IS_DEVELOPMENT) {
    binding.reportFailure(withSource(cause, source));
    return;
  }
  binding.reportOperational(cause);
}

/** Attaches where the declaration came from, when the environment offered one. */
function withSource(cause: unknown, source: string | undefined): unknown {
  if (source === undefined || !(cause instanceof Error)) return cause;
  cause.message = `${cause.message}\n    declared at: ${source}`;
  return cause;
}

/**
 * Where the calling component declared its tool, as far as a plain stack can say.
 *
 * Best effort by design: it degrades to no source rather than to a wrong one, and a refusal without a
 * source is still a refusal that names the tool.
 */
function declarationSource(): string | undefined {
  const frames = new Error('declaration site').stack?.split('\n') ?? [];
  // Frame 0 is the message, 1 is this function, 2 is the hook. The caller is the first frame past
  // this module.
  const caller = frames.find((frame, index) => index > 1 && !frame.includes('use-mcp-tool'));
  return caller?.trim();
}

/**
 * Builds what the registry receives.
 *
 * Its handler is invokable by ANY script in the page — that is what adopting a shared registry means,
 * and docs/declaring-a-tool.md says so where an author reads it.
 *
 * **What cancellation this route has, measured rather than assumed.** The standard as shipped types the
 * execute callback `(args, client)`, and that client's entire surface is `requestUserInteraction` —
 * there is no per-call `AbortSignal` on this path at all, so an in-page caller cannot cancel a call it
 * started. The cancellation design assumes one on every route and is wrong about the shipped registry.
 *
 * What DOES exist is the tool's declaration lifetime, so that is what a handler gets: an in-page call
 * running when its declaring component unmounts is cancelled, exactly as a bridged one is. Inventing a
 * per-call controller here would be a substitute signal nothing would ever abort, telling a handler it
 * had cancellation it does not have.
 */
/**
 * Exported so the IMPERATIVE registration path builds its registry descriptor with the same code: one
 * owner per truth. A second builder would be a second answer to "what does a page script get when it
 * calls this tool" — including the input validation, the declaration-lifetime check and the output
 * check this route performs — and the two would drift with nothing failing to say so.
 */
export function declarationOf(
  definition: McpToolDefinition,
  current: { current: McpToolDefinition },
  validators: { current: OwnershipEntry['validators'] },
  lifetime: { current: AbortController | undefined },
  // Narrowed to exactly what the descriptor's callback uses. A structural parameter rather than
  // `AgentMcpBinding` so this function cannot quietly start reaching for the gateway or a failure
  // destination — what it may touch is visible in its own signature.
  binding: Pick<AgentMcpBinding, 'afterRender' | 'observeRegistryCall'>,
): ToolDeclaration {
  const { name, title, description, inputSchema } = definition;
  return {
    name,
    ...(title === undefined ? {} : { title }),
    description,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    handler: async (args) => {
      // **Observation is a SIDE CHANNEL, and every line of its shape is load-bearing.**
      //
      // Opened before the checks below and never awaited, so no `await` is inserted ahead of the
      // validation or the declaration check — inserting one would move a synchronous refusal to a
      // later turn and change when a page script learns it was refused. It cannot throw: a defect in
      // observability must not be able to fail a call that would have succeeded. And whatever this
      // callback rejects with is rethrown UNCHANGED, as the same object, because a page script may be
      // matching on it.
      //
      // The route's ungated steps are recorded as `notRun` rather than left absent: capability,
      // availability and confirmation govern this library's BRIDGE and not the page, so none of them
      // ran here (docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page), and
      // an absent step reads to a consumer exactly like one that passed.
      const observed = binding.observeRegistryCall({ name, arguments: args });
      observed?.gate('capability', GATE_OUTCOME.notRun);
      observed?.gate('policy', GATE_OUTCOME.notRun);
      observed?.gate('confirm', GATE_OUTCOME.notRun);
      observed?.gate('resolve', GATE_OUTCOME.notRun);

      // **This is the route nobody was watching.** The bridged path validates in the runtime, before
      // the gate chain reaches a handler. This callback does not go through the runtime at all — it is
      // whatever the document's registry hands to whoever calls it, which is any script on the page.
      //
      // Before validation existed, that route was guarded only by the checks applications wrote inside
      // their own handlers. Moving validation into the runtime deletes those checks, so without this
      // line an in-page caller would reach handlers with arguments nothing had looked at — the hole
      // opened by the fix.
      //
      // The SAME compiled schema as the bridged path, read through a ref: one compiled contract per
      // tool and one owner of it, so the two routes cannot enforce different things.
      const input = validators.current?.input;
      if (input !== undefined) {
        const outcome = await check(input, args);
        if (outcome.verdict !== VALIDATION.valid) {
          observed?.gate('validate', GATE_OUTCOME.refused);
          // The CODE only. `outcome.reason` is built by the validator and may quote the value it
          // rejected — it is interpolated into the message below, which goes to the page script that
          // called, and it must not also reach an observer.
          observed?.finishError({
            vocabulary: FAILURE_VOCABULARY.route,
            code: REACT_REFUSED.argumentsInvalid,
          });
          throw new AgentMcpReactError(
            REACT_REFUSED.argumentsInvalid,
            `${name} was called with arguments that do not match its declared schema: ${outcome.reason}`,
          );
        }
      }
      observed?.gate('validate', GATE_OUTCOME.passed);
      // Read at CALL time, not when the descriptor was built: the descriptor is built during render
      // and the lifetime is created by the mounting effect that follows it.
      const declared = lifetime.current;
      if (declared === undefined) {
        // No lifetime means no mounted component is declaring this tool — the effect has not run, or
        // its cleanup has. Refused rather than handed a substitute signal: an unexpected state fails
        // loud, and a handler given a controller that can never fire would believe it had cancellation
        // it does not have.
        observed?.gate('invoke', GATE_OUTCOME.notRun);
        observed?.finishError({
          vocabulary: FAILURE_VOCABULARY.route,
          code: REACT_REFUSED.toolNotDeclared,
        });
        throw new AgentMcpReactError(
          REACT_REFUSED.toolNotDeclared,
          `${name} was called through the document registry while no mounted component was declaring it`,
        );
      }
      // The SAME barrier the bridged path gets, from the provider that owns it. An in-page caller is
      // not an agent, but a handler is a handler: what "the change is on screen" means must not depend
      // on which route reached it.
      //
      // **The try wraps ONLY the handler**, and that boundary is load-bearing. The output check below
      // throws a coded refusal of ours; inside this try it would be caught here, re-recorded as
      // `uncoded` and reported as "the application failed" — which is the opposite of what happened.
      // One try per thing that can fail for a different reason.
      let produced: unknown;
      try {
        produced = await current.current.handler(args, {
          signal: declared.signal,
          afterRender: () => binding.afterRender(),
        });
      } catch (cause) {
        // The handler RAN and threw. Reported as UNCODED rather than given one of ours: a borrowed
        // code would tell an operator that a check refused the call when the application simply
        // failed, and send them to read a gate that admitted it.
        observed?.gate('invoke', GATE_OUTCOME.refused);
        observed?.finishError({ vocabulary: FAILURE_VOCABULARY.uncoded });
        // **The same object, never a wrapper.** A page script may be matching on what it catches, and
        // this route is not ours to re-express — the registry handed the caller our descriptor, not a
        // protocol boundary.
        throw cause;
      }

      // **The result is checked on THIS route too, and it did not used to be.** The ownership entry
      // claims "one compiled contract per tool, so the two routes cannot enforce different things" —
      // which was true of input and false of output, invisibly, for six features. The same compiled
      // object the bridge uses is read here through the same ref, so there is one contract rather
      // than two that happen to agree — one owner per truth.
      //
      // **Validated against the NORMALIZED value, exactly as the bridge does, and using the bridge's
      // own `normalize`.** The rule both routes obey is: check what the caller actually receives —
      // and this registry serializes a result to a JSON string too (docs/design.md#tool-results), so
      // what anyone gets.
      //
      // This was briefly written to validate the raw value, on the reasoning that a page script
      // receives the live object. That reasoning was wrong and the defect it produced was measured in
      // BOTH directions: `{ value: { toJSON: () => null } }` under a schema requiring an object
      // passed the raw check and arrived as `{"value":null}` — a delivered value violating its own
      // declared schema — while a `Date` under a string schema failed the raw check although it
      // arrives as a perfectly valid string. One implementation rather than two is what stops that
      // returning.
      const output = validators.current?.output;
      if (output !== undefined) {
        const normalized = normalize(produced);
        if (normalized === undefined) {
          // Cannot be serialized, so it cannot be delivered by this route either — the registry would
          // fail to stringify it. Refused for the same reason and with the same honesty the bridge
          // uses, rather than being handed to a caller that will receive something else.
          observed?.gate('invoke', GATE_OUTCOME.refused);
          observed?.finishError({
            vocabulary: FAILURE_VOCABULARY.route,
            code: REACT_REFUSED.resultViolatesOutputSchema,
          });
          throw new AgentMcpReactError(
            REACT_REFUSED.resultViolatesOutputSchema,
            `${name} ran, but what it returned cannot be serialized, so it cannot be delivered`,
          );
        }
        const outcome = await check(output, normalized.value);
        if (outcome.verdict !== VALIDATION.valid) {
          observed?.gate('invoke', GATE_OUTCOME.refused);
          // The CODE only, never `outcome.reason` — a validator writes it freely and may quote the
          // value it rejected. It is interpolated into the message below, which goes to the caller
          // that asked, and it must not also reach an observer.
          observed?.finishError({
            vocabulary: FAILURE_VOCABULARY.route,
            code: REACT_REFUSED.resultViolatesOutputSchema,
          });
          // **Its own code, never the arguments one.** The handler already ran and may already have
          // mutated the application; a caller told its arguments were refused would believe nothing
          // happened and retry, performing the mutation twice.
          // The validator's reason is deliberately NOT included, for the reason spelled out at the
          // bridge's equivalent refusal in `invocation.ts`: an output violation is the application's
          // own defect, the caller cannot act on the detail, and the detail is application-derived —
          // Ajv names the offending property, and an object's keys are routinely identifiers.
          throw new AgentMcpReactError(
            REACT_REFUSED.resultViolatesOutputSchema,
            `${name} ran, but what it returned does not match its declared output schema`,
          );
        }
      }
      observed?.gate('invoke', GATE_OUTCOME.passed);
      observed?.finishResult(produced);
      return produced;
    },
  };
}

/**
 * The callback the runtime invokes directly for an agent's call — the bridge invokes the handler it
 * registered, and nothing else.
 *
 * Stable for the registration's whole lifetime and reads the latest handler at call time, so a rerender
 * never has to touch the registry to keep behaviour current.
 */
function invokeCurrent(current: { current: McpToolDefinition }): ToolHandler {
  return (input, context) => current.current.handler(input, context);
}
