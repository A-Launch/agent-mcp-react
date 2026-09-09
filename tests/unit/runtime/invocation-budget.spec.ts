import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION,
  CONTROL_LEVEL,
  type ConfirmationResolver,
  type DeclaredPermissions,
} from '../../../src/index.ts';
import { type InvocationTarget, invoke } from '../../../src/runtime/invocation.ts';
import { createAjvValidator } from '../../../src/validation/ajv.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// The performance record budgets tool invocation overhead at **under 5 ms excluding the application
// handler** (`docs/records/performance-budgets.md`). Input and output schema validation both sit on
// that path, so the budget stops being a number in a document and becomes something that has to be
// true.
//
// Measured rather than asserted, which is how the budget is stated. The handler here does nothing, so what is
// timed is exactly the overhead: validate in, run, normalize, validate out.
//
// **This is a budget, not a benchmark.** It is deliberately generous against the stated limit, because
// a case that fails when a laptop is busy teaches people to re-run the suite until it passes — and a
// test nobody trusts is worse than no test. What it catches is a change of ORDER: compiling per call
// instead of per declaration, or validating something quadratic in the argument size.
//
// **Three more gates sit on the same path** — capability, availability and confirmation — so the
// budget is measured with all of them live rather than standing on the shape the path had before they
// existed. One of the three does not belong in the number: a confirmation is a person deciding, and
// the budget covers what the LIBRARY costs. That exclusion is measured too, not asserted —
// the resolver times its own wait and only what it actually took is subtracted, and the case fails if
// the wait it is excluding was never large enough to matter.

const validator = createAjvValidator();

const inputSchema = {
  type: 'object',
  properties: {
    segments: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } },
    query: { type: 'string' },
    limit: { type: 'number' },
    nested: {
      type: 'object',
      properties: { deep: { type: 'array', items: { type: 'object' } } },
    },
  },
  additionalProperties: false,
};

const outputSchema = {
  type: 'object',
  properties: { matched: { type: 'number' }, rows: { type: 'array', items: { type: 'object' } } },
  required: ['matched'],
};

function entryWith(rows: number): InvocationTarget {
  const result = {
    matched: rows,
    rows: Array.from({ length: rows }, (_, index) => ({ id: index, name: `row ${String(index)}` })),
  };
  return {
    // A declaration lifetime, so the per-invocation `AbortSignal.any` composition and its listeners
    // are on the measured path. They allocate per call, which is exactly the kind of thing this budget
    // exists to notice — a target without one would measure the cheaper arrangement.
    lifetime: new AbortController().signal,
    handler: () => result,
    description: 'b',
    outputSchema,
    validators: {
      input: validator.compile(inputSchema) as InvocationTarget['validators'] extends undefined
        ? never
        : NonNullable<InvocationTarget['validators']>['input'],
      output: validator.compile(outputSchema) as NonNullable<
        InvocationTarget['validators']
      >['output'],
    },
  } as InvocationTarget;
}

const args = {
  segments: ['a', 'c'],
  query: 'northwind',
  limit: 20,
  nested: { deep: Array.from({ length: 20 }, (_, index) => ({ index })) },
};

/**
 * What the gates on the path are configured with for one measurement.
 *
 * Absent members leave a gate at the cheapest arrangement it has — no declared permissions, no
 * resolver — which is what the pre-010 cases measured and still measure.
 */
interface Gates {
  readonly permissions?: DeclaredPermissions;
  readonly confirmationResolver?: ConfirmationResolver;
}

async function averageMs(
  entry: InvocationTarget,
  runs: number,
  gates: Gates = {},
): Promise<number> {
  const context = {
    requestSignal: new AbortController().signal,
    afterRender: () => Promise.resolve(),
    capabilities: () => APPLICATION_ONLY,
    level: CONTROL_LEVEL.application,
    permissions: () => gates.permissions,
    ...(gates.confirmationResolver === undefined
      ? {}
      : { confirmationResolver: () => gates.confirmationResolver }),
  };
  // Warm up: the first call through a freshly compiled validator pays for lazy initialization that no
  // subsequent call does, and averaging it in would measure the wrong thing.
  for (let run = 0; run < 20; run += 1) await invoke('bench.tool', entry, args, context);

  const started = performance.now();
  for (let run = 0; run < runs; run += 1) await invoke('bench.tool', entry, args, context);
  return (performance.now() - started) / runs;
}

describe('what validation costs on the call path', () => {
  it('stays well inside the 5 ms budget for a realistic call', async () => {
    const average = await averageMs(entryWith(20), 300);

    // eslint-disable-next-line no-console
    console.log(`invocation overhead, 20-row result: ${average.toFixed(3)} ms`);
    expect(average).toBeLessThan(5);
  });

  it('does not grow with the size of the result in a way that breaks the budget', async () => {
    const small = await averageMs(entryWith(10), 200);
    const large = await averageMs(entryWith(500), 100);

    // eslint-disable-next-line no-console
    console.log(`10 rows: ${small.toFixed(3)} ms · 500 rows: ${large.toFixed(3)} ms`);

    // Fifty times the result, still inside the budget. Output validation walks the result, so this is
    // linear by nature — what this catches is something worse than linear, and compiling per call.
    expect(large).toBeLessThan(5);
  });
});

// The capability, availability and confirmation gates, on the same path and against the same number.
//
// The arrangement is the most expensive one a Level 1 tool can be in: a capability set that has to be
// read and admitted, declared permissions that have to be consulted twice — once at the availability
// gate and again at the recheck the confirmation gate performs after an answer — and a confirmation
// that deep-freezes a detached snapshot of the arguments before anybody is asked. A tool that declares
// nothing pays for none of it, which is why the cases above are kept rather than replaced.
describe('what the capability model costs on the call path', () => {
  const APPROVES_AT_ONCE: ConfirmationResolver = () => CONFIRMATION.approved;

  it('stays inside the 5 ms budget with capability, availability and confirmation all live', async () => {
    const average = await averageMs(entryWith(20), 300, {
      permissions: { available: true, confirmation: 'required' },
      confirmationResolver: APPROVES_AT_ONCE,
    });

    // eslint-disable-next-line no-console
    console.log(`invocation overhead, all three gates live: ${average.toFixed(3)} ms`);
    expect(average).toBeLessThan(5);
  });

  it('costs the gates, not the arguments — a deep freeze does not scale the budget with the result', async () => {
    const gates = {
      permissions: { available: true, confirmation: 'required' } as DeclaredPermissions,
      confirmationResolver: APPROVES_AT_ONCE,
    };
    const small = await averageMs(entryWith(10), 200, gates);
    const large = await averageMs(entryWith(500), 100, gates);

    // eslint-disable-next-line no-console
    console.log(`gated · 10 rows: ${small.toFixed(3)} ms · 500 rows: ${large.toFixed(3)} ms`);

    // The snapshot the confirmation gate freezes is of the ARGUMENTS, which do not change here; the
    // result does. A change that started freezing or copying the result would show up as this case
    // tracking the row count, and it would be invisible in the single-size case above.
    expect(large).toBeLessThan(5);
  });

  it('excludes the time a person spends deciding, and the wait it excludes is real', async () => {
    // A resolver that takes human-scale time to answer, and times its own wait. What is subtracted is
    // what this function MEASURED, never the interval it was asked for — a timer that overshoots would
    // otherwise be subtracted as if it had not.
    const WAIT_MS = 40;
    let waited = 0;
    const deliberates: ConfirmationResolver = async () => {
      const from = performance.now();
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      waited += performance.now() - from;
      return CONFIRMATION.approved;
    };

    const entry = entryWith(20);
    const context = {
      requestSignal: new AbortController().signal,
      afterRender: () => Promise.resolve(),
      capabilities: () => APPLICATION_ONLY,
      level: CONTROL_LEVEL.application,
      permissions: (): DeclaredPermissions => ({ available: true, confirmation: 'required' }),
      confirmationResolver: () => deliberates,
    };

    for (let run = 0; run < 5; run += 1) await invoke('bench.tool', entry, args, context);
    waited = 0;

    const RUNS = 20;
    const started = performance.now();
    for (let run = 0; run < RUNS; run += 1) await invoke('bench.tool', entry, args, context);
    const elapsed = performance.now() - started;

    const withWait = elapsed / RUNS;
    const library = (elapsed - waited) / RUNS;

    // eslint-disable-next-line no-console
    console.log(
      `confirmation held for ${(waited / RUNS).toFixed(1)} ms/call · ` +
        `with the wait: ${withWait.toFixed(3)} ms · library only: ${library.toFixed(3)} ms`,
    );

    // The library's own cost, which is what the budget covers.
    expect(library).toBeLessThan(5);

    // **And the exclusion has to be doing work.** Without this the case would pass on its own if the
    // resolver answered instantly, and it would go on passing after somebody replaced the deliberating
    // resolver with a synchronous one — measuring nothing while reading as proof that the human wait
    // is excluded. The wait must be big enough that leaving it in would blow the budget.
    expect(withWait).toBeGreaterThan(5);
  });
});
