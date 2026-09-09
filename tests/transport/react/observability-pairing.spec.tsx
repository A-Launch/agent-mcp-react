// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALL_PHASE,
  CONFIRMATION,
  FAILURE_VOCABULARY,
  type McpObservedCall,
} from '../../../src/index.ts';
import { useMcpTool } from '../../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, stack, until } from './harness.tsx';

// **Exactly one start and exactly one terminal, for every way a call can end.**
//
// An unpaired record cannot be reconciled, and a consumer cannot tell an unpairable record from a lost
// one — so a surface that dropped terminals under load would be a surface whose silence means nothing.
//
// The cases that would catch a naive implementation are the last two. A site that settled when the
// HANDLER resolved would look correct for a plain success and for a refusal, and would emit a SECOND
// terminal for each of the three outcomes that arrive AFTER a handler has already resolved:
//
//   - a result that cannot be serialized;
//   - a result that violates the tool's declared output schema;
//   - a cancellation landing inside asynchronous output validation.
//
// All three are real paths in `src/runtime/invocation.ts`. Two are driven here; the third needs a
// cancellation to land inside a specific asynchronous window and is covered at unit level, which is
// recorded rather than implied.

afterEach(closeAll);

function idsOf(observed: readonly McpObservedCall[]): number[] {
  return [...new Set(observed.map((event) => event.callId))];
}

function phasesFor(observed: readonly McpObservedCall[], callId: number): string[] {
  return observed.filter((event) => event.callId === callId).map((event) => event.phase);
}

/** Every call in the list is one start followed by exactly one terminal. */
function expectWellPaired(observed: readonly McpObservedCall[]): void {
  for (const id of idsOf(observed)) {
    const phases = phasesFor(observed, id);
    expect(phases).toHaveLength(2);
    expect(phases[0]).toBe(CALL_PHASE.start);
    expect(phases[1] === CALL_PHASE.result || phases[1] === CALL_PHASE.error).toBe(true);
  }
}

function Tools(): ReactNode {
  const [, setValue] = useState('unset');
  useMcpTool({
    name: 'panel.ok',
    description: 'Succeeds.',
    handler: (input) => {
      setValue(String(input.value));
      return { value: String(input.value) };
    },
  });
  useMcpTool({
    name: 'panel.throws',
    description: 'Throws.',
    handler: () => {
      throw new Error('the application handler failed');
    },
  });
  useMcpTool({
    name: 'panel.unserializable',
    description: 'Returns something that cannot cross a wire.',
    handler: () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    },
  });
  useMcpTool({
    name: 'panel.breaks_contract',
    description: 'Returns something its declared output schema forbids.',
    outputSchema: {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
      additionalProperties: false,
    },
    handler: () => ({ total: 'not a number' }),
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the declared contract
  } as any);
  return null;
}

describe('every way a call can end', () => {
  it('produces one start and one terminal for a success, a refusal and a throw', async () => {
    const page = await stack(<Tools />);

    await page.client.callTool({ name: 'panel.ok', arguments: { value: 'x' } });
    await page.client.callTool({ name: 'nobody.registered_this', arguments: {} });
    await page.client.callTool({ name: 'panel.throws', arguments: {} });
    await until(() => idsOf(page.observed).length === 3, 'all three calls to be reported');

    expectWellPaired(page.observed);
    // Ids are distinct and monotonic, which is what makes correlation possible at all.
    const ids = idsOf(page.observed);
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('produces ONE terminal for a result that cannot be serialized', async () => {
    // The handler resolves. The failure is discovered afterwards, while proving the value can cross a
    // wire — so an implementation that settled on handler resolution has already emitted a `result`
    // and is about to emit an `error` for the same call.
    const page = await stack(<Tools />);
    await page.client.callTool({ name: 'panel.unserializable', arguments: {} });
    await until(() => idsOf(page.observed).length === 1, 'the call to be reported');

    expectWellPaired(page.observed);
    expect(phasesFor(page.observed, idsOf(page.observed)[0] as number)).toEqual([
      CALL_PHASE.start,
      CALL_PHASE.error,
    ]);
    // **The code, so this cannot pass for the wrong reason.** Without it the case would be satisfied
    // by a call that failed anywhere at all — including before the handler ran, which is precisely the
    // situation it is meant to exclude.
    expect(page.observed.at(-1)?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.resultNotSerializable,
    });
  });

  it('produces ONE terminal for a result that violates its declared output schema', async () => {
    // The second post-handler path, and the one with a real asynchronous window: output validation is
    // awaited, so the handler has long since resolved by the time this fails.
    const page = await stack(<Tools />);
    await page.client.callTool({ name: 'panel.breaks_contract', arguments: {} });
    await until(() => idsOf(page.observed).length === 1, 'the call to be reported');

    expectWellPaired(page.observed);
    expect(phasesFor(page.observed, idsOf(page.observed)[0] as number)).toEqual([
      CALL_PHASE.start,
      CALL_PHASE.error,
    ]);
    // Its OWN code, never the input one: the handler ALREADY RAN and may have changed the
    // application, so an agent told its arguments were refused would believe nothing happened.
    expect(page.observed.at(-1)?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.resultViolatesOutputSchema,
    });
  });
});

describe('a call that is cancelled', () => {
  function Slow(): ReactNode {
    useMcpTool({
      name: 'panel.slow',
      description: 'Never settles on its own.',
      handler: (_input, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    return null;
  }

  it('reports the cancellation by NAME, not as an uncoded failure', async () => {
    // **Added after a review found the gap, and it was not merely missing coverage.** Every one of the
    // six cancellation return sites bypassed `noteFailure`, so the dispatcher's finalizer had nothing
    // to settle with and fell back to `uncoded` — telling an operator a call ended for no reason this
    // library could name, when it had ended for one of the two most specific reasons it has.
    const page = await stack(<Slow />);

    const controller = new AbortController();
    const call = page.client
      .callTool({ name: 'panel.slow', arguments: {} }, { signal: controller.signal })
      .catch(() => undefined);
    await until(() => idsOf(page.observed).length === 1, 'the call to be reported as started');
    controller.abort();
    await call;

    await until(
      () => phasesFor(page.observed, idsOf(page.observed)[0] as number).length === 2,
      'the call to settle',
    );

    expectWellPaired(page.observed);
    const terminal = page.observed.at(-1);
    expect(terminal?.phase).toBe(CALL_PHASE.error);
    // Named, and never reported as a success — a cancelled call always settles with an outcome and
    // never claims one it did not have (docs/design.md#cancellation), now visible on the surface that
    // explains it.
    expect(terminal?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.callCancelled,
    });
  });
});

describe('a confirmation a person declines', () => {
  function Guarded(): ReactNode {
    useMcpTool({
      name: 'panel.guarded',
      description: 'Needs a person.',
      permissions: { confirmation: 'required' },
      handler: () => 'should never run',
    });
    return null;
  }

  it('reports the refusal by NAME, not as an uncoded failure', async () => {
    // **The same defect as the cancellation case above, found the same way and in eight more places.**
    // Every refusal site but four returned without noting anything, so the finalizer fell back to
    // `uncoded`. The visible symptom was two surfaces telling different stories about one event: the
    // AGENT was correctly told `MCP_TOOL_CONFIRMATION_REFUSED`, while the inspector — the surface whose
    // entire job is explaining why a call was refused — rendered "refused at confirm — uncoded".
    //
    // A declined confirmation is the sharpest case to hold this to, because it is the one refusal a
    // PERSON made deliberately. If any refusal has a reason worth recording, it is that one.
    // From the exported dictionary, never a literal: a closed set of values is spelled in one place.
    const page = await stack(<Guarded />, { confirmation: async () => CONFIRMATION.refused });

    const refused = (await page.client.callTool({
      name: 'panel.guarded',
      arguments: {},
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);

    await until(
      () => phasesFor(page.observed, idsOf(page.observed)[0] as number).length === 2,
      'the call to settle',
    );

    expectWellPaired(page.observed);
    const terminal = page.observed.at(-1);
    expect(terminal?.phase).toBe(CALL_PHASE.error);
    expect(terminal?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.confirmationRefused,
    });
    // And the step that decided it, so the panel can say WHERE as well as why.
    expect(terminal?.gates?.find((gate) => gate.step === 'confirm')?.outcome).toBe('refused');
  });

  it('reports a tool that needs a person and has nobody to ask', async () => {
    // A different code for a different situation, and the distinction is an operator's to act on: this
    // is a deployment fact — no resolver was supplied — rather than a decision anybody made.
    const page = await stack(<Guarded />);

    const refused = (await page.client.callTool({
      name: 'panel.guarded',
      arguments: {},
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);

    await until(
      () => phasesFor(page.observed, idsOf(page.observed)[0] as number).length === 2,
      'the call to settle',
    );

    expect(page.observed.at(-1)?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.confirmationUnavailable,
    });
  });
});

describe('two calls at once', () => {
  it('keeps each call’s start before its own terminal, and never cross-correlates', async () => {
    const page = await stack(<Tools />);

    await Promise.all([
      page.client.callTool({ name: 'panel.ok', arguments: { value: 'a' } }),
      page.client.callTool({ name: 'panel.ok', arguments: { value: 'b' } }),
    ]);
    await until(() => idsOf(page.observed).length === 2, 'both calls to be reported');

    // The two calls may interleave with each other — they genuinely are concurrent — but a start
    // arriving after its own terminal would be unreconcilable, and a shared id would silently merge
    // two calls into one.
    expectWellPaired(page.observed);
    expect(idsOf(page.observed)).toHaveLength(2);
  });
});
