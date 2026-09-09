// @vitest-environment jsdom
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALL_PHASE,
  CALL_ROUTE,
  FAILURE_VOCABULARY,
  GATE_OUTCOME,
  type McpObservedCall,
} from '../../../src/index.ts';
import { useMcpTool } from '../../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { NOTHING_GRANTED } from '../../support/capabilities.ts';
import { closeAll, stack, until } from './harness.tsx';

// **The requirement observability makes, driven over a real socket** (docs/observing-tool-calls.md):
// every state an operator is left with is explainable from evidence.
//
// "Every call MUST be explainable after the fact: which tool, admitted or denied by WHICH STEP of the
// gate chain." A refusal an observer cannot attribute to a specific step is an unexplainable state,
// and an unexplainable state is indistinguishable from a wrong one.
//
// Each case here drives ONE step to refuse and asserts the record names THAT step and no neighbour.
// The pairs that must never collapse into one generic "denied" are the point:
//
//   - capability vs policy. One is an operator's decision about the whole connection; the other is the
//     application's decision about one tool right now, and it usually tracks state an agent can
//     change. An agent told the wrong one either gives up on a tool that is about to work, or retries
//     one that never will — and an operator goes to the wrong place to fix it.
//   - unknown vs foreign at the resolve step. One means the agent asked for something that does not
//     exist; the other means it asked for something that exists and is not ours.
//
// **`authenticate` can never be the refusing step**, and that is asserted rather than assumed: a call
// that reached the runtime came over a socket the gateway already admitted at the upgrade. The step is
// real, it is enforced elsewhere, and no call record can attribute a refusal to it.

/**
 * A value no timestamp, id or code can contain by accident.
 *
 * The whole point of a canary is that finding it means one thing only.
 */
const LEAK_CANARY = 'leak-canary-9f3a7c21b8';

afterEach(closeAll);

function outcomeOf(event: McpObservedCall, step: string): string | undefined {
  return event.gates.find((gate) => gate.step === step)?.outcome;
}

/** The one terminal for the most recent call. */
function terminal(observed: readonly McpObservedCall[]): McpObservedCall | undefined {
  return observed.filter((event) => event.phase !== CALL_PHASE.start).at(-1);
}

function Panel(): ReactNode {
  const [, setValue] = useState('unset');
  useMcpTool({
    name: 'panel.set',
    description: 'Set the panel value.',
    inputSchema: {
      type: 'object',
      // An ENUM rather than a bare string type, so an invalid argument can be a distinctive TOKEN
      // rather than a number. That matters for the leak assertion below: a bare `42` is a two-digit
      // string that appears by coincidence inside a millisecond timestamp, so the check failed
      // intermittently for a reason that had nothing to do with a leak.
      properties: { value: { type: 'string', enum: ['open', 'closed'] } },
      required: ['value'],
      additionalProperties: false,
    },
    handler: (input) => {
      setValue(String(input.value));
      return { value: String(input.value) };
    },
  });
  return null;
}

describe('a refusal names the step that produced it', () => {
  it('attributes an unknown name to resolve, and says WHICH resolution', async () => {
    const page = await stack(<Panel />);
    await page.client.callTool({ name: 'nobody.registered_this', arguments: {} });
    await until(() => terminal(page.observed) !== undefined, 'the call to be reported');

    const event = terminal(page.observed);
    expect(event?.phase).toBe(CALL_PHASE.error);
    expect(outcomeOf(event as McpObservedCall, 'resolve')).toBe(GATE_OUTCOME.refused);
    // Which of the three, because "not found" and "someone else holds it" are different problems with
    // different fixes, and a record that merged them would send an author to rename a tool they own.
    expect(event?.resolution).toBe('unknown');
    expect(event?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.toolNotFound,
    });
  });

  it('attributes a withheld capability to capability, and NOT to policy', async () => {
    const page = await stack(<Panel />, { capabilities: NOTHING_GRANTED });
    await page.client.callTool({ name: 'panel.set', arguments: { value: 'open' } });
    await until(() => terminal(page.observed) !== undefined, 'the call to be reported');

    const event = terminal(page.observed);
    expect(outcomeOf(event as McpObservedCall, 'capability')).toBe(GATE_OUTCOME.refused);
    expect(event?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.capabilityDenied,
    });
    // The neighbour that must stay clean. `policy` never ran — the chain stopped — and reporting it as
    // passed would say the application was offering a tool nobody asked it about.
    expect(outcomeOf(event as McpObservedCall, 'policy')).toBe(GATE_OUTCOME.notRun);
    expect(outcomeOf(event as McpObservedCall, 'invoke')).toBe(GATE_OUTCOME.notRun);
  });

  it('attributes a malformed argument to validate, carrying no value', async () => {
    const page = await stack(<Panel />);
    await page.client.callTool({ name: 'panel.set', arguments: { value: LEAK_CANARY } });
    await until(() => terminal(page.observed) !== undefined, 'the call to be reported');

    const event = terminal(page.observed);
    expect(outcomeOf(event as McpObservedCall, 'validate')).toBe(GATE_OUTCOME.refused);
    expect(outcomeOf(event as McpObservedCall, 'capability')).toBe(GATE_OUTCOME.passed);
    expect(event?.failure).toEqual({
      vocabulary: FAILURE_VOCABULARY.runtime,
      code: RUNTIME_FAILURE.argumentsInvalid,
    });
    // The leak this feature inherited from 010: a validator's own reason string may quote the value it
    // rejected, and the record has nowhere to put one.
    //
    // **The canary is long and distinctive on purpose.** This assertion first read
    // `not.toContain('42')`, which failed roughly one run in six — not because anything leaked, but
    // because a millisecond timestamp ends in "42" about that often. A substring check against a short
    // value is a check that fires on coincidence, and a leak assertion that cries wolf is one a
    // reader learns to re-run rather than believe.
    expect(JSON.stringify(page.observed)).not.toContain(LEAK_CANARY);
  });

  it('reports authenticate as passed, and never as the refusing step', async () => {
    const page = await stack(<Panel />, { capabilities: NOTHING_GRANTED });
    await page.client.callTool({ name: 'panel.set', arguments: { value: 'open' } });
    await until(() => terminal(page.observed) !== undefined, 'the call to be reported');

    for (const event of page.observed) {
      expect(outcomeOf(event, 'authenticate')).toBe(GATE_OUTCOME.passed);
    }
  });
});

describe('a call that succeeds', () => {
  it('passes every step, and is reported on the bridge route', async () => {
    const page = await stack(<Panel />);
    await page.client.callTool({ name: 'panel.set', arguments: { value: 'open' } });
    await until(() => terminal(page.observed) !== undefined, 'the call to be reported');

    const event = terminal(page.observed);
    expect(event?.phase).toBe(CALL_PHASE.result);
    expect(event?.route).toBe(CALL_ROUTE.bridge);
    expect(event?.failure).toBeUndefined();
    for (const step of ['authenticate', 'resolve', 'capability', 'policy', 'validate', 'invoke']) {
      expect(outcomeOf(event as McpObservedCall, step)).toBe(GATE_OUTCOME.passed);
    }
  });
});
