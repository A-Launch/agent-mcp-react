import type { McpToolDefinition } from '../react/use-mcp-tool.ts';

// The module-scope declaration queue: what an application declared outside any component's lifetime.
//
// **The split this module exists for, and it is the answer to "what happens when the provider goes
// away": THIS QUEUE HOLDS DECLARATIONS. THE PROVIDER HOLDS REGISTRATIONS.**
//
// A registration belongs to a provider — it has an abort controller the provider owns, an entry in the
// ownership record the provider created, and a place in the document's registry that provider claimed.
// It dies with that provider, and it should.
//
// A DECLARATION belongs to the application shell, which did not unmount. The design says exactly this
// (docs/tools-outside-react.md#static-describes-ownership-not-an-exemption) and it is easy to read as
// a nicety: *"'Static' describes OWNERSHIP, never an exemption from the lifecycle."* Held as two
// different things rather than one, it stops being a rule to remember: a provider unmounting clears
// its registrations and cannot clear these, so a shell-owned tool comes back when the next provider
// mounts without the application doing anything.
//
// What this module owns: the list, and the fact that a caller can add to it before any provider
// exists. It performs no registration, resolves no registry, compiles no schema and holds no
// ownership record — it hands definitions to whoever adopts it and is told when that has happened.
//
// **It is not a runtime, and there is deliberately no way to make it one.** The original design
// sketched `createAgentMcpRuntime()`, which would be a second MCP server on one page — the failure
// `provider.tsx` already guards against and names: two sockets, presenting as duplicate tool calls
// rather than as a connection error. One provider claims a document and is the only thing that
// serves, so what ships is a place to declare tools, never a place to serve them: this queue holds
// declarations, the provider holds registrations, and there is no runtime an application constructs
// (docs/tools-outside-react.md#it-is-a-registration-api-not-a-runtime).

/** One declaration held for as long as the application wants it, across any number of providers. */
export interface PendingDeclaration {
  readonly id: number;
  /** What the application declared. Replaced wholesale by `update`, never mutated. */
  definition: McpToolDefinition;
  /**
   * Aborted only by `remove()`, never by a provider going away.
   *
   * This is the DECLARATION's lifetime, which is what the gateway wants as `lifetime`: a call already
   * running must survive a descriptor change, and for a shell-owned tool it must also survive the
   * provider that happened to be serving it.
   */
  readonly lifetime: AbortController;
  /** True once some provider has registered it. Reported to the caller, never waited on. */
  registered: boolean;
}

/** What a provider supplies when it adopts: how to register one declaration, and how to withdraw it. */
export interface Adopter {
  register(entry: PendingDeclaration): void;
  withdraw(entry: PendingDeclaration): void;
}

let nextId = 1;
const declarations = new Map<number, PendingDeclaration>();
let adopter: Adopter | undefined;

/**
 * Adds one declaration and registers it immediately when a provider is already mounted.
 *
 * Returns the entry so the caller's handle can reach it. Never throws for the absence of a provider:
 * a module-scope call happens at import time, where there is nowhere to put an exception that anyone
 * would catch, and where "no provider yet" is the expected case rather than a fault.
 */
export function declare(definition: McpToolDefinition): PendingDeclaration {
  const entry: PendingDeclaration = {
    id: nextId,
    definition,
    lifetime: new AbortController(),
    registered: false,
  };
  nextId += 1;
  declarations.set(entry.id, entry);
  adopter?.register(entry);
  return entry;
}

/**
 * Withdraws one declaration permanently.
 *
 * Both halves, and both are needed: the registration is withdrawn through the adopter so the registry
 * and the ownership record agree, and the declaration is deleted so the NEXT provider does not bring
 * it back. Deleting without withdrawing would leave a tool nobody can reach declaring; withdrawing
 * without deleting would make `remove()` a temporary measure that a remount undoes.
 */
export function undeclare(entry: PendingDeclaration): void {
  if (!declarations.has(entry.id)) return;
  declarations.delete(entry.id);
  adopter?.withdraw(entry);
  entry.lifetime.abort();
  entry.registered = false;
}

/**
 * Replaces a declaration's definition and asks the current provider to apply it.
 *
 * The comparison that decides whether anything happens lives in the REGISTRATION path, not here — this
 * module has no opinion about what makes two descriptors the same, and forming one would be a second
 * answer to a question `descriptor.ts` already owns — one owner per truth.
 */
export function redeclare(entry: PendingDeclaration, definition: McpToolDefinition): void {
  if (!declarations.has(entry.id)) return;
  entry.definition = definition;
  adopter?.register(entry);
}

/**
 * A provider takes over serving every declaration, present and future.
 *
 * **Re-adoptable, and that is the whole point.** A second provider mounting after a first unmounted
 * gets every declaration that has not been removed — which is what makes a shell-owned tool survive a
 * remount. Strict mode's mount / cleanup / mount reaches this three times for the same reason the
 * gateway's own `open` is re-openable.
 */
export function adopt(next: Adopter): void {
  adopter = next;
  for (const entry of declarations.values()) next.register(entry);
}

/**
 * Whether `who` is still the adopter, so a late teardown cannot speak for a live provider.
 *
 * Exported for the provider's cleanup and for the cases; not part of the public subpath.
 */
export function isAdopter(who: Adopter): boolean {
  return adopter === who;
}

/**
 * The provider is going away.
 *
 * **Declarations are KEPT; their registrations are NOT.** Each served declaration is withdrawn through
 * the adopter that made it, and then forgotten as a registration while surviving as a declaration.
 *
 * **The withdrawal has to happen HERE, and a first version of this got it wrong in a way worth
 * recording.** The comment then said the provider's own teardown already aborted these, "because every
 * registration it made is aborted by the controller it owns" — which is true of a hook's tool, whose
 * controller is created and aborted by the declaring effect, and false of these. Their controllers are
 * created while serving a declaration and are owned by nothing that unmounts. The result was a tool
 * that stayed in the document's registry after its provider was gone: still listed to a page script,
 * absent from the next provider's ownership record, and therefore FOREIGN to it — reachable in the
 * page and refused at the bridge, with nothing to explain the difference.
 */
export function release(who?: Adopter): void {
  // **A teardown speaks only for ITSELF.** Passed an adopter that is no longer the current one, this
  // returns without touching anything — a provider that has already handed over must not clear the
  // one that took over, nor withdraw registrations it does not own.
  //
  // Safe without this today, by an ordering two files have to agree on: the provider adopts only after
  // `claimDocument` succeeds and releases before `releaseDocument`, so no second provider can have
  // adopted while a first is tearing down. That is a real guarantee and a fragile way to hold one —
  // it lives in `provider.tsx`'s statement order, where a later change could reorder it without
  // anything here noticing. The check makes it structural instead: it fixes the mechanism that would
  // produce the error, not one occurrence of it.
  if (who !== undefined && adopter !== who) return;
  const leaving = who ?? adopter;
  adopter = undefined;
  for (const entry of declarations.values()) {
    // **Withdrawn unconditionally, NOT only when `registered` is true**, and the difference is a race
    // rather than a tidiness preference. `registered` is set in a `.then()` after the gateway resolves;
    // this runs synchronously inside the provider's teardown. A registration that has landed in the
    // document but whose continuation has not yet drained would therefore be skipped — left in the
    // registry with nothing owning it, which is the exact leak the note below describes.
    //
    // Asking the adopter to withdraw something it never registered is free: `withdrawDeclared` looks
    // the entry up and returns when there is nothing there, and aborting a controller for a
    // registration still in flight is how this library withdraws an in-flight registration everywhere
    // else. The cheap call is the correct one; the guard was an optimisation over a correctness
    // requirement.
    leaving?.withdraw(entry);
    entry.registered = false;
  }
}

/** Whether this declaration is still live, so a handle can no-op after `remove()`. */
export function isDeclared(entry: PendingDeclaration): boolean {
  return declarations.has(entry.id);
}

/** Every live declaration, for the cases and for nothing else. */
export function declared(): readonly PendingDeclaration[] {
  return [...declarations.values()];
}

/**
 * Empties the queue. **A test seam, and deliberately not exported from the subpath.**
 *
 * Module state outlives a test file, so a case that declared a tool would leak it into the next one —
 * which is the same reason `resetResolutionForTests` exists for the registry. An application has no
 * use for it: `remove()` is how a declaration ends, one at a time and deliberately.
 */
export function resetDeclarationsForTests(): void {
  for (const entry of declarations.values()) entry.lifetime.abort();
  declarations.clear();
  adopter = undefined;
  nextId = 1;
}
