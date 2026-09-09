import type { DeclaredPermissions } from '../security/index.ts';
import type { ToolDeclaration } from '../webmcp/index.ts';
import type { CompiledSchema } from './validation.ts';

// The ownership record: one entry per tool THIS library registered.
//
// It exists because the document's tool registry answers *which tools exist* and cannot answer
// anything else. It does not distinguish the entries this library created from those any other script
// on the page created, it returns no withdrawal handle, and it holds no handler this library could
// invoke directly. Those three gaps are what this record fills.
//
// **The invariant that makes this an ownership record and not a second registry is what it is never
// asked**: which tools exist, what their schemas are, or whether one is currently registered. Those
// questions have exactly one answer and the registry is where it lives.
//
// That rule is enforced by this file's SHAPE rather than by a test. There is no enumeration, no count,
// no key list and no iterator — so the forbidden question has no operation to reach for. A test
// asserting "the listing path does not enumerate the record" could only cover the call sites that
// exist today; the next one added is the one it would not cover. A surface with nothing to call covers
// the ones that do not exist yet.
//
// The derivation does not need enumeration, and that is not a coincidence: it walks the REGISTRY and
// asks `holds()` about each name. That direction is what makes the registry the authority rather than
// a participant.

/**
 * What is kept for one tool this library registered.
 *
 * Each field is here because the registry cannot hold it, not because it was convenient to keep.
 */
export interface OwnershipEntry {
  /**
   * Aborting this withdraws the registration. The registry offers no unregister operation and returns
   * no handle, so this is the entire withdrawal mechanism.
   */
  readonly controller: AbortController;
  /**
   * The function to call. Held so the bridge can invoke it DIRECTLY rather than through the registry's
   * own execution entry point — which is callable by any script on the page and passes none of this
   * library's checks.
   */
  readonly handler: ToolHandler;
  /**
   * What was last registered. The registration path compares against it so a rerender that changed
   * nothing can skip the registry entirely; the standard has no update operation, so a genuine
   * change costs one withdraw-and-register cycle and there is nothing to fall back on.
   */
  readonly declaration: ToolDeclaration;
  /**
   * What the tool promises to return, when it declared it.
   *
   * **Held here rather than on the declaration, and that is a boundary fact rather than a preference.**
   * `ToolDeclaration` is the shape the document's registry accepts, and the registry's descriptor has
   * no output schema — so putting one there would be inventing a field the standard does not have and
   * would drift the moment the standard changed. It is agent-visible all the same: the derived listing
   * carries it, which is why the publication token must include it or a change to it is invisible.
   */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * The compiled schemas that gate this tool, or nothing when it declared none.
   *
   * Compiled once at declaration and held for the tool's lifetime, because compiling is the expensive
   * half and the performance budget allows under 5 ms of invocation overhead excluding the handler
   * (`docs/records/performance-budgets.md`).
   *
   * **Both call routes use these same objects.** The bridged path reaches them through this record;
   * the descriptor this library puts in the shared registry closes over them. One compiled contract per
   * tool — one owner, both routes derived from it — so the two routes cannot enforce different
   * things.
   */
  readonly validators?: {
    readonly input?: CompiledSchema;
    readonly output?: CompiledSchema;
  };
  /**
   * What the application declared about reaching this tool — availability, and whether an operator
   * must confirm (`docs/reference-capabilities.md#per-tool-permissions`).
   *
   * **Held here rather than on the declaration, and rather than in the registry, because the registry
   * cannot carry it and must not.** The document's descriptor has no such field, and adding one would
   * be inventing a field the standard does not have. It is also the reason a change to this must not
   * cost a registry cycle: availability tracks application state — a tool whose availability follows a
   * text input would withdraw and re-register on every keystroke, alarm the churn detector, and leave
   * a window per cycle in which the tool does not exist for a page script.
   *
   * It is agent-visible all the same: the derived listing excludes an unavailable tool, and the
   * invocation gate refuses a call to one. Both read THIS field — one owner of the answer — which
   * is what stops the listing and the gate from disagreeing.
   */
  readonly permissions?: DeclaredPermissions;
  /**
   * Aborts when this tool stops being DECLARED — the component that owns it unmounted, or the provider
   * tore down. Composed into every invocation's signal, so withdrawing a tool cancels the calls already
   * running under it (`docs/design.md#cancellation`).
   *
   * **Not `controller.signal`, and the difference is the whole reason this field exists.** A
   * registration controller is aborted by two different events: an unmount, and every DESCRIPTOR
   * CHANGE — a replacement's withdrawal half aborts the previous one. Composing that in would make a
   * component whose description depends on state cancel its own in-flight calls whenever that state
   * moved, though the tool is still declared, by the same component, and the handler running is the
   * current one. The handler is stable and reads current state precisely so a rerender costs a call
   * nothing.
   *
   * A **signal**, not a controller: this record must not be able to end a tool's declaration. Only the
   * component that declared it can.
   *
   * Optional because a registrar that is not the React hook — the transport suite's harness, a future
   * non-React binding — may have no declaration lifetime to offer. Its absence means withdrawal does
   * not reach a running call, which is honest for a caller that never withdraws; it is never a
   * substitute signal that cannot fire.
   */
  readonly lifetime?: AbortSignal;
}

/**
 * What the runtime calls, and what it passes.
 *
 * The second parameter exists now although it carries little, because the hook that writes handlers
 * against this shape arrives before the feature that fills it — and adding a parameter later changes
 * every handler, every example and every document that shows one.
 */
export type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolCallContext,
) => unknown | Promise<unknown>;

/**
 * The context a handler receives.
 *
 * It carries only what can be supplied honestly today. A member that is absent is honest; a member
 * that is present and inert is a promise the caller will act on and this library will not keep.
 */
export interface ToolCallContext {
  /**
   * Cancellation for this invocation.
   *
   * The MCP protocol layer's per-request signal composed with the tool's declaration lifetime, using
   * the platform's own composition primitive. Never a controller this library drives by hand: that
   * would be a second owner of one truth and would not abort when the client actually cancels.
   *
   * It aborts on the client's cancellation notification, when the channel ends, and when the component
   * that declared the tool unmounts. It does NOT abort on a descriptor change — the tool is still
   * declared and the handler running is the current one (see `OwnershipEntry.lifetime`).
   */
  readonly signal: AbortSignal;
  /**
   * Resolves once the application has rendered the change this handler just made.
   *
   * **What it promises, stated as the observable condition rather than in frames:** a React commit
   * that includes every update scheduled before the call, and that commit's passive effects.
   * A handler that dispatches and then awaits this can read the rendered result and resolve knowing
   * the agent's success means what the agent will take it to mean.
   *
   * **What it does NOT promise, and this limit is part of the promise.** Work the application
   * schedules from *inside* those effects — a fetch, a timer, an animation, another dispatch — is not
   * covered, and cannot be: no barrier can know when the last of it lands. The library never claims
   * that arbitrary effects completed because a frame elapsed, and this is that rule written as a
   * boundary rather than as a warning.
   *
   * Rejects if the call is cancelled while a handler is waiting on it, so the handler unwinds the way
   * an aborted `fetch` would rather than waiting for a render nobody needs.
   *
   * Where there is nothing to wait for — no renderer bound to this runtime — it resolves. That is the
   * true answer for that configuration, not a convenience default: there is no tree, so there is no
   * commit to wait for.
   */
  afterRender(): Promise<void>;
}

/**
 * What the registry boundary needs in order to classify a refused registration.
 *
 * Declared here and satisfied by the record below, so there is exactly one notion of ownership in the
 * library rather than two that must agree.
 */
export interface OwnershipLookup {
  holds(name: string): boolean;
}

/**
 * The record's whole surface.
 *
 * Read the absences: no `names()`, no `size`, no `entries()`, no `[Symbol.iterator]`. That is the
 * point of the type, not an omission from it.
 */
export interface OwnershipRecord extends OwnershipLookup {
  /** Is this name one we registered? */
  holds(name: string): boolean;
  /** What goes with it, or nothing. */
  entryFor(name: string): OwnershipEntry | undefined;
  /** Records a registration. */
  add(name: string, entry: OwnershipEntry): void;
  /** Forgets one. Idempotent — React's development mode invokes cleanup twice. */
  remove(name: string): void;
  /**
   * Names this record holds that are **not** in the set it is given.
   *
   * This is the one aggregate question the record answers, and it is worth being precise about why it
   * does not breach the rule above.
   *
   * The forbidden question is "which tools exist", asked of the record by a caller that does not
   * already know. This operation cannot serve that purpose, because **its argument is the answer**:
   * you must already hold the registry's complete listing to call it, and what comes back is only the
   * difference. There is no input that makes it return the record's contents — passing an empty set
   * would, and a caller with an empty registry listing has nothing to build a tool list out of anyway.
   *
   * It exists because the alternative was worse. Divergence — a name we recorded that the registry
   * does not have — is a broken invariant, and detecting it needs the record's contents in aggregate.
   * Without this, the only place divergence could be noticed is at invocation, so a diverged tool that
   * nobody happens to call would go unreported indefinitely.
   */
  divergedFrom(registryNames: ReadonlySet<string>): readonly string[];
  /**
   * Reports every `add` and `remove`, so a reader can know the record moved. Returns a disposer.
   *
   * **This exists because the registry's own change event is provably not enough**, and the measurement
   * is worth stating here rather than in a commit message. Registration writes to the registry FIRST
   * and records ownership after, so the registry's event is queued while this record still knows
   * nothing about the tool. A listing derived in that window sees a registry entry with no ownership
   * entry, classifies it as another script's, and excludes it — so an agent told to re-list at that
   * moment finds the tool missing. Measured by widening that window to 5ms: the notification arrives
   * and the listing that follows it is empty.
   *
   * It reports THAT something changed and never WHAT. Passing the name would make this a second way to
   * learn what the record holds, and the whole shape of this interface exists to prevent that.
   */
  onChange(listener: () => void): () => void;
}

/** Creates an empty record. One per runtime, and therefore one per page. */
export function createOwnershipRecord(): OwnershipRecord {
  const entries = new Map<string, OwnershipEntry>();
  const listeners = new Set<() => void>();

  /** Tells every listener the record moved. Carries nothing: they are told THAT, never what. */
  function announce(): void {
    for (const listener of listeners) listener();
  }

  return {
    holds: (name) => entries.has(name),
    entryFor: (name) => entries.get(name),
    add(name, entry) {
      entries.set(name, entry);
      announce();
    },
    remove(name) {
      // Idempotent by construction rather than by a guard: `delete` on an absent key is a no-op. A
      // second cleanup — which StrictMode's double invocation produces on every mount — must not
      // error, because the alternative is a leaked registration that the next mount collides with.
      //
      // Announced unconditionally, including when nothing was there to delete. Whether the record
      // actually moved is not this file's judgement to make: the reader of this event compares the
      // derived listing and speaks only if it differs, so a redundant announcement costs one
      // comparison and a missed one costs an agent its picture of the page.
      entries.delete(name);
      announce();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    divergedFrom(registryNames) {
      const missing: string[] = [];
      for (const name of entries.keys()) {
        if (!registryNames.has(name)) missing.push(name);
      }
      return missing;
    },
  };
}
