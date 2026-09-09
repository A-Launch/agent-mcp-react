import type { ListedTool } from './listing.ts';

// The one decision about whether an agent should be told its tool set changed, and the loop that
// tells it.
//
// **What this module owns:** "should we speak, and have we finished speaking". Nothing else. It does
// not derive the listing, does not touch the registry, does not know what a WebSocket is, and does not
// import React. It is handed a way to derive and a way to send, which is what lets every property
// below be pinned without a socket.
//
// **What it does NOT own, so each absence reads as a decision:** what tools exist (a fresh derivation
// answers that, every time), when a change happened (the registry says), and whether a connection is
// alive (the server closes the epoch).
//
// ## The retained token, and why it is not a second owner of the tool list
//
// This module keeps one thing between calls: an opaque string describing the agent-visible tool set as
// it stood when it last spoke. That is retained state and calling it anything else would be a
// rationalisation.
//
// What makes it permissible is narrower, and checkable: **it cannot answer "what tools exist."** Only
// `deriveListing` can. Nothing is served from it, no listing is reconstructed from it, and it is not
// reachable from the runtime's public surface. `listing.ts` forbids a cached LISTING — a second answer
// to a question the registry already answers — and a value that cannot answer that question is not one.
//
// The structure enforces it rather than a comment promising it: what is stored is a string, so there
// is nothing to serve; it is only ever compared for equality, never inspected or iterated.

/** Derives the agent-visible tool set as it stands right now. Called afresh on every pass. */
export type DeriveTools = () => Promise<readonly ListedTool[]>;

/** Sends one tool-list-changed notification. Resolves when the protocol layer accepted it. */
export type SendNotification = () => Promise<void>;

export interface PublisherOptions {
  readonly derive: DeriveTools;
  readonly send: SendNotification;
  /**
   * Where a send that failed **while the publisher believed it could send** is reported.
   *
   * Deliberately not used for a send skipped because the epoch closed: an unmount is not an anomaly,
   * and reporting one as an unexpected state would train an operator to ignore the channel that
   * carries real ones. Failing loud is only worth anything while the loud channel stays
   * trustworthy.
   */
  readonly onSendFailed: (cause: unknown) => void;
  /**
   * Reports the outcome of one reconciliation, or nothing.
   *
   * **The seam that keeps the agent-visibility question under ONE owner.** This module already decides
   * whether the agent-visible set moved — that is exactly what comparing the derived token against the
   * last reconciled one means — and it decides asynchronously and coalesces. An application-facing
   * "the registry changed" event that recomputed the answer would be a second decider — a second
   * owner of one truth — and the two would disagree the first time coalescing merged two changes.
   *
   * It is reported per RECONCILIATION rather than per raw registry event, and that distinction is
   * forced rather than chosen: a registration updates the document's registry BEFORE the ownership
   * record, so a single raw event has no unambiguous answer to "did the agent-visible set move".
   *
   * Called at the moment the comparison is made, before any send — the set either moved or it did not,
   * and whether telling the agent then succeeded is a different question with its own destination.
   */
  readonly onReconciled?: (outcome: {
    readonly agentVisibleMoved: boolean;
    readonly tools: readonly string[];
  }) => void;
  /**
   * Where a THROW from `onReconciled` goes.
   *
   * Separate from `onSendFailed`, and a review found why it has to be: routing it there made the
   * runtime report an application's logging bug as `MCP_TOOL_NOTIFICATION_FAILED` — telling an
   * operator the agent could not be reached when the agent was reached perfectly well. An operator
   * sent to check a socket for a bug in their own callback has been misled rather than informed.
   */
  readonly onReconciledFailed?: (cause: unknown) => void;
}

export interface ToolListPublisher {
  /**
   * Reports that something that could affect the agent-visible tool set has happened.
   *
   * Cheap, synchronous and safe to call at any rate — it sets a flag and returns. It is the seam a
   * future policy layer calls after a change that alters availability with no registration moving,
   * which is otherwise unreachable: the listing is derived and the notification follows the
   * derivation (`docs/design.md#the-tool-list-is-derived`).
   */
  signal(): void;
  /**
   * Opens the publication window and establishes the baseline, without sending anything.
   *
   * **Awaited, and it derives.** A publisher that merely flipped a boolean would have no idea what the
   * agent already knows, so its first signal would send whether or not anything had changed — and
   * `open(); remove("a name nobody registered")` against an empty page would tell the agent its tool
   * set changed when it had not. The first `tools/list` an agent makes IS its baseline, and this is
   * where the publisher learns the same thing.
   */
  open(): Promise<void>;
  /**
   * Closes it. Idempotent, and terminal for this connection — a later connection is a later epoch.
   * Anything already queued is abandoned silently.
   */
  close(): void;
  /**
   * Resolves when no pass is in flight AND none is queued.
   *
   * Loops rather than awaiting once: a finishing pass can start a restarted one, so awaiting a single
   * promise can return with a fresh pass already running. A caller forced to await twice would be
   * working around this rather than using it, and a test that works around its subject is testing
   * something else.
   */
  settled(): Promise<void>;
}

/**
 * Builds a publisher.
 *
 * Constructing one sends nothing and subscribes to nothing.
 */
export function createToolListPublisher(options: PublisherOptions): ToolListPublisher {
  /** What the agent-visible set looked like when we last successfully spoke. Compared, never read. */
  let lastReconciled: string | undefined;

  /** Whether a signal has arrived that a pass has not yet accounted for. */
  let dirty = false;

  /** Whether a pass is running. Guards against two drains racing on `lastReconciled`. */
  let draining = false;

  /**
   * Which connection this is. Incremented on close, so work queued for a closed connection can tell
   * that it is stale rather than waiting on a promise that will never matter.
   */
  let epoch = 0;
  let open = false;

  let running: Promise<void> = Promise.resolve();

  async function drain(): Promise<void> {
    const mine = epoch;

    // **The loop, and the dirty bit inside it, are the whole correctness argument.**
    //
    // Without them, a signal arriving while a notification is in flight is dropped as "already
    // sending". That is not a lost optimization — it is a permanently stale agent, arriving by the
    // most ordinary route there is. A route change fires two registry events: the withdrawals, then
    // the registrations. If the second lands during the first's send, the agent is told about a set
    // that no longer exists, re-lists it, and is never told again. Nothing reports it.
    while (dirty) {
      dirty = false;

      // Derived afresh every pass. Nothing is carried between iterations except the token, because
      // anything else carried would be a second answer to a question this loop just asked properly.
      const tools = await options.derive();
      if (!open || epoch !== mine) return;

      const token = tokenFor(tools);
      const moved = token !== lastReconciled;
      // Reported for BOTH answers, and the negative one is the interesting half: a foreign script
      // registering a tool reaches this module through the registry's own change event, derives an
      // unchanged agent-visible set, and sends the agent nothing. Without this an operator would have
      // no way to see that it happened at all — the first sign would be a call refused as `foreign`,
      // after the fact and on a different channel.
      reportReconciled({ agentVisibleMoved: moved, tools: tools.map((tool) => tool.name) });
      if (!moved) continue;

      try {
        await options.send();
      } catch (cause) {
        // A closed epoch explains the failure and is not an anomaly: the connection went away while a
        // notification was in flight, which is what teardown looks like. Anything else happened while
        // we genuinely believed we could send, and is loud.
        if (!open || epoch !== mine) return;
        report(cause);
        // The token is NOT advanced. Advancing it on a failed send would make the next genuine change
        // compare equal to something the agent was never told, and it would never be sent.
        return;
      }

      if (!open || epoch !== mine) return;
      // Advanced only here — after a send that actually resolved.
      lastReconciled = token;
    }
  }

  /**
   * Runs a pass and, when it finishes, starts another if work arrived that it could not have seen.
   *
   * **The restart in the `finally` is not belt-and-braces.** A drain returns early when its epoch is
   * closed underneath it, and `draining` stays true until this handler runs — so a `close()` followed
   * by an `open()` and a `signal()` while a pass is still unwinding leaves `dirty` set with nobody
   * draining, and the agent is never told. Nothing would report it. That sequence is exactly what a
   * reconnection does: the bug is latent until something reconnects, and would otherwise have
   * shipped into the first change that exercised it.
   */
  function startDrain(): void {
    draining = true;
    running = drain()
      // `drain` handles its own send failure, so this catches only a defect in this module. An
      // unobserved rejection here would be silent, which is the one thing it must not be — and
      // `report` is used rather than the raw callback so a destination that throws cannot turn one
      // failure into two reports plus an unhandled rejection.
      .catch(report)
      .finally(() => {
        draining = false;
        if (dirty && open) startDrain();
      });
  }

  /**
   * Reports one reconciliation, and never lets a throwing destination break publication.
   *
   * The destination is application-supplied and reaches a provider callback, so it can throw. A throw
   * escaping here would abandon the drain mid-loop with `dirty` possibly set and nobody draining —
   * which is a permanently stale agent, arriving from an application's logging bug. The failure is
   * routed to the same place a send failure goes, so it is not swallowed either.
   */
  function reportReconciled(outcome: {
    readonly agentVisibleMoved: boolean;
    readonly tools: readonly string[];
  }): void {
    try {
      options.onReconciled?.(outcome);
    } catch (cause) {
      // A CONSUMER failure, not a send failure. It must not be able to break publication either: a
      // throw escaping here abandons the drain mid-loop with `dirty` possibly set and nobody
      // draining, which is a permanently stale agent arriving from an application's logging bug.
      try {
        options.onReconciledFailed?.(cause);
      } catch {
        // The destination for consumer failures itself failed. Nowhere further to report, and
        // throwing from a drain would take publication down for everything else.
      }
    }
  }

  /**
   * Reports one failure, exactly once, and never throws out of the publisher.
   *
   * The destination is application-supplied — it reaches `onUnexpectedState` — so it can throw. If it
   * did, the throw would escape `drain`, be caught by the wrapper below, and call the same throwing
   * destination a second time, leaving an unhandled rejection behind. A reporting path that can fail
   * louder than the thing it reports is not a reporting path.
   */
  function report(cause: unknown): void {
    try {
      options.onSendFailed(cause);
    } catch {
      // Deliberately swallowed, and this is the one place in this module where that is right: the
      // operator's own destination is broken, there is nowhere else to say so, and rethrowing would
      // take the page's teardown with it.
    }
  }

  return {
    signal(): void {
      if (!open) return;
      dirty = true;
      if (draining) return;
      startDrain();
    },

    async open(): Promise<void> {
      open = true;
      const mine = epoch;
      // Derived once, and NOT sent. This is the baseline: what the agent will see the first time it
      // lists. Without it the first signal always sends, and a no-op change on a page with no tools
      // would tell an agent its set had changed.
      const tools = await options.derive();
      if (!open || epoch !== mine) return;
      lastReconciled = tokenFor(tools);
      // Reported as a reconciliation that moved NOTHING, which is exactly what it is: this is what the
      // agent will see the first time it lists, and nothing has changed relative to it. Reporting it
      // is the only way an observer learns the CURRENT set — otherwise a page where nothing changes
      // after connecting leaves every observer believing no tools are bridged, which is a surface
      // presenting its own ignorance as fact.
      reportReconciled({ agentVisibleMoved: false, tools: tools.map((tool) => tool.name) });
    },

    close(): void {
      open = false;
      dirty = false;
      epoch += 1;
      // Deliberately NOT cleared. A later connection is a later epoch and starts from no token, and
      // the epoch is what enforces that — leaving the value here means nothing can read it into the
      // next connection by accident.
      lastReconciled = undefined;
    },

    async settled(): Promise<void> {
      // Loops until the publisher is genuinely at rest. A single await can return while a restarted
      // pass is running, because the restart installs a NEW promise in `running` from the old one's
      // `finally`.
      let seen: Promise<void> | undefined;
      while (running !== seen) {
        seen = running;
        await running.catch(() => undefined);
      }
    },
  };
}

/**
 * Builds the comparison token for one agent-visible tool set.
 *
 * Exported for its own cases, and for no other caller.
 *
 * Three properties, each of which is a wrong notification if it is missing:
 *
 * - **Order-insensitive over tools.** The registry promises no enumeration order. A reordering that
 *   changes nothing an agent sees must produce no notification.
 * - **Order-insensitive over object keys, recursively.** Key order is not significant in JSON Schema,
 *   so `{type, properties}` and `{properties, type}` are one schema and must be one token.
 * - **Exact, not hashed.** A hash would trade an exactness this depends on for a saving nothing here
 *   needs, and a collision is a notification that is never sent — silent, and indistinguishable from
 *   a page that did not change.
 */
export function tokenFor(tools: readonly ListedTool[]): string {
  const sorted = [...tools].sort((left, right) => (left.name < right.name ? -1 : 1));
  return canonical(
    sorted.map((tool) => ({
      name: tool.name,
      // Present-or-absent is preserved rather than normalised to a default: a tool that declared no
      // title and one that declared a title equal to its name are different declarations — the
      // listing carries a title only when the application declared one, so that difference is
      // observable to an agent.
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Included, or a tool whose OUTPUT contract changed compares equal and the agent is never told.
      // That change produces no registry event at all — the registry's descriptor cannot carry an
      // output schema — so this token is the only thing that can notice it.
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    })),
  );
}

/**
 * Serializes a value with object keys sorted at every depth.
 *
 * Written out rather than reached for from a library: the whole value of this function is that its
 * behaviour is stated where it is read, and one dependency's idea of canonical JSON changing under us
 * would change what counts as a tool-set change.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is dropped, matching what JSON.stringify does to it — so a key explicitly set to
    // undefined and an absent key produce one token, which is what they mean.
    .filter(([, held]) => held !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`).join(',')}}`;
}
