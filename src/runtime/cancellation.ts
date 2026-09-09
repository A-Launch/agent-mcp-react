// Who ended a call, and when — the single owner of that question.
//
// It exists because three separate mistakes are easy to make about cancellation and each one is
// silent:
//
//   1. **Reading a signal's `aborted` after the fact is not attribution.** Both sources can abort, in
//      either order, and sticky state answers "did this ever happen?" rather than "what ended the
//      call?". An agent that cancelled and a component that unmounted a moment later would be reported
//      as the unmount, and an operator would go looking for a route change that had nothing to do with
//      it. So the first cause is LATCHED, by listeners attached at composition time.
//   2. **A handler that ignores its signal can hang a call forever.** Checkpoint-only cancellation
//      never settles a call whose handler never returns — no result, no error, no frame — and the
//      agent waits until its own timeout. So this module also exposes the abort as something an
//      invocation can RACE, which is what makes settlement independent of the handler's cooperation.
//   3. **Composing per registration leaks and misfires.** `AbortSignal.any` holds its sources, and a
//      composed signal reused across calls aborts them all the first time any one request is
//      cancelled. One composition per invocation, disposed when the call ends.

/**
 * What ended a call.
 *
 * A closed set, because the two carry opposite diagnoses and a caller must never reach one by reading
 * a message. Declared once, here, with the type derived from it — never respelt as a literal.
 */
export const CANCELLED_BY = {
  /**
   * The agent cancelled, or the channel carrying the request ended.
   *
   * Nothing is wrong. Measured: the protocol layer discards the response to a request the client
   * cancelled, so this outcome is for the page's own record rather than for the agent.
   */
  agent: 'agent',
  /**
   * The tool stopped being declared while the call was running.
   *
   * The agent is **still waiting**, so this outcome is a frame that genuinely gets sent — and failing
   * to send it leaves the agent blocked until its own timeout.
   */
  withdrawal: 'withdrawal',
} as const;

export type CancelledBy = (typeof CANCELLED_BY)[keyof typeof CANCELLED_BY];

/**
 * A monotonic tick, shared by everything that needs to order one call's events against another's.
 *
 * One counter rather than timestamps: two events in the same millisecond are indistinguishable by a
 * clock, and `Date.now()` is not available to every environment this runs in. Overflow is not a
 * concern at one increment per call event.
 */
let clock = 0;
export function sequence(): number {
  clock += 1;
  return clock;
}

/** One invocation's cancellation: the signal a handler holds, what ended it, and how to wait for that. */
export interface Cancellation {
  /**
   * The signal handed to the handler.
   *
   * The protocol layer's per-request signal composed with the tool's declaration lifetime, using the
   * platform's own primitive. Never a controller this library drives on its own judgement: that would
   * not learn the client cancelled, and learning it is the whole point — a cancelled call must
   * never report success (`docs/design.md#cancellation`).
   */
  readonly signal: AbortSignal;
  /** What ended the call, latched at the moment it happened, or nothing while it is still running. */
  by(): CancelledBy | undefined;
  /**
   * When the cancellation was latched, on this module's monotonic sequence, or nothing while the call
   * is still running.
   *
   * Exists so a caller can order the cancellation against its OWN events — in particular against the
   * handler completing. A boolean cannot do that: an abort listener runs synchronously while a promise
   * continuation runs a microtask later, so "is it aborted now?" answers a question about the present
   * rather than about which happened first.
   */
  at(): number | undefined;
  /**
   * Settles when the call is cancelled, and never rejects.
   *
   * Raced against the handler so a call settles whether or not the handler cooperates. It stays
   * pending forever if nothing cancels, which is what makes it safe to race: the losing side of a
   * `Promise.race` is simply never observed.
   */
  readonly cancelled: Promise<void>;
  /** Releases the listeners this composition installed. Idempotent. */
  dispose(): void;
}

/**
 * Composes one invocation's cancellation from the two real sources.
 *
 * Invariant: **first cause wins, and it is recorded when it happens rather than inferred later.** If
 * both sources abort, the one that fired first is the one reported — a second abort changes nothing.
 *
 * `lifetime` is optional because a registrar that is not the React hook may have no declaration
 * lifetime to offer. Its absence means withdrawal cannot reach a running call, which is honest for a
 * caller that never withdraws; it is never a substitute signal that cannot fire.
 */
export function composeCancellation(
  requestSignal: AbortSignal,
  lifetime?: AbortSignal,
): Cancellation {
  const signal =
    lifetime === undefined ? requestSignal : AbortSignal.any([requestSignal, lifetime]);

  let by: CancelledBy | undefined;
  let at: number | undefined;
  let announce: (() => void) | undefined;
  const cancelled = new Promise<void>((resolve) => {
    announce = resolve;
  });

  /** Records the first cause only. A later abort from the other source is a second event, not a verdict. */
  const latch = (cause: CancelledBy) => (): void => {
    if (by !== undefined) return;
    by = cause;
    at = sequence();
    announce?.();
  };

  // Attached before the already-aborted checks below, so the ordering rule is the same whether a
  // source aborted a moment ago or aborts a moment from now.
  const onRequest = latch(CANCELLED_BY.agent);
  const onLifetime = latch(CANCELLED_BY.withdrawal);

  // An already-aborted source is a first cause too, and the request signal is consulted first: if both
  // arrived already aborted there is no ordering to recover, and attributing to the agent is the
  // conservative reading — it does not send an operator looking for a component that unmounted.
  //
  // **That case is reachable, not theoretical**, and the limit is worth naming: the work between a
  // request arriving and this composition existing is asynchronous — name resolution enumerates the
  // registry — so a lifetime can abort during a rename window and the request abort later, with both
  // already set by the time composition runs. Chronology is genuinely lost there. What is NOT lost is
  // the common case, where composition exists before either abort and the order is observed.
  if (requestSignal.aborted) onRequest();
  else requestSignal.addEventListener('abort', onRequest, { once: true });

  if (lifetime !== undefined) {
    if (lifetime.aborted) onLifetime();
    else lifetime.addEventListener('abort', onLifetime, { once: true });
  }

  return {
    signal,
    by: () => by,
    at: () => at,
    cancelled,
    dispose() {
      requestSignal.removeEventListener('abort', onRequest);
      lifetime?.removeEventListener('abort', onLifetime);
    },
  };
}
