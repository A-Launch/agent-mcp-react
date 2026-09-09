import { RUNTIME_FAILURE, RuntimeError } from '../runtime/errors.ts';
import type {
  DeclaredPermissions,
  OwnershipEntry,
  OwnershipRecord,
  ToolHandler,
} from '../runtime/index.ts';
import { RESERVED_PREFIX, reservedPrefixOf } from '../runtime/index.ts';
import type { CompiledSchema, SchemaValidator } from '../runtime/validation.ts';
import type { ToolDeclaration } from '../webmcp/index.ts';
import {
  REGISTRATION_REFUSED,
  register,
  replaceRegistration,
  WebMcpBoundaryError,
} from '../webmcp/index.ts';

// The registration gateway: the one thing that puts a component's tool into the document's registry,
// and the reason `useMcpTool` does not talk to the registry itself.
//
// It exists for two measured reasons, neither visible from the specification.
//
// **React runs a CHILD's effect before its PARENT's.** A `useMcpTool` inside the provider therefore
// fires before the provider has resolved the registry or built a runtime. The hook cannot resolve one
// itself without giving "who resolves the registry" two owners, the second of which runs first — so
// it hands work here, and this module waits for the provider to say what it may register into.
//
// **Registration is asynchronous and effects are not.** Under strict mode the renderer performs
// setup / cleanup / setup in one commit, so two registrations of ONE name are in flight at once. The
// withdrawn one lands second and is refused. What makes that trap hard to see is the outcome: exactly
// one registration survives and it is the right one, so a case counting registrations passes while the
// author receives a spurious refusal on every mount in development.
//
// What it owns: the order of registration work for a name, and the ownership entry that must exist if
// and only if a registration actually happened.
//
// What it is NEVER asked: which tools exist, what a tool's schema is, whether a name is registered.
// Those questions have one answer and it lives in the document's registry, which is the sole authority
// on what a tool is. What makes this an ordering structure rather than a second registry is not how
// little it holds — it is what it is never asked.

export interface RegistrationGateway {
  /**
   * Enqueues one registration for `declaration.name`.
   *
   * Resolves when the tool is registered, when the registration was withdrawn before it happened, or
   * when the provider tore down first — the three outcomes that are not failures. Rejects only on a
   * genuine refusal, which is the author's to see.
   */
  enqueue(request: RegistrationRequest): Promise<void>;
  /**
   * Replaces an existing registration with a changed descriptor, as ONE change.
   *
   * Queued on the same chain as `enqueue` for the name, so a change cannot overtake the registration it
   * is replacing. Where the name itself changed, both names are held for the duration — the old one is
   * withdrawn and the new one registered, which the registry necessarily reports as two changes because
   * two names genuinely changed.
   */
  replace(request: ReplacementRequest): Promise<void>;
  /**
   * Updates the fields of an existing registration that the REGISTRY cannot carry, without touching it.
   *
   * **The first write to the ownership record not paired with a registry write, and the reason it
   * exists is a measurement.** `permissions.available` tracks application state — a tool available only
   * while a form is valid changes on every keystroke. Routed through `replace` it would cost a full
   * withdraw-and-register cycle each time: a `tools/list_changed` storm for the agent, an alarm from
   * the churn detector, and a window per cycle in which the tool does not exist for a page script
   * either. The registry has no opinion about these fields, so there is nothing there to update.
   *
   * It is NOT a second authority. The registry remains the authority on EXISTENCE; this only writes
   * fields it does not carry, and only for a name it currently holds.
   *
   * Queued on the same per-name chain as everything else, with the same epoch and withdrawal checks —
   * a late refresh for a tool that has since been renamed or unmounted must not write an entry back
   * into a record whose registry no longer holds the name. That is a divergence this library would
   * have manufactured itself, and the runtime would correctly alarm about a tool nobody touched.
   */
  refresh(request: RefreshRequest): Promise<void>;
  /**
   * The provider's effect calls this once the registry is resolved, naming the record to write into.
   *
   * Re-openable on purpose. Under strict mode the provider's effect runs, is cleaned up and runs
   * again while the children's effects read one gateway object from one context value — so a terminal
   * open would leave the second mount with nothing registered at all.
   */
  open(ownership: OwnershipRecord, validator?: SchemaValidator): void;
  /** The provider's cleanup, or a failed mount, calls this. Idempotent; re-armed by the next `open`. */
  close(): void;
}

/**
 * How many withdraw-and-register cycles one registration may perform before the churn is reported.
 *
 * A **count**, deliberately not a rate. A time window would be a timer a case has to race, and buying
 * a green run with timing is a workaround rather than a fix — see CONTRIBUTING.md#9-forbidden-patterns.
 * Not an option either: a caller-supplied threshold is a caller's opportunity to set one that never
 * fires.
 *
 * The value is a judgement rather than a measurement, and it is set where a deliberate change is
 * plausible and an accidental one is not. A screen that legitimately re-declares its tool a handful of
 * times over its life stays quiet; a descriptor computed from a changing value crosses it immediately.
 */
const IMPLAUSIBLE_CYCLE_COUNT = 20;

export interface ReplacementRequest extends RegistrationRequest {
  /**
   * What is currently registered.
   *
   * Read by `replace` to decide which per-name chains the work must queue behind — both, when the name
   * itself moved. The replacement path does not remove its entry: the abort below does that, through
   * the listener the previous registration attached.
   */
  readonly previous: ToolDeclaration;
  /** Aborting this withdraws the registration being replaced. */
  readonly previousController: AbortController;
}

/** What a refresh names: which registration, and what to write onto its entry. */
export interface RefreshRequest {
  readonly name: string;
  /**
   * The controller of the registration this refresh belongs to.
   *
   * Both the withdrawal check and the identity check. A refresh is only ever applied to the entry that
   * THIS controller registered — so a refresh queued before a rename, arriving after it, finds the
   * name held by a different registration and does nothing.
   */
  readonly controller: AbortController;
  readonly permissions: DeclaredPermissions | undefined;
}

export interface RegistrationRequest {
  /** What the registry is given, including the handler any script in the page may invoke. */
  readonly declaration: ToolDeclaration;
  /** What the runtime invokes directly for an agent's call, held in the ownership record. */
  readonly handler: ToolHandler;
  /** Aborting it withdraws the registration. Owned by the declaring effect, one per registration. */
  readonly controller: AbortController;
  /**
   * Aborts when the tool stops being DECLARED — the declaring component unmounted.
   *
   * One per mount rather than one per registration, and carried unchanged through every replacement.
   * That is the distinction it exists for: `controller` is aborted by a descriptor change too, and a
   * call already running must survive one (docs/design.md#cancellation, and `OwnershipEntry.lifetime`).
   */
  readonly lifetime?: AbortSignal;
  /**
   * What the tool promises to return, when it declared it. Compiled here and held on the entry; the
   * registry's descriptor cannot carry it.
   */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * What the application declared about reaching the tool. Held on the entry, never in the registry.
   *
   * Carried on a registration as well as by `refresh`, so a tool declared unavailable from its very
   * first render is unavailable from the moment it exists — rather than available for one turn until a
   * refresh caught up.
   */
  readonly permissions?: DeclaredPermissions;
  /**
   * Receives the compiled validators once they exist, so the registry-facing callback can close over
   * the SAME objects the bridged path uses.
   *
   * A callback rather than a return value because the descriptor must be built before this gateway is
   * reached — the hook needs it to compare against the last one it declared — and the two routes must
   * enforce one contract, not two that happen to agree.
   */
  readonly onCompiled?: (validators: OwnershipEntry['validators']) => void;
}

/** What the tool declared, and what must be compiled before it may be exposed. */
interface DeclaredSchemas {
  readonly input?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
}

/**
 * Compiles a tool's declared schemas, or refuses the declaration.
 *
 * **This runs before the tool is exposed, and that ordering is the whole design.** A schema compiled
 * at invocation would refuse a correct agent call for an authoring mistake made hours earlier; here it
 * refuses the author, at the moment they can fix it.
 *
 * A tool that declares no schema compiles nothing and needs no validator — validation is not
 * applicable to it, rather than skipped for it.
 */
async function compileSchemas(
  name: string,
  declared: DeclaredSchemas,
  validator: SchemaValidator | undefined,
): Promise<OwnershipEntry['validators']> {
  if (declared.input === undefined && declared.output === undefined) return undefined;

  if (validator === undefined) {
    // Refused, not registered-and-unchecked. Advertising a contract nothing enforces would make the
    // schema documentation again, which is the state this feature exists to end — and "we ran it
    // unvalidated but told you" is observability of an absence rather than the validation that was
    // asked for.
    throw new RuntimeError(
      RUNTIME_FAILURE.validatorMissing,
      `the tool "${name}" declares a schema and no validator is installed, so it was not registered. ` +
        'Import createAjvValidator from "agent-mcp-react/validation" and pass it to AgentMcpProvider ' +
        'as validation={{ validator }}.',
      name,
    );
  }

  const compiled: { input?: CompiledSchema; output?: CompiledSchema } = {};
  for (const [which, schema] of [
    ['input', declared.input],
    ['output', declared.output],
  ] as const) {
    if (schema === undefined) continue;
    try {
      // Awaited, because `compile` may return a promise and an unawaited one stored here would be an
      // object with no `validate` — which `check()` would report as `unusable` on every call. A
      // validator that works would look broken, forever, for one missing keyword.
      compiled[which] = await validator.compile(schema);
    } catch (cause) {
      throw new RuntimeError(
        RUNTIME_FAILURE.schemaNotCompilable,
        `the tool "${name}" declares an ${which} schema that could not be compiled: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        name,
      );
    }
  }
  return compiled;
}

/** What a queued task is waiting to learn from the provider. */
type Availability =
  | {
      readonly open: true;
      readonly ownership: OwnershipRecord;
      /** What the application installed, or nothing. A schema-bearing tool is refused without it. */
      readonly validator: SchemaValidator | undefined;
    }
  | { readonly open: false };

/** The prefixes an application may not declare under, named once for the message below. */
const RESERVED_PREFIX_LIST = Object.values(RESERVED_PREFIX).join(', ');

/**
 * Classifies a declared name against the reserved prefixes, or returns nothing.
 *
 * **Invariant: this runs SYNCHRONOUSLY and FIRST**. Not after the provider is awaited, not
 * after a schema compiles, and not after the registry has classified the name as duplicate or foreign
 * — all three of which are downstream of an `await` and one of which is downstream of the platform.
 * Reordered, an author who renamed into a reserved name and changed a schema in the same render is
 * handed a validator error for a problem they do not have, while the problem they do have goes
 * unnamed. Synchronous also means it needs nothing to be ready: a reserved name is reserved whether or
 * not a provider is open to register into, so the author hears about it either way.
 *
 * **Why the refusal is here rather than at invocation, where every other gate in this feature lives.**
 * By the time a call arrives the name is already TAKEN, in a registry shared with every script on the
 * page. There is nothing left to refuse. A reserved name is refused at declaration or not at all.
 *
 * **A PREFIX, never a substring.** `domain.set_filters` is an application's to declare and always was;
 * that guarantee is `reservedPrefixOf`'s and this function adds nothing to it.
 *
 * Built-in tools legitimately carry these prefixes. They never come through here — they are supplied
 * to the runtime as a table and are never placed in the document's shared registry in any
 * configuration — Levels 2 and 3 never enter a registry every page script can reach — which is
 * precisely why this check can be unconditional.
 */
function reservedNameRefusal(name: string): WebMcpBoundaryError | undefined {
  const prefix = reservedPrefixOf(name);
  if (prefix === undefined) return undefined;
  // A registration refusal rather than a runtime failure, and the class is what decides the channel.
  // This is reported the way a duplicate name is — development throws to the author,
  // production reports to the operator's destination and leaves the page standing. The provider routes
  // by class: a boundary error reaches that destination, and anything else falls through to the loud
  // channel, which in production means a white screen over a tool name.
  return new WebMcpBoundaryError(
    REGISTRATION_REFUSED.nameReserved,
    `the tool "${name}" uses "${prefix}", a prefix reserved for this library's own built-in tools, ` +
      `so it was not registered. The reserved prefixes are: ${RESERVED_PREFIX_LIST}. ` +
      'Declare it under a namespace of your own — a prefix is not a substring, so a name like ' +
      '"domain.set_filters" was never reserved and needs no change.',
    { subject: name },
  );
}

/**
 * Creates a gateway. Registers nothing, waits on nothing, and touches no registry.
 *
 * Construction is free of effect so the provider can allocate one during a render that may never
 * commit — the same reason `createMcpRuntime` is safe to call there.
 */
export function createRegistrationGateway(
  onChurn?: (name: string, cycles: number) => void,
): RegistrationGateway {
  /** One promise chain per tool name. Per NAME, because the race being fixed is a race over a name. */
  const chains = new Map<string, Promise<unknown>>();

  /**
   * Cycles performed per live registration, and whether its churn has already been reported.
   *
   * Keyed by the controller, so it describes a REGISTRATION rather than a name: a tool that unmounts
   * and mounts again starts over, because that is a different registration with a different story.
   * A `WeakMap` so an ended registration takes its counter with it.
   */
  const cycles = new WeakMap<AbortController, { count: number; reported: boolean }>();

  let current: Availability | undefined;
  const waiting: Array<(availability: Availability) => void> = [];

  /**
   * Which provider lifetime queued work belongs to. Incremented by every `close`.
   *
   * A task is enqueued in one turn and starts running in a later one, so "is the gateway open?" is not
   * enough to decide whether it should still run: a task queued for a provider that has since torn
   * down would otherwise wait for the NEXT provider's `open` — and if none comes, wait forever. That
   * is a promise nobody settles, retained by the hook that created it, for every route that mounted
   * and left quickly.
   */
  let epoch = 0;

  function availability(): Promise<Availability> {
    if (current !== undefined) return Promise.resolve(current);
    return new Promise((resolve) => {
      waiting.push(resolve);
    });
  }

  async function perform(request: RegistrationRequest, queuedAt: number): Promise<void> {
    const { declaration, handler, controller, outputSchema, onCompiled, lifetime, permissions } =
      request;
    const { name } = declaration;

    // Two questions, asked before anything is attempted: is this registration still wanted, and is the
    // provider it was queued for still here?
    //
    // **Only the second is load-bearing, and that was measured rather than assumed.** Deleting the
    // abort check leaves every case green, because a controller that aborts before or during the
    // platform call produces a refusal the boundary classifies as `registrationWithdrawn`, which is
    // swallowed below — so correctness belongs to that classification, not to this line. It is kept as
    // what it actually is: an early return that avoids a pointless round trip through the registry on
    // the common path, which strict mode takes on every mount in development.
    //
    // The epoch check IS the mechanism. Without it, a task queued for a provider that tore down before
    // it opened waits for the NEXT provider's `open` — and if none comes, waits forever, holding a
    // promise nobody settles for every route that mounted and left quickly.
    if (controller.signal.aborted) return;
    if (queuedAt !== epoch) return;

    const available = await availability();
    if (!available.open) return;

    const { ownership, validator } = available;

    // **Compiled BEFORE the registry is touched.** A tool whose schema cannot be compiled, or that
    // declares one with no validator installed, must not exist at all — not exist-and-be-unchecked.
    // Doing this after `register()` would leave a window in which the tool is callable by any script
    // on the page with nothing enforcing the contract it advertises.
    const validators = await compileSchemas(
      name,
      {
        ...(declaration.inputSchema === undefined ? {} : { input: declaration.inputSchema }),
        ...(outputSchema === undefined ? {} : { output: outputSchema }),
      },
      validator,
    );
    if (controller.signal.aborted || queuedAt !== epoch) return;
    onCompiled?.(validators);

    try {
      await register(declaration, controller.signal, ownership);
    } catch (cause) {
      // The race path. The check above closes the common window; a signal can still abort between it
      // and the platform call, and the boundary now says so truthfully instead of naming a foreign
      // script that does not exist. Swallowed HERE and nowhere else: this is the one refusal that is
      // not a failure, and every other one is the author's to see.
      if (isWithdrawal(cause)) return;
      throw cause;
    }

    // The entry exists if and only if the registration happened. An entry for a registration that did
    // not happen is a divergence this library manufactured itself, and the runtime would correctly
    // report it as `MCP_REGISTRY_OWNERSHIP_DIVERGED` — training an operator to ignore the alarm that
    // exists to catch a real fault.
    const entry: OwnershipEntry = {
      controller,
      handler,
      declaration,
      ...(lifetime === undefined ? {} : { lifetime }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(validators === undefined ? {} : { validators }),
      ...(permissions === undefined ? {} : { permissions }),
    };
    ownership.add(name, entry);

    // Invariant: **one abort both withdraws the registration and clears the entry.** The registry has
    // no unregister operation, so aborting the signal is the whole withdrawal — and hanging the record
    // removal off that same event is what makes the two structurally unable to drift. A cleanup
    // function doing both would be two statements that a later edit can separate.
    if (controller.signal.aborted) {
      // Aborted while the registration was in flight: the platform has already withdrawn it, so the
      // listener below would never fire and the entry would outlive the tool it describes.
      ownership.remove(name);
      return;
    }
    controller.signal.addEventListener('abort', () => ownership.remove(name), { once: true });
  }

  /**
   * Performs a descriptor change for one name, as one change the registry reports once.
   *
   * The sequencing lives in the boundary, because the coalescing it depends on is the platform's. What
   * belongs here is the ORDER: the replacement runs on the same per-name chain as the registration it
   * replaces, so a change queued while the original is still in flight cannot overtake it and register
   * a name that is about to be taken.
   */
  /**
   * Reports a registration that has cycled implausibly often, **once**.
   *
   * The library performs every change the application declared — it cannot tell a change an author
   * meant from one they did not, and suppressing either would be worse than the churn. What it can do
   * is make the cost visible, so an author learns it from their own telemetry rather than from an agent
   * behaving oddly.
   *
   * Once per registration, never per cycle: an alarm that fires on every cycle is the storm it is
   * reporting, arriving in the destination an operator relies on for registry integrity.
   */
  function countCycle(
    previousController: AbortController,
    controller: AbortController,
    name: string,
  ): void {
    const carried = cycles.get(previousController) ?? { count: 0, reported: false };
    const next = { count: carried.count + 1, reported: carried.reported };
    cycles.set(controller, next);

    if (next.reported || next.count < IMPLAUSIBLE_CYCLE_COUNT) return;
    next.reported = true;
    onChurn?.(name, next.count);
  }

  async function performReplacement(request: ReplacementRequest): Promise<void> {
    const {
      declaration,
      handler,
      controller,
      previousController,
      outputSchema,
      onCompiled,
      lifetime,
      permissions,
    } = request;

    /**
     * Gives up on this replacement, taking the registration it was replacing with it.
     *
     * **Aborting the previous controller is the whole point, and its absence was a leak.** A
     * replacement is asynchronous, and the declaring component can unmount inside that window. When it
     * does, the hook's cleanup aborts the controller for the registration being CREATED — the one
     * being REPLACED has a different controller, and only `replaceRegistration` ever aborts it. Every
     * early return below happens BEFORE that call, so without this the previous registration stayed in
     * the document's registry for the life of the page.
     *
     * That is not cosmetic. The registry is per-document, so the name stays taken: the next mount of
     * the same component collides with a tool nobody can withdraw, and an agent can call a handler
     * belonging to a tree that no longer exists. A tool is gone at unmount, with nothing left behind.
     *
     * Aborting twice is harmless, which is what makes this safe to call from every path.
     */
    const abandon = (): void => {
      previousController.abort();
    };

    if (controller.signal.aborted) return abandon();
    if (queuedEpochOf(request) !== epoch) return abandon();

    const available = await availability();
    // The gateway closed: the provider tore down. The page is going away and so is this tool.
    if (!available.open) return abandon();
    if (controller.signal.aborted) return abandon();

    const { ownership, validator } = available;

    // **Compiled before anything is aborted, and when it fails the tool is WITHDRAWN.**
    //
    // Two earlier versions of this comment overclaimed and both are worth recording, because the thing
    // being described is genuinely hard to hold in one's head.
    //
    // The first said a failed compile leaves the tool "working under the contract it already had".
    // False: it keeps the old SCHEMA and runs the NEW handler, because the hook's handler ref moved in
    // the layout effect that this passive effect follows. Hence the withdrawal.
    //
    // The second implied that compiling first makes the change ATOMIC. It does not, and cannot. The
    // handler ref is current from the layout effect, while this work is asynchronous — so for the
    // whole interval between them the registry advertises the OLD descriptor and the handler behind it
    // is the NEW one. **That window is inherent and predates schemas**: it is what "the handler is
    // always current" costs, and it is chosen deliberately so a rerender never touches the
    // registry.
    //
    // What this feature settles is which contract is enforced in that window, and the answer is the
    // ADVERTISED one. An agent chose its arguments from the schema it was given, so refusing them
    // against a schema it has never seen would be refusing a correct call. The residual — a new
    // handler receiving arguments valid for the contract still on offer — is the application's own
    // transition, and the library's job is to keep the window short and to never lie about which
    // contract is in force.
    let validators: OwnershipEntry['validators'];
    try {
      validators = await compileSchemas(
        declaration.name,
        {
          ...(declaration.inputSchema === undefined ? {} : { input: declaration.inputSchema }),
          ...(outputSchema === undefined ? {} : { output: outputSchema }),
        },
        validator,
      );
    } catch (cause) {
      // Withdrawn through the same abort that withdraws it in every other path, so the registry and
      // the ownership record cannot drift apart here either.
      abandon();
      throw cause;
    }
    if (controller.signal.aborted) return abandon();
    onCompiled?.(validators);

    try {
      await replaceRegistration(previousController, declaration, controller.signal, ownership);
    } catch (cause) {
      if (isWithdrawal(cause)) return;
      throw cause;
    }

    // The previous entry is NOT removed here, and that absence is deliberate rather than an omission.
    // `replaceRegistration` aborted the previous controller above, and the abort listener attached when
    // that registration succeeded already removed its entry — synchronously, before this line runs.
    // One abort, both effects, exactly as the mounting path arranges it.
    //
    // An explicit removal here was written first and then deleted: the break-it run found that
    // removing it changed nothing, because it was dead. A line that looks like bookkeeping and is
    // actually unreachable is worse than no line — it is read as the thing that maintains the record.
    const entry: OwnershipEntry = {
      controller,
      handler,
      declaration,
      ...(lifetime === undefined ? {} : { lifetime }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(validators === undefined ? {} : { validators }),
      ...(permissions === undefined ? {} : { permissions }),
    };
    ownership.add(declaration.name, entry);
    countCycle(previousController, controller, declaration.name);

    if (controller.signal.aborted) {
      ownership.remove(declaration.name);
      return;
    }
    controller.signal.addEventListener('abort', () => ownership.remove(declaration.name), {
      once: true,
    });
  }

  /**
   * Writes entry-only fields onto an existing registration. Touches no registry.
   *
   * Three checks before it writes. They name three different ways a refresh can lose its race, and
   * **they overlap — which was measured rather than assumed, and is recorded here because the
   * alternative is three lines a reader takes for three independent guarantees:**
   *
   *   - **withdrawn** — the registration this belongs to is over.
   *   - **epoch** — the provider it was queued for has torn down, so its record is not the one being
   *     served from. Without it a task also waits for the NEXT provider's `open`, and if none comes it
   *     waits forever.
   *   - **identity** — the name is held by a DIFFERENT registration now. The rename case: queued for
   *     `panel.a`, the component renamed to `panel.b`, and writing here would put an entry under a
   *     name the registry no longer holds — the state the runtime reports as
   *     `MCP_REGISTRY_OWNERSHIP_DIVERGED`, an alarm about a tool nobody touched.
   *
   * **Two of the three are independently load-bearing**, and a first reading of the break-it run said
   * otherwise — because the cases were too weak, not because the guards were redundant:
   *
   *   - **identity** is reached by a registration that FAILED. Its controller is still live, because
   *     nothing aborted it; its component rerenders with a permission; and without this comparison
   *     that permission lands on the entry belonging to whoever actually holds the name. A tool that
   *     was never registered closes a tool that was.
   *   - **epoch** is reached by a provider that closes and never reopens. Without it the task reaches
   *     `availability()` after `close()` released its waiters, so it waits forever — holding the name's
   *     promise chain, and its own promise, for the life of the page.
   *   - **withdrawn** is an early return rather than a mechanism: an abort removes the entry
   *     synchronously, so the identity check answers those cases too. It is kept for the reason
   *     `perform` keeps its own — it avoids pointless work on the path strict mode takes every mount —
   *     and it is labelled as that rather than as a guarantee.
   */
  async function performRefresh(request: RefreshRequest, queuedAt: number): Promise<void> {
    const { name, controller, permissions } = request;

    if (controller.signal.aborted) return;
    if (queuedAt !== epoch) return;

    const available = await availability();
    if (!available.open) return;
    if (controller.signal.aborted || queuedAt !== epoch) return;

    const { ownership } = available;
    const entry = ownership.entryFor(name);
    // Not "is the name held" but "is it held by THIS registration". A rename, an unmount-and-remount,
    // or a replacement all leave a name held by a controller that is not ours, and none of them wants
    // a stale permission written over the top of it.
    if (entry === undefined || entry.controller !== controller) return;

    // Re-added rather than mutated: the record announces on `add`, and that announcement is the entire
    // notification path for this change. A mutation in place would update the entry and tell nobody,
    // so an agent would keep a listing describing a tool the application had since closed — the silent
    // staleness this library must never produce, and the reason `available` is a declared value rather
    // than a predicate.
    // The old value is dropped rather than spread over, because a tool that STOPS declaring
    // permissions must become unconditionally available again — not stay closed under a value nobody
    // is declaring any more. Spreading `undefined` on top would not remove the key, and under
    // `exactOptionalPropertyTypes` a present-and-undefined optional is not the same as an absent one.
    const { permissions: _replaced, ...carried } = entry;
    ownership.add(name, {
      ...carried,
      ...(permissions === undefined ? {} : { permissions }),
    });
  }

  /** Epoch captured at enqueue time, threaded through the request rather than recomputed. */
  const enqueuedEpochs = new WeakMap<object, number>();
  function queuedEpochOf(request: object): number {
    return enqueuedEpochs.get(request) ?? epoch;
  }

  return {
    replace(request) {
      const { name } = request.declaration;
      // **The rename-into-a-reserved-name case, and the abort is the whole of it.**
      //
      // Refusing without it re-opens a leak this once shipped, arriving by a new route: the hook has
      // already moved `controllerRef` to the controller for the registration being CREATED, so
      // nothing reachable will ever abort the previous one. The old tool then stays in the
      // document's registry for the life of the page — its name taken, its entry in the ownership
      // record, its handler belonging to a render that no longer declares it — and the next mount of
      // the same component collides with a tool nobody can withdraw.
      //
      // Aborting is the entire withdrawal (the registry has no unregister operation) and it clears the
      // ownership entry through the listener that registration attached, so the two cannot drift. It
      // is idempotent, which is what makes it safe on the path where the previous registration was
      // itself refused and never happened.
      const reserved = reservedNameRefusal(name);
      if (reserved !== undefined) {
        request.previousController.abort();
        return Promise.reject(reserved);
      }

      enqueuedEpochs.set(request, epoch);
      // Chained on BOTH names when the name moved, so neither the withdrawal nor the registration can
      // race work already queued for either.
      const previousChain = chains.get(request.previous.name) ?? Promise.resolve();
      const nextChain = chains.get(name) ?? Promise.resolve();
      const attempt = Promise.all([previousChain, nextChain]).then(() =>
        performReplacement(request),
      );
      const settled = attempt.catch(() => undefined);
      chains.set(name, settled);
      if (request.previous.name !== name) chains.set(request.previous.name, settled);
      return attempt;
    },
    refresh(request) {
      const queuedAt = epoch;
      // The SAME per-name chain as a registration or a replacement. A refresh that overtook the
      // registration it describes would write onto an entry that does not exist yet and then be
      // overwritten by the registration's own; one that overtook a replacement would write a stale
      // permission onto the new descriptor.
      const previous = chains.get(request.name) ?? Promise.resolve();
      const attempt = previous.then(() => performRefresh(request, queuedAt));
      chains.set(
        request.name,
        attempt.catch(() => undefined),
      );
      return attempt;
    },
    enqueue(request) {
      const { name } = request.declaration;
      // First, before the name is put on a chain, before the provider is awaited and before a schema
      // is compiled. Rejected rather than thrown: the hook calls this from an effect and routes the
      // rejection to the build's reporting channel, so a synchronous throw would escape the effect
      // and take a production page down over a name.
      const reserved = reservedNameRefusal(name);
      if (reserved !== undefined) return Promise.reject(reserved);

      const queuedAt = epoch;
      // Chained so tasks for one name observe each other's outcome in order. A failure must not break
      // the chain for later tasks on the same name, so the link the NEXT task waits on is settled
      // either way while the caller still receives the rejection.
      const previous = chains.get(name) ?? Promise.resolve();
      const attempt = previous.then(() => perform(request, queuedAt));
      chains.set(
        name,
        attempt.catch(() => undefined),
      );
      return attempt;
    },
    open(ownership, validator) {
      current = { open: true, ownership, validator };
      for (const resolve of waiting.splice(0)) resolve(current);
    },
    close() {
      // Everything already waiting is released rather than left pending; everything queued for this
      // lifetime is skipped by the epoch check. Both are needed: a task can be on either side of its
      // first `await` when the provider goes away.
      epoch += 1;
      current = undefined;
      for (const resolve of waiting.splice(0)) resolve({ open: false });
    },
  };
}

/** Whether a refusal means "the registration was withdrawn before it happened" — the one non-failure. */
function isWithdrawal(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === REGISTRATION_REFUSED.registrationWithdrawn
  );
}
