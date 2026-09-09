import { Server, type Transport } from '@modelcontextprotocol/server';
import {
  type AgentCapabilities,
  admitsLevel,
  CONTROL_LEVEL,
  type ConfirmationResolver,
} from '../security/index.ts';
import { enumerate, onToolChange } from '../webmcp/index.ts';
import { type BuiltInTool, buildBuiltInTable } from './built-ins.ts';
import {
  CALL_ROUTE,
  FAILURE_VOCABULARY,
  GATE_OUTCOME,
  isResolutionRefusal,
} from './call-record.ts';
import { RUNTIME_FAILURE, RuntimeError } from './errors.ts';
import { type InvocationInputs, invoke, type ToolCallResult } from './invocation.ts';
import { type DerivedListing, deriveListing, type ListedTool } from './listing.ts';
import type { ObservationBus } from './observation.ts';
import { createOwnershipRecord, type OwnershipRecord } from './ownership.ts';
import { RESOLUTION, refusalFor, resolve } from './resolution.ts';
import { createToolListPublisher } from './tool-list-publication.ts';

// The browser MCP runtime: one MCP server for one page, speaking over a transport it did not create.
//
// This is the module that joins the two halves built before it — the boundary onto the document's tool
// registry, and the socket transport — so that an agent can see and call a tool. It is defined more by
// what it refuses to keep than by what it does:
//
//   - **No tool list.** `tools/list` is computed from the registry on every request and discarded. The
//     SDK's LOW-level server is used precisely because its high-level counterpart keeps a tool list of
//     its own, which would be a second answer to a question the registry already answers.
//   - **No connection state, no retries, no credentials, no identity.** The transport is handed in.
//   - **No policy or confirmation.** Those are later phases of the capability model, and the gate
//     chain names them as unbuilt rather than leaving gaps that read as checks that passed.
//   - **No capability set of its own.** It is handed a supplier and reads it at every gate, so the
//     answer is whatever the application currently grants rather than whatever it granted at mount.

export interface RuntimeOptions {
  /**
   * What the agent is told this server is. Supplied by the application
   * (`docs/design.md#server-metadata`).
   */
  readonly serverInfo: { readonly name: string; readonly version: string };
  /**
   * Where a broken invariant goes.
   *
   * **Required, and deliberately not optional.** A list request still succeeds for every other tool
   * when one name diverges, so there is no response to carry the alarm — and a runtime that could be
   * built without a destination is one whose alarms default to silence, which is the condition the
   * divergence rules exist to prevent.
   *
   * It is never the agent. A registry-integrity report is the operator's business, and the agent is
   * the party the ownership record exists to constrain.
   */
  readonly onUnexpectedState: (failure: RuntimeError) => void;
  /**
   * Where a call's observation goes, or nothing.
   *
   * Optional because observability is: an application supplying no callbacks and mounting no inspector
   * must pay nothing, and with no bus supplied not a single record is built. It is created by the
   * PROVIDER rather than held at module scope, so a provider whose document claim was refused cannot
   * subscribe to another provider's stream and an old call's terminal cannot reach a remounted one.
   */
  readonly observation?: ObservationBus;
  /**
   * Reports each reconciliation of the document's registry against the agent-visible tool set.
   *
   * Optional, and forwarded straight from the publisher — this module decides nothing about it. It
   * fires for a change made by a script this library does not own too, reporting that the agent-visible
   * set did NOT move, because otherwise a foreign registration is invisible until a call is refused as
   * `foreign` after the fact.
   */
  readonly onRegistryChange?: (outcome: {
    readonly agentVisibleMoved: boolean;
    readonly tools: readonly string[];
  }) => void;
  /** Where a throw from `onRegistryChange` goes. Never the send-failure destination. */
  readonly onRegistryChangeFailed?: (cause: unknown) => void;
  /**
   * Waits for the application to have committed what a handler just changed, for `context.afterRender()`.
   *
   * Supplied by whoever binds a renderer to this runtime — in practice the provider, which is the only
   * code that knows what a commit is. The runtime DECLARES the shape and receives the implementation:
   * `src/runtime/` imports no React, which is what lets every case in this directory run without one.
   *
   * Optional, and its absence means exactly what it says: no renderer is bound, so there is nothing to
   * wait for and the barrier resolves. The public entry point never produces that configuration — the
   * provider always supplies one — so an application cannot reach a silently inert barrier.
   */
  readonly renderBarrier?: () => Promise<void>;
  /**
   * The ownership record this runtime serves from, when the caller owns one.
   *
   * **Optional, and its absence creates a fresh one** — so a caller that has no opinion gets exactly
   * what it got before this parameter existed.
   *
   * It exists because a runtime is per-CONNECTION and a registration is not. A tool belongs to the
   * mounted application; a network event is not a reason to withdraw one, and a reconnection builds a
   * new runtime because one runtime measurably cannot serve a second connection. A record created here
   * would therefore die with the connection, and the next runtime would find every already-mounted tool
   * missing — foreign to it, absent from the agent's listing and refused at the bridge, with no way
   * back short of remounting the application.
   *
   * So the record's lifetime belongs to whoever owns the registrations, which is the provider. This
   * parameter is how it says so. Nothing here changes what a record IS or who may write to it.
   */
  readonly ownership?: OwnershipRecord;
  /**
   * Told when the channel ended without anyone calling `shutdown()` — a socket that dropped.
   *
   * **This runtime is the only thing that can know it in time.** The protocol layer claims the
   * transport's close handler during `connect`, so a caller wrapping it afterwards has a window: the
   * connect call does more work after the channel is live — subscriptions, and a publication baseline
   * that awaits — and a peer closing inside that window fires a handler the caller has not installed
   * yet. The caller then reports a connection that is already gone and waits forever for an event that
   * has been and passed.
   *
   * Installed here synchronously with the wrap that already exists, so there is no such window.
   * Optional: a caller with no recovery policy has nothing to do with it.
   */
  readonly onChannelEnded?: () => void;
  /**
   * What the bridged connection may reach — read at every gate, never copied.
   *
   * **Required, and a supplier rather than a value.** Required because there is no default capability
   * profile — authority only narrows, and an absent set would be a profile granted by omission; a
   * supplier because the set is read LIVE. A runtime holding a copy would keep admitting calls after
   * an operator withdrew a capability, and the confirmation recheck a later phase performs would be
   * checking a snapshot against itself.
   *
   * It gates **this library's bridge only**. A Level 1 tool stays in the document's shared registry
   * whatever this says, and any script on the page reaches it without passing here — a
   * capability governs the bridge, not the page
   * (`docs/explanation-reachability.md#a-capability-governs-the-bridge-not-your-page`).
   */
  readonly capabilities: () => AgentCapabilities;
  /**
   * The Level 2 and Level 3 tools this build ships. **Empty in production, and empty here.**
   *
   * An INTERNAL seam rather than a provider prop: an application does not choose which built-ins
   * exist, it chooses which of them an agent may reach — and that is what `capabilities` is for.
   * The Level 2 DOM tools reach this door, and `runtime.evaluate` uses the same one.
   *
   * Invariant: **nothing here is ever put in the document's tool registry, in any configuration,
   * including one that enables it** (`docs/design.md#security-invariants`). That registry is shared
   * with every script on the page, so an entry in it is invokable with not one of this runtime's gates
   * in the path — which for a DOM tool would be a page-wide remote control no capability could take
   * back.
   * These tools exist only in this table, and the only route to them is the bridged `tools/call`
   * handler below, where the capability gate runs.
   *
   * Optional because a build with none is the ordinary case rather than an unanswered question.
   */
  readonly builtIns?: readonly BuiltInTool[];
  /**
   * How an operator is asked to approve a call, or nothing.
   *
   * A supplier rather than a resolver, so an application that swaps its dialog is not still being
   * asked through the old one. Its absence is **not** a permission: a tool declaring
   * `confirmation: 'required'` with nobody to ask is refused, and stays listed.
   */
  readonly confirmationResolver?: () => ConfirmationResolver | undefined;
}

export interface McpRuntime {
  /** The ownership record. Populated by whoever registers tools — a test, or the React hook. */
  readonly ownership: OwnershipRecord;
  /** Attaches to a transport and begins serving. */
  connect(transport: Transport): Promise<void>;
  /**
   * Stops serving. Terminal for the RUNTIME: a new connection is a new runtime.
   *
   * **Not terminal for the ownership record**, when one was supplied. This shutdown withdraws the
   * subscriptions this runtime took on it and stops serving; the record itself, and every registration
   * in it, belongs to whoever supplied it and is untouched. That is what lets a reconnection keep the
   * application's tools.
   */
  shutdown(): Promise<void>;
  /**
   * Tells the runtime the capability set has changed, so the agent can be told what it can now see.
   *
   * A capability change is neither a registry event nor an ownership event — the two sources the
   * publisher already watches — so without this call a connected agent is never told that a capability
   * was granted or withdrawn. It reaches the publisher, which sends only if the derived
   * listing actually differs; in a build with no built-ins nothing differs and nothing is sent, which
   * is correct rather than a no-op waiting to be deleted.
   *
   * The runtime does not watch for the change itself, because the set lives in the application: it is
   * told, by whoever holds it.
   */
  capabilitiesChanged(): void;
}

/**
 * Creates a runtime. Connects nothing, registers nothing, opens nothing.
 *
 * Construction is free of effect so a provider can build one during a render that may never commit.
 */
export function createMcpRuntime(options: RuntimeOptions): McpRuntime {
  // Supplied by a caller whose registrations outlive one connection, or created here for one that has
  // no such need. Either way this runtime only ever reads and serves from it — the record is not part
  // of what `shutdown()` ends.
  const ownership = options.ownership ?? createOwnershipRecord();
  // Built once. The table is a build-time constant, so a malformed entry throws HERE rather than
  // surfacing as a refusal of a correct agent call much later — and it is this library's own bug, for
  // which no embedder has a remedy and no destination would help.
  const builtIns = buildBuiltInTable(options.builtIns ?? []);
  const claimedNames: ReadonlySet<string> = new Set(builtIns.keys());
  let serving = false;

  const server = new Server(options.serverInfo, {
    // Declared at construction because it cannot be added later without rebuilding the server. The
    // publisher below sends the notifications themselves; a capability discovered to be missing at
    // the moment a tool set changes is discovered too late.
    capabilities: { tools: { listChanged: true } },
  });

  /**
   * The built-ins this connection may see right now.
   *
   * The capability set is read LIVE here for the same reason the gate reads it live: a listing derived
   * from a set captured at construction would go on advertising a tool an operator has since withdrawn
   * the capability for, and the agent would learn about it only by being refused.
   *
   * Filtering the listing is NOT the control, and nothing here relies on it being one. A built-in
   * excluded from this list is still refused at invocation by the gate in `invocation.ts`, because
   * absence from a listing is not an access control — this exists so an agent's picture of the page
   * matches what it can actually do.
   */
  function admittedBuiltIns(): readonly ListedTool[] {
    const granted = options.capabilities();
    const admitted: ListedTool[] = [];
    for (const tool of builtIns.values()) {
      if (!admitsLevel(granted, tool.level, tool.domAuthority).admitted) continue;
      admitted.push({
        name: tool.name,
        description: tool.description,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        inputSchema: { properties: {}, ...tool.inputSchema, type: 'object' },
      });
    }
    return admitted;
  }

  /**
   * The listing as it stands right now — the one derivation, called by both readers of it.
   *
   * The list handler and the change publisher must agree by construction, not by both being written
   * correctly. A second derivation would be a second owner of the answer this one gives, and the
   * two would drift the first time one of them learned about policy and the other did not.
   *
   * It reports nothing. Divergence is reported by the LIST handler alone, below: an alarm raised from
   * the request path is one an operator can correlate with a request, and raising it from here as well
   * would double every report and make a standing divergence look like a worsening one.
   */
  async function currentListing(): Promise<DerivedListing> {
    return deriveListing(
      await enumerate(),
      ownership,
      (name) => {
        const entry = ownership.entryFor(name);
        if (entry === undefined) return undefined;
        // The output schema is merged in from the ENTRY rather than the declaration, because the
        // declaration is the shape the document registry accepts and that shape has no output schema.
        return {
          ...entry.declaration,
          ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
          // The same field the invocation gate reads, from the same entry. Two readers, one owner.
          ...(entry.permissions === undefined ? {} : { permissions: entry.permissions }),
        };
      },
      { claimed: claimedNames, admitted: admittedBuiltIns() },
    );
  }

  // Owns the whole decision about whether the agent should be told the tool set changed. Constructed
  // here because this module is the composition root — it holds the MCP server, the serving window and
  // the only thing that can actually send — and the publisher holds none of those.
  const publication = createToolListPublisher({
    derive: async () => (await currentListing()).tools,
    send: () => server.sendToolListChanged(),
    // Passed through rather than decided here: the publisher is the one owner of "did the agent-visible
    // set move", and this runtime only forwards what it reported.
    ...(options.onRegistryChange === undefined ? {} : { onReconciled: options.onRegistryChange }),
    // A consumer's own throw, kept apart from a send failure. Reporting it as
    // `toolListNotificationFailed` would tell an operator the agent could not be reached when it was
    // reached perfectly well.
    ...(options.onRegistryChangeFailed === undefined
      ? {}
      : { onReconciledFailed: options.onRegistryChangeFailed }),
    onSendFailed: (cause) =>
      options.onUnexpectedState(
        new RuntimeError(
          RUNTIME_FAILURE.toolListNotificationFailed,
          `the agent could not be told the tool set changed, so it is working from the listing it last read: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      ),
  });

  /** Withdraws the change subscriptions. Empty until connected. */
  let unsubscribe: Array<() => void> = [];

  /** Refuses anything arriving outside the serving window, rather than queueing it. */
  function assertServing(): void {
    if (serving) return;
    throw new RuntimeError(
      RUNTIME_FAILURE.runtimeNotServing,
      'the runtime is not connected, so the request was refused',
    );
  }

  server.setRequestHandler('tools/list', async () => {
    assertServing();

    // Enumerated fresh on every request. Nothing here is cached and there is no operation anywhere in
    // this module that would invalidate a cache, because there is none to invalidate.
    const listing = await currentListing();

    // Reported, never folded into the response. The listing succeeded for every other tool, so there
    // is no error to return — which is exactly why the destination is a construction-time requirement.
    for (const name of listing.diverged) {
      options.onUnexpectedState(refusalFor(name, RESOLUTION.diverged));
    }

    // Copied into a mutable array because the protocol layer's own result type is mutable.
    return { tools: [...listing.tools] };
  });

  /**
   * A successful result's text, for an observation under `values`.
   *
   * Only ever reached on a SUCCESS — a refusal's composed message never comes through here, because
   * `finishError` takes a code and no value at all.
   */
  function textOf(result: ToolCallResult): unknown {
    const first = result.content[0];
    return first !== undefined && first.type === 'text' ? first.text : undefined;
  }

  server.setRequestHandler('tools/call', async (request, extra): Promise<ToolCallResult> => {
    assertServing();

    const name = request.params.name;

    // **The observation begins HERE, before `resolve` runs, and not inside `invoke`.**
    //
    // A name that resolves to `unknown`, `foreign` or `diverged` is refused a few lines below and
    // never enters `invoke` at all. Instrumentation placed there would therefore emit neither a start
    // nor a terminal for the commonest refusal an agent produces — and every test using a tool that
    // DOES exist would have passed. The dispatcher is where a call's life actually begins.
    //
    // `authenticate` is not set here: the bus derives it from the route, because it is decided at the
    // socket upgrade before a call exists — so it is already true on the START record, which publishes
    // before any gate below has run.
    const observed = options.observation?.beginIfObserved(() => ({
      name,
      route: CALL_ROUTE.bridge,
      startedAt: Date.now(),
      arguments: request.params.arguments,
    }));
    const outcome = resolve(name, await enumerate(), ownership, builtIns);
    observed?.gate(
      'resolve',
      outcome === RESOLUTION.owned || outcome === RESOLUTION.builtIn
        ? GATE_OUTCOME.passed
        : GATE_OUTCOME.refused,
    );
    if (isResolutionRefusal(outcome)) observed?.refusedResolution(outcome);

    // The signal the protocol layer created for THIS request — reached at `extra.mcpReq.signal`, which
    // is not where the specification says to look. It aborts when the client sends a cancellation
    // notification and when the channel ends.
    const requestSignal =
      (extra as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal ?? neverAborts();

    // The call's ONE terminal, built from the value `invoke` actually RETURNS.
    //
    // `invoke` has many return points and each knows its own failure code, so each NOTES one; this
    // settles once. That ordering is what makes the guarantee structural rather than a rule every
    // return obeys — and it is the only shape that survives the three paths which run AFTER a handler
    // has already resolved: an unserializable result, a violated output schema, and a cancellation
    // landing inside asynchronous output validation. A site that settled on handler resolution would
    // emit a second ending for each, and would look correct in every test of a plain success.
    //
    // **No failure path hands the projector a string.** `finishError` takes a code from a closed
    // vocabulary and nothing else, so a refusal's composed message — which a future edit could make
    // carry anything — has nowhere to go. Only a SUCCESS carries a value, and only under `values`.
    const settle = (result: ToolCallResult): ToolCallResult => {
      if (observed === undefined) return result;
      if (result.isError === true) observed.finishError();
      else observed.finishResult(result.structuredContent ?? textOf(result));
      return result;
    };

    if (outcome === RESOLUTION.builtIn) {
      const builtIn = builtIns.get(name);
      if (builtIn === undefined) {
        // Resolution said the table holds it and the table disagrees one line later. Not reachable —
        // the table is immutable from construction — and reported rather than assumed impossible,
        // because a hidden unknown is worse than a loud one.
        const refusal = refusalFor(name, RESOLUTION.diverged);
        options.onUnexpectedState(refusal);
        return {
          content: [{ type: 'text', text: `${refusal.code}: ${refusal.message}` }],
          isError: true,
        };
      }

      // **The same `invoke` the registered route uses, and that is deliberate.** A built-in gets the
      // same gate chain, the same cancellation, the same guarantee that something reaches the agent.
      // A second dispatch path for the privileged tools would be the one place those guarantees could
      // silently differ — and it would differ in the direction where it matters most.
      return settle(
        await invoke(
          name,
          {
            handler: builtIn.handler,
            description: builtIn.description,
            ...(builtIn.validators === undefined ? {} : { validators: builtIn.validators }),
          },
          (request.params.arguments ?? {}) as Record<string, unknown>,
          {
            requestSignal,
            afterRender: options.renderBarrier ?? noRenderBarrier,
            capabilities: options.capabilities,
            // **From the table it was found in, never from the name.** A prefix test here would make a
            // naming convention the control boundary — which is exactly what keeping the three
            // control levels separate forbids — and a typo would then promote or demote a tool
            // silently.
            level: builtIn.level,
            ...(builtIn.domAuthority === undefined ? {} : { domAuthority: builtIn.domAuthority }),
            // A built-in's permissions come from its own table entry, which is a constant — but it is read
            // through the same supplier the registered route uses, so the gate has one shape rather than
            // two that happen to agree.
            permissions: () => builtIn.permissions,
            ...(observed === undefined ? {} : { observation: observed }),
            ...(options.confirmationResolver === undefined
              ? {}
              : { confirmationResolver: options.confirmationResolver }),
          } satisfies InvocationInputs,
        ),
      );
    }

    if (outcome !== RESOLUTION.owned) {
      const refusal = refusalFor(name, outcome);
      // A divergence noticed here is the same broken invariant the listing reports, arriving by the
      // other path. Reported as well as refused; every other tool keeps working.
      if (outcome === RESOLUTION.diverged) options.onUnexpectedState(refusal);
      // The refusal's CODE, never its message — the message is composed for the agent and a future
      // edit to it could carry anything. The code is a member of a closed vocabulary.
      observed?.finishError({ vocabulary: FAILURE_VOCABULARY.runtime, code: refusal.code });
      return {
        content: [{ type: 'text', text: `${refusal.code}: ${refusal.message}` }],
        isError: true,
      };
    }

    const entry = ownership.entryFor(name);
    if (entry === undefined) {
      // Resolution said we own it and the record disagrees one line later. Not reachable by any known
      // path, and reported rather than assumed impossible — an unknown state is never hidden.
      const refusal = refusalFor(name, RESOLUTION.diverged);
      options.onUnexpectedState(refusal);
      observed?.gate('resolve', GATE_OUTCOME.refused);
      observed?.refusedResolution(RESOLUTION.diverged);
      observed?.finishError({ vocabulary: FAILURE_VOCABULARY.runtime, code: refusal.code });
      return {
        content: [{ type: 'text', text: `${refusal.code}: ${refusal.message}` }],
        isError: true,
      };
    }

    // Handed over raw. `invoke` composes the cancellation and builds the handler's context, because
    // deciding what a call's outcome is belongs to the file that decides a call's outcome, and to
    // one file only — putting it here would make it a property of the transport wiring instead.
    return settle(
      await invoke(
        name,
        {
          handler: entry.handler,
          description: entry.declaration.description,
          ...(entry.declaration.title === undefined ? {} : { title: entry.declaration.title }),
          ...(entry.lifetime === undefined ? {} : { lifetime: entry.lifetime }),
          ...(entry.validators === undefined ? {} : { validators: entry.validators }),
        },
        (request.params.arguments ?? {}) as Record<string, unknown>,
        {
          requestSignal,
          afterRender: options.renderBarrier ?? noRenderBarrier,
          capabilities: options.capabilities,
          // **Level 1 by construction, not by name.** This entry resolved in the document's registry,
          // which is where an application's own tools are and the only table this dispatch reads. A level
          // read off a prefix would make a naming convention the control boundary — precisely what
          // keeping the three control levels separate forbids — and the built-in table supplies its
          // own level rather than anything being recognised here.
          level: CONTROL_LEVEL.application,
          // **Re-read from the record on every gate, never from the entry captured above.** `refresh`
          // replaces the entry object, so a captured one goes stale the moment the application changes
          // what it is offering — and a confirmation can be open for minutes.
          permissions: () => ownership.entryFor(name)?.permissions,
          ...(observed === undefined ? {} : { observation: observed }),
          ...(options.confirmationResolver === undefined
            ? {}
            : { confirmationResolver: options.confirmationResolver }),
        } satisfies InvocationInputs,
      ),
    );
  });

  return {
    ownership,
    capabilitiesChanged(): void {
      publication.signal();
    },
    async connect(transport: Transport): Promise<void> {
      // `connect()` calls `transport.start()` itself, after installing its callbacks. Nothing else may
      // start a transport: a message arriving before those callbacks exist is dropped with no error.
      await server.connect(transport);
      serving = true;

      // **Wrapped after connecting, and the protocol layer's own handler runs first.** The layer
      // claims `onclose` during `connect`, so an earlier assignment is silently replaced. This is the
      // ONLY place that learns the channel ended without anyone calling `shutdown()` — a socket that
      // dropped underneath the page. Without it a queued notification still believes it may send, the
      // protocol layer rejects it with "Not connected", and a torn-down page reports an alarm about a
      // connection nobody expected to still be there.
      const protocolOnClose = server.onclose?.bind(server);
      server.onclose = () => {
        // Our own teardown runs in a `finally`, so a throw from the protocol layer's handler cannot
        // leave the runtime believing it is still serving with a publication window still open —
        // which would be a notification sent into a channel that has already gone.
        try {
          protocolOnClose?.();
        } finally {
          serving = false;
          publication.close();
          // Last, and outside nothing: whoever owns a recovery policy is told only once this runtime
          // has finished ending. A callback that ran first could see a runtime that still believed it
          // was serving.
          options.onChannelEnded?.();
        }
      };

      // **Subscribed BEFORE the window opens, and the order is the fix for a real hole.** Opening
      // first and subscribing after leaves a window — the `await` on the registry subscription — in
      // which a change reaches neither source. An already-connected client can list across that gap
      // and stay stale for the rest of the connection, with nothing anywhere reporting it.
      //
      // Subscribing first is harmless in the other direction: `signal()` returns immediately while the
      // window is shut, and `open()` then derives the baseline from the registry as it stands, so a
      // change that lands between the subscription and the open is already IN that baseline.
      //
      // Subscribed here rather than at construction: a runtime is built during a render that may never
      // commit, and a subscription taken then would outlive a tree that never existed.
      //
      // **Both sources, and neither is redundant.**
      //
      // The listing is the registry intersected with the ownership record, so a change to EITHER can
      // move it, and each has a change the other cannot see:
      //
      //   - The registry alone is provably insufficient. Registration writes to the registry first and
      //     records ownership after, so the registry's event fires while the record still knows nothing
      //     about the tool — a derivation in that window excludes it as another script's, and an agent
      //     told to re-list then finds nothing. Measured by widening that window: the notification
      //     arrives and the listing that follows it is empty.
      //   - The record alone is insufficient too. An entry vanishing from the registry with no
      //     ownership change is a divergence, and it changes the listing.
      //
      // Signalling twice for one change costs one comparison, because the publisher speaks only when
      // the derived listing actually differs. Signalling once too few costs an agent its picture of the
      // page, silently.
      unsubscribe = [
        await onToolChange(() => publication.signal()),
        ownership.onChange(() => publication.signal()),
      ];

      // Opened last, and it derives the baseline without sending: what the agent will see the first
      // time it lists is what the publisher now believes it has been told.
      await publication.open();
    },
    async shutdown(): Promise<void> {
      serving = false;
      // Closed before the server, in this order deliberately: closing the publication first means a
      // change arriving during teardown is dropped by the epoch rather than reaching a half-closed
      // protocol layer.
      publication.close();
      for (const withdraw of unsubscribe.splice(0)) withdraw();
      await server.close();
    },
  };
}

/**
 * The barrier for a runtime with no renderer bound to it.
 *
 * Resolves, because that is the true answer for that configuration: there is no tree, so there is no
 * commit to wait for. It is not a convenience default standing in for a fact — the public entry point
 * never produces this configuration, since the provider always supplies a real one.
 */
function noRenderBarrier(): Promise<void> {
  return Promise.resolve();
}

/**
 * A signal that never fires, for the case where the protocol layer supplied none.
 *
 * Not expected to be reached — the SDK attaches a per-request controller to every dispatch. It exists
 * because the alternative is handing a handler `undefined` where its type promises a signal, and a
 * handler that calls `signal.addEventListener` would then fail inside application code for a reason
 * that has nothing to do with the application.
 */
function neverAborts(): AbortSignal {
  return new AbortController().signal;
}
