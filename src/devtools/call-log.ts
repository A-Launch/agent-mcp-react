// The retained call history. INTERNAL: not re-exported from `index.ts`, which is the public
// `./devtools` subpath.
//
// **That placement is the whole "no configuration knob" claim.** `createCallLog` takes a limit so its
// own cases can drive eviction without queueing twenty calls — a test seam. Exported from the subpath
// it would have been a public knob, which is what a review found: an application could have set the
// inspector's memory bound, and a bound an operator can set wrong is worse than one they cannot.

/**
 * How many completed calls the inspector keeps.
 *
 * **Reconciled CALLS, not events**, so a start and its terminal share one slot and a start can never be
 * evicted while its terminal is retained.
 *
 * Twenty, and there is no configuration knob. It needs to cover a burst — an agent planning a task
 * issues a handful of calls in sequence — and the diagnostic question is almost always "what happened
 * just before this one". The records are metadata-only, so twenty is a few kilobytes. A knob here would
 * be a memory bound an operator can set wrong, and Proportionate Engineering forbids one ahead of a
 * demonstrated need.
 */
export const RETAINED_CALLS = 20;

/** What the provider's channel publishes. Structural, because this module imports no library types. */
export interface ObservedRecord {
  readonly phase: string;
  readonly callId: number;
  readonly name: string;
  readonly route: string;
  readonly startedAt: number;
  readonly settledAt?: number;
  readonly gates: readonly { readonly step: string; readonly outcome: string }[];
  readonly resolution?: string;
  readonly failure?: { readonly vocabulary: string; readonly code?: string };
}

/** One call as the panel shows it: a start reconciled with its terminal. */
export interface InspectedCall {
  readonly callId: number;
  readonly name: string;
  readonly route: string;
  readonly startedAt: number;
  readonly settledAt?: number;
  readonly outcome: 'running' | 'result' | 'error';
  /** The step that refused, when one did. */
  readonly decidedBy?: string;
  /** The steps that never executed. For a page-script call this is most of the chain. */
  readonly notRun: readonly string[];
  readonly resolution?: string;
  readonly failureCode?: string;
}

/**
 * Reconciles a stream of records into completed calls, keeping the most recent `RETAINED_CALLS`.
 *
 * Kept in this module rather than the subpath's entry point: the `limit` parameter is a TEST seam so
 * eviction can be driven without queueing twenty calls, and exported publicly it would have been a
 * configuration knob an application could set — a memory bound an operator can get wrong.
 */
export function createCallLog(limit: number = RETAINED_CALLS): {
  accept(event: ObservedRecord): void;
  calls(): readonly InspectedCall[];
  /** Whether records have been dropped, so a truncated history is never shown as a complete one. */
  truncated(): boolean;
} {
  const byId = new Map<number, InspectedCall>();
  let dropped = false;

  return {
    accept(event) {
      const existing = byId.get(event.callId);
      const refused = event.gates.find((gate) => gate.outcome === 'refused');
      const call: InspectedCall = {
        callId: event.callId,
        name: event.name,
        route: event.route,
        startedAt: event.startedAt,
        ...(event.settledAt === undefined ? {} : { settledAt: event.settledAt }),
        outcome:
          event.phase === 'start' ? 'running' : event.phase === 'result' ? 'result' : 'error',
        ...(refused === undefined ? {} : { decidedBy: refused.step }),
        notRun: event.gates.filter((gate) => gate.outcome === 'notRun').map((gate) => gate.step),
        ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
        ...(event.failure?.code === undefined ? {} : { failureCode: event.failure.code }),
      };
      // One slot per CALL: a terminal replaces its own start rather than taking a second slot. Counting
      // events instead would halve the useful depth and could evict a start while keeping its terminal,
      // leaving a record nothing can be reconciled against.
      //
      // **A terminal whose start is gone is DROPPED, not reinserted.** A review found the gap: with a
      // long-running call and a busy page, the start can be evicted before the terminal arrives — and
      // accepting it then would insert what looks like a complete record while the panel has no idea
      // when the call began. Dropping it is the honest answer; the truncation notice already tells a
      // reader that older calls are missing.
      if (existing === undefined && event.phase !== 'start') {
        dropped = true;
        return;
      }
      if (existing !== undefined) byId.delete(event.callId);
      byId.set(event.callId, call);
      while (byId.size > limit) {
        const oldest = byId.keys().next().value as number;
        byId.delete(oldest);
        dropped = true;
      }
    },
    calls() {
      return [...byId.values()];
    },
    truncated() {
      return dropped;
    },
  };
}
