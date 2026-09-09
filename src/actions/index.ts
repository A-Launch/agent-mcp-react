import type { McpToolDefinition } from '../react/use-mcp-tool.ts';
import { RESERVED_PREFIX, reservedPrefixOf } from '../runtime/index.ts';
import { REGISTRATION_REFUSED, WebMcpBoundaryError } from '../webmcp/index.ts';
import { declare, isDeclared, type PendingDeclaration, redeclare, undeclare } from './queue.ts';

// Declaring a tool from code that is not a component: an application shell, a singleton service, a
// router, a store subscription (docs/tools-outside-react.md).
//
// **This is a REGISTRATION API. It is not a runtime, and the `createAgentMcpRuntime()` the original
// design sketched does not ship.** That is a correction to the design rather than an interpretation
// of it, and the reasoning is short: a runtime an application constructs is a second MCP server on one
// page. `provider.tsx` already guards against that and names what it produces — *"two sockets from
// one page, which presents as duplicate tool calls rather than as a connection error"* — and the
// design requires that one provider claims a document (docs/design.md#the-provider). That rule
// wins, so the sketch is what gives.
//
// There is therefore no `connect`, no `shutdown`, no server and no socket here, and the name is not
// reused for something that would mean less than it says. What an application gets is a place to
// DECLARE tools; the provider remains the only thing that serves them.
//
// **"Static" describes ownership, never an exemption from the lifecycle**
// (docs/tools-outside-react.md#static-describes-ownership-not-an-exemption). A tool declared here
// registers into the document's tool registry like any other, carries its own abort controller, has an
// entry in the ownership record, passes every gate, and is refused — not merely absent — after it is
// removed. The only thing that differs is who owns it: the application shell rather than a screen.

export type { McpToolDefinition } from '../react/use-mcp-tool.ts';

/**
 * A live declaration's handle.
 *
 * Deliberately no `enable()` and no `disable()`, exactly as the design requires: availability is
 * per-tool policy declared as a value and refused at invocation, never a second switch that could
 * disagree with it.
 */
export interface McpToolRegistration {
  /**
   * Replaces the declaration.
   *
   * One withdraw-and-register cycle for a genuine descriptor change, and **nothing at all** when the
   * descriptor is unchanged (docs/design.md#stable-handlers). Neither of those is decided here: the
   * comparison belongs to the registration path, which already owns "did the application change what
   * this tool is" and already had to answer it for a rerender — one owner per truth, and that path is
   * the owner.
   */
  update(next: Partial<McpToolDefinition>): void;
  /**
   * Withdraws permanently. Idempotent.
   *
   * Aborts the registration — the registry offers no other unregistration mechanism — and deletes the
   * declaration, so a later provider does not bring it back. A call afterwards is REFUSED rather than
   * quietly missing, because absence from a listing is not an access control.
   */
  remove(): void;
  /**
   * Whether a provider is currently serving this declaration.
   *
   * **Reported, never awaited, and never thrown about.** A declaration made at import time normally
   * has no provider yet; that is the case this subpath exists for rather than a fault. An application that
   * cares can read this, and one that does not is not punished for declaring early. What would be
   * wrong is silence in the other direction — a tool that never registers because no provider ever
   * mounts is visible here rather than being a mystery: an unexpected state is reported, never hidden.
   */
  readonly registered: boolean;
}

/**
 * Declares one tool owned by the application rather than by a component.
 *
 * Safe to call at module scope, before React mounts and before any provider exists: the declaration is
 * held and registered by the next provider that mounts. It survives that provider unmounting and is
 * re-registered by the one after it — its owner is the application shell, which did not unmount.
 */
export function registerMcpTool(definition: McpToolDefinition): McpToolRegistration {
  // **Synchronously, and before anything is queued** — the same position the hook's check occupies and
  // for the same reason. By the time a call arrives the name is already taken in a registry shared
  // with every script on the page, so there is nothing left to refuse: a reserved name is refused at
  // declaration or not at all.
  //
  // It reuses `reservedPrefixOf` rather than testing the prefixes here. A second registration route
  // that implemented its own check is a second chance to implement it differently, and the difference
  // would be an application reaching a Level 2 namespace by not using a hook.
  refuseReservedName(definition.name);

  const entry = declare(definition);
  return handleFor(entry);
}

/**
 * The reserved-prefix refusal, raised as the SAME error the hook's path raises.
 *
 * `REGISTRATION_REFUSED.nameReserved`, in a `WebMcpBoundaryError`, and not a new member of anything.
 * The question it answers — "why was this name not registered" — already has one dictionary, and a
 * caller that branched on a second code for the identical condition would be handling one truth in two
 * places, where one owner per truth is the rule. It also means an application that already catches
 * this from a hook needs no new branch for the imperative path.
 */
function refuseReservedName(name: string): void {
  const prefix = reservedPrefixOf(name);
  if (prefix === undefined) return;
  throw new WebMcpBoundaryError(
    REGISTRATION_REFUSED.nameReserved,
    `the tool "${name}" uses "${prefix}", a prefix reserved for this library's own built-in tools, ` +
      `so it was not declared. The reserved prefixes are: ${Object.values(RESERVED_PREFIX).join(', ')}. ` +
      'Declare it under a namespace of your own — a prefix is not a substring, so a name like ' +
      '"domain.set_filters" was never reserved and needs no change.',
    { subject: name },
  );
}

/** Builds the handle. Separate so the queue holds no reference to a caller-facing object. */
function handleFor(entry: PendingDeclaration): McpToolRegistration {
  return {
    update(next) {
      // **Liveness first, and a review found why the order matters.** `remove()` is permanent, so
      // every later call on this handle must be a no-op — including one that would otherwise throw.
      // With the reserved check first, `update({ name: 'dom.click' })` on a REMOVED handle raised a
      // refusal for a registration that no longer exists, which is a refusal an application cannot
      // act on and did not earn.
      if (!isDeclared(entry)) return;
      // Merged rather than replaced, because `update` takes a `Partial` by contract — an application
      // updating a description should not have to restate its handler and schema.
      const merged: McpToolDefinition = { ...entry.definition, ...next };
      // A rename is a different tool under the reserved rules, so the new name is checked exactly as
      // the first one was. Skipping it here would make `update` the way past the check.
      refuseReservedName(merged.name);
      redeclare(entry, merged);
    },
    remove() {
      undeclare(entry);
    },
    get registered() {
      return entry.registered;
    },
  };
}
