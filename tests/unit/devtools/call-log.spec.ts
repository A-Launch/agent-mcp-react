// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createCallLog, RETAINED_CALLS } from '../../../src/devtools/call-log.ts';

// The retained history, asserted without a DOM.
//
// The bound and the eviction order are the claims here; rendering is not what makes them true. Two of
// these would fail against the obvious implementation — a ring of EVENTS rather than of calls — and
// both failures are silent: a halved useful depth, and a terminal retained after its own start was
// evicted, which is a record nothing can be reconciled against.

function record(callId: number, phase: string, extra: Record<string, unknown> = {}) {
  return {
    phase,
    callId,
    name: `tool.${callId}`,
    route: 'bridge',
    startedAt: 1_000 + callId,
    gates: [
      { step: 'authenticate', outcome: 'passed' },
      { step: 'invoke', outcome: phase === 'error' ? 'refused' : 'passed' },
    ],
    ...extra,
  };
}

describe('reconciling a stream into calls', () => {
  it('gives a call ONE slot, however many records it produced', () => {
    const log = createCallLog(3);
    log.accept(record(1, 'start'));
    log.accept(record(1, 'result', { settledAt: 1_010 }));

    // Counting events would have used two of three slots for one call.
    expect(log.calls()).toHaveLength(1);
    expect(log.calls()[0]?.outcome).toBe('result');
    expect(log.truncated()).toBe(false);
  });

  it('drops the OLDEST call once the bound is reached', () => {
    const log = createCallLog(2);
    for (const id of [1, 2, 3]) {
      log.accept(record(id, 'start'));
      log.accept(record(id, 'result', { settledAt: 2_000 + id }));
    }

    expect(log.calls().map((call) => call.callId)).toEqual([2, 3]);
    expect(log.truncated()).toBe(true);
  });

  it('never evicts a start while keeping its own terminal', () => {
    // The failure a per-EVENT ring produces, and the reason this case exists: with a bound of 2, a
    // start and a terminal for one call plus a start for the next would evict the first call's start
    // and keep its terminal — leaving a record that cannot be reconciled against anything, which a
    // reader cannot tell apart from a lost one.
    const log = createCallLog(2);
    log.accept(record(1, 'start'));
    log.accept(record(2, 'start'));
    log.accept(record(1, 'result', { settledAt: 1_100 }));
    log.accept(record(3, 'start'));

    // **A review found the first version of this case proved nothing** — it asserted the ids were
    // unique and positive, which is true of any implementation including the broken one. What matters
    // is that a retained call is COMPLETE: with a per-event ring, call 1's start would have been
    // evicted while its terminal stayed, leaving an entry that reconciles against nothing.
    const retained = log.calls();
    expect(retained).toHaveLength(2);
    // Call 1 is gone entirely or present entirely — never half of it.
    const one = retained.find((call) => call.callId === 1);
    if (one !== undefined) expect(one.outcome).toBe('result');
    // The two most recent calls survive, and the oldest went as a whole.
    expect(retained.map((call) => call.callId)).toEqual([1, 3]);
    expect(log.truncated()).toBe(true);
  });

  it('reports which step refused and which never ran', () => {
    const log = createCallLog();
    // A start first: a terminal whose start was never seen is DROPPED now, because inserting it would
    // show a complete-looking record whose beginning the panel knows nothing about.
    log.accept({
      phase: 'start',
      callId: 7,
      name: 'panel.set',
      route: 'registry',
      startedAt: 5,
      gates: [],
    });
    log.accept({
      phase: 'error',
      callId: 7,
      name: 'panel.set',
      route: 'registry',
      startedAt: 5,
      settledAt: 9,
      gates: [
        { step: 'capability', outcome: 'notRun' },
        { step: 'policy', outcome: 'notRun' },
        { step: 'validate', outcome: 'refused' },
      ],
      failure: { vocabulary: 'route', code: 'MCP_REACT_ARGUMENTS_INVALID' },
    });

    const call = log.calls()[0];
    expect(call?.decidedBy).toBe('validate');
    // The steps that never ran are what a page-script record has to say out loud.
    expect(call?.notRun).toEqual(['capability', 'policy']);
    expect(call?.failureCode).toBe('MCP_REACT_ARGUMENTS_INVALID');
  });
});

describe('a terminal whose start is gone', () => {
  it('is dropped rather than shown as a complete call', () => {
    // **A review found this and it was a real defect, not just a weak test.** With a long-running call
    // on a busy page the start can be evicted before the terminal arrives. Accepting the terminal then
    // inserted what looked like a complete record whose beginning the panel knew nothing about — worse
    // than showing nothing, because it reads as a full account of the call.
    const log = createCallLog(2);
    log.accept(record(1, 'start'));
    log.accept(record(2, 'start'));
    log.accept(record(3, 'start'));
    // Call 1 has now been evicted. Its terminal arrives late.
    log.accept(record(1, 'result', { settledAt: 9_999 }));

    expect(log.calls().map((call) => call.callId)).toEqual([2, 3]);
    // And the reader is told history is incomplete rather than being handed a partial record.
    expect(log.truncated()).toBe(true);
  });
});

describe('a call no gate refused', () => {
  it('is not described as refused at an unknown step', async () => {
    // **A live run caught this.** A cancelled call marks no gate `refused` — nothing declined it, the
    // caller stopped waiting — and the panel rendered "refused at unknown step", sending a reader to
    // look for a decision that was never made. The code was right; the sentence around it was not.
    const { renderPanel } = await import('../../../src/devtools/panel.ts');
    const log = createCallLog();
    log.accept({
      phase: 'start',
      callId: 1,
      name: 'dashboard.audit_accounts',
      route: 'bridge',
      startedAt: 0,
      gates: [],
    });
    log.accept({
      phase: 'error',
      callId: 1,
      name: 'dashboard.audit_accounts',
      route: 'bridge',
      startedAt: 0,
      settledAt: 1_506,
      // Every step passed or never ran. None refused, because a cancellation is not a refusal.
      gates: [
        { step: 'authenticate', outcome: 'passed' },
        { step: 'invoke', outcome: 'notRun' },
      ],
      failure: { vocabulary: 'runtime', code: 'MCP_TOOL_CALL_CANCELLED' },
    });

    const call = log.calls()[0];
    expect(call?.decidedBy).toBeUndefined();

    // Rendered into a real element so the assertion is on what a person reads.
    const real = globalThis.document?.createElement('div');
    if (real === undefined) return;
    renderPanel(real, {
      available: true,
      snapshot: { connection: { status: 'connected' }, tools: [] },
      calls: log.calls(),
      truncated: false,
      retained: 20,
    });
    expect(real.textContent).not.toContain('unknown step');
    expect(real.textContent).toContain('ended');
    expect(real.textContent).toContain('MCP_TOOL_CALL_CANCELLED');
  });
});

describe('the default bound', () => {
  it('is the value the inspector uses, and no application can change it', async () => {
    // **Corrected after a review pointed out the original claim was false.** It said "no way to
    // configure it" while `createCallLog(limit)` takes one — that parameter is a TEST seam, which is
    // a different thing from a knob an application can reach. What actually holds is that nothing on
    // the public surface exposes it: `createInspector` takes a host element and nothing else, and
    // `createCallLog` is not part of the package's entry point.
    expect(RETAINED_CALLS).toBe(20);

    const surface = await import('../../../src/devtools/index.ts');
    const inspector = surface.createInspector as unknown as (options: unknown) => unknown;
    expect(inspector.length).toBe(1);

    // Proportionate Engineering: a knob on the public surface would be a memory bound an operator can
    // set wrong, and nothing has demonstrated a need for one.
    const packageSurface = await import('../../../src/index.ts');
    expect(Object.keys(packageSurface)).not.toContain('createCallLog');
    expect(Object.keys(packageSurface)).not.toContain('RETAINED_CALLS');
  });
});
