// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { closeAll, stack } from './runtime/harness.ts';

// The performance budgets, turned into numbers (docs/records/performance-budgets.md).
//
// **These are the three budget clauses that can be settled without a browser**, and none of them had
// ever been checked. The library has claimed from its first release that a 500-tool registry stays
// functional, that it does not poll when idle, and that invocation overhead is under 5 ms — and every
// one of those was prose.
//
// **What is deliberately NOT asserted: a latency on the listing.** The budget says a 500-tool registry
// must remain functional and gives a timing budget only for invocation. A case that also timed the
// listing would be inventing a requirement the design does not make, and it would be the first flaky
// case in this repository — exactly the tolerance that masks a defect instead of fixing it.

afterEach(closeAll);

describe('a registry of 500 tools remains functional', () => {
  it('lists all 500 and calls one of them', async () => {
    // The budget's "remains functional", made concrete: the agent can SEE all of them and can REACH
    // one. A case that only counted the listing would pass for a runtime that had lost every handler.
    const page = await stack();
    const COUNT = 500;

    for (let index = 0; index < COUNT; index += 1) {
      await page.register(`bulk.tool_${index}`, () => ({ index }));
    }

    const listed = await page.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith('bulk.tool_'))).toHaveLength(COUNT);

    // Reach the LAST one, not the first: an implementation that truncated a listing would still serve
    // `bulk.tool_0`.
    const result = (await page.client.callTool({
      name: `bulk.tool_${COUNT - 1}`,
      arguments: {},
    })) as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent ?? result)).toContain(String(COUNT - 1));
  });
});

describe('nothing is sent when nothing happens', () => {
  it('emits zero outbound frames across an idle interval on a live connection', async () => {
    // The budget clause "no polling when idle". The harness records every frame this library sends,
    // so this is countable rather than argued.
    //
    // The connection is genuinely up — a case that asserted silence on a dead socket would pass for a
    // library that had stopped working, which is the vacuous direction.
    const page = await stack();
    await page.register('idle.probe', () => 'ok');
    await page.client.listTools();

    const before = page.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const during = page.sent.length - before;

    expect(during, `${during} frames were sent while idle; the budget requires none`).toBe(0);

    // And the connection was alive the whole time, so the silence means what it should.
    const stillWorks = await page.client.listTools();
    expect(stillWorks.tools.map((tool) => tool.name)).toContain('idle.probe');
  });
});

describe('invocation overhead', () => {
  it('measures the runtime’s own cost per call, excluding the handler', async () => {
    // The budget clause: tool invocation overhead under 5 ms, excluding application handler
    // execution.
    //
    // **Reported as a measurement, and asserted against a deliberately loose ceiling.** The number
    // that matters is in the release record; what this case defends is the ORDER OF MAGNITUDE, because
    // a per-call cost that grew into tens of milliseconds would be a regression nobody would otherwise
    // notice. Asserting 5 ms exactly under a shared CI machine, over a real socket, with a real
    // protocol layer, would make this the first flaky case here — and widening a threshold later to
    // make one pass is exactly the tolerance that masks a defect instead of fixing it, so the
    // threshold is honest from the start.
    const page = await stack();
    await page.register('overhead.probe', () => 'ok');

    const RUNS = 50;
    const started = performance.now();
    for (let index = 0; index < RUNS; index += 1) {
      await page.client.callTool({ name: 'overhead.probe', arguments: {} });
    }
    const perCall = (performance.now() - started) / RUNS;

    // Includes the socket round trip and the protocol layer, so it is an UPPER BOUND on the runtime's
    // own share rather than the figure the budget names. Stated, so nobody reads it as the budget
    // itself.
    console.log(`invocation round trip: ${perCall.toFixed(2)} ms/call over ${RUNS} calls`);

    // **A REGRESSION GUARD, not the budget** — and the number was tightened after a review pointed out
    // that the original 50 ms sat 150x above the measured 0.34 ms, so a tenfold regression would have
    // passed silently. 10 ms still leaves ~30x headroom for a loaded machine, which is what keeps this
    // from becoming the first flaky case here, while catching any regression worth the name.
    //
    // It is deliberately NOT the budget's 5 ms: this measurement includes a real socket round trip
    // that the budget does not count, so asserting 5 ms here would be holding the library to a budget
    // for work that is
    // not the library's. The 5 ms claim is reported in the release record against the measured figure.
    expect(perCall).toBeLessThan(10);
  });
});
