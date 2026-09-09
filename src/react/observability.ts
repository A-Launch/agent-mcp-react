// The public shape of an observability event, assembled where both failure vocabularies are visible.
//
// The record itself is built in `src/runtime/`, which may not name a React code: the dependency arrow
// runs `react/ ──▶ runtime/`, and inverting it — even for a type — is what would make the runtime
// untestable without a renderer. So the runtime declares the record generic in the route's code, and
// this file supplies the one this route actually uses. That is the same move `UnexpectedStateReport`
// already makes: the union lives where every member is in scope.

import type { CALL_PHASE, ObservedCall, ObservedFailure } from '../runtime/index.ts';
import type { ReactRefusedCode } from './errors.ts';

/**
 * Why a call ended, with the code typed precisely for both routes.
 *
 * Three sources, not one. The bridge refuses with the runtime's vocabulary; the page's registry route
 * refuses with this module's; and an application handler that throws carries no code of ours at all,
 * which is reported as uncoded rather than given a borrowed one — a borrowed code would tell an
 * operator a CHECK refused the call when the application simply failed.
 */
export type McpCallFailure = ObservedFailure<ReactRefusedCode>;

/** One observed call, at whichever point in its life this event describes. */
export type McpObservedCall = ObservedCall<ReactRefusedCode>;

/** A call beginning, on either route. */
export type McpToolCallEvent = McpObservedCall & {
  readonly phase: typeof CALL_PHASE.start;
};

/** A call that settled with a result. */
export type McpToolResultEvent = McpObservedCall & {
  readonly phase: typeof CALL_PHASE.result;
};

/** A call that settled with a refusal, a throw or a cancellation. */
export type McpToolErrorEvent = McpObservedCall & {
  readonly phase: typeof CALL_PHASE.error;
};

/**
 * A change to the document's tool registry.
 *
 * **`agentVisibleMoved` is the field that carries the meaning.** The registry is shared with every
 * script on the page, so a change to it is not the same question as a change to what the agent can
 * see: a widget registering its own tool moves the registry and moves nothing the agent lists.
 *
 * The flag is DERIVED from the same determination that drives the agent's change notification, never
 * recomputed here — one owner per truth. It is reported per reconciliation
 * rather than per raw registry event, because a registration updates the registry before the
 * ownership record and a single raw event therefore has no unambiguous answer.
 */
export interface McpRegistryChangeEvent {
  readonly agentVisibleMoved: boolean;
  /** The agent-visible tool names at this reconciliation. Names the application itself declared. */
  readonly tools: readonly string[];
}

/**
 * A declaration refused before it ever became a tool.
 *
 * It has no `callId` because there is no call: the refusal happens at DECLARATION, since by the time
 * a call arrives the name is already taken in a registry shared with every script on the page and
 * there is nothing left to refuse. Without an event here an author sees a tool silently missing with
 * nothing to explain it.
 *
 * **Every cause arrives here, not only a reserved prefix.** A missing validator, a duplicate name, a
 * foreign name and a reserved prefix all end a declaration before it becomes a tool, and each used to
 * reach a different destination — one of them by throwing during render, which unmounted the
 * application. They are one kind of event and they now have one channel; `code` says which.
 */
export interface McpRegistrationEvent {
  readonly name: string;
  /**
   * The reserved prefix that refused it, when a prefix is what refused it.
   *
   * **Optional, because this event now carries every declaration this library refused** — a missing
   * validator, a duplicate name, a foreign name — and only one of those is about a prefix. It was
   * required when the reserved prefix was the single case reported here, and a required field that is
   * meaningless for three of four causes is a field a consumer has to ignore.
   */
  readonly prefix?: string;
  readonly code: ReactRefusedCode | string;
}
