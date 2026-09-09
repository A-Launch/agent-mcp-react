// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMcpCapabilities, useMcpTool } from '../../../src/react/index.ts';
import { RUNTIME_FAILURE } from '../../../src/runtime/index.ts';
import { closeAll, listedNames, stack, until } from './harness.tsx';

// What `useMcpCapabilities` publishes, checked against what the AGENT actually experiences.
//
// The React suite next door asserts the hook's own contract against a provider that never dials. This
// file exists for the one claim that cannot be made there: **the object handed to application code is
// the object the gate is reading**, so if publishing it could widen it, the widening would be visible
// to a real agent over a real socket and nowhere else.
//
// A frozen object that the gate does not consult would pass every case in the React suite. A frozen
// object the gate DOES consult, with the freeze removed, is a Level 3 switch in application code.

afterEach(closeAll);

interface CallResult {
  isError?: boolean;
  content?: { text?: string }[];
}

function textOf(result: CallResult): string {
  return result.content?.[0]?.text ?? '';
}

/**
 * A component that reads the published set and tries to widen it, the way a careless application
 * would when a call it wanted was refused.
 */
function Widener({ attempted }: { attempted: { error?: string } }): ReactNode {
  const capabilities = useMcpCapabilities();
  try {
    (capabilities as { evaluate: boolean }).evaluate = true;
    (capabilities as { application: boolean }).application = true;
    attempted.error = 'none';
  } catch (cause) {
    attempted.error = (cause as Error).name;
  }
  useMcpTool({
    name: 'invoice.mark_paid',
    description: 'Mark the open invoice as paid.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ paid: true }),
  });
  return null;
}

describe('the set an application is handed is the set the gate reads', () => {
  it('cannot be widened from application code, and the agent stays refused', async () => {
    // **The case this file exists for.** The provider grants nothing; the component writes to the
    // published set; the agent calls anyway. Without the freeze at its source, this call succeeds —
    // a capability granted by no operator, from a line of application code, reaching the runtime
    // because the runtime reads the granted set live at every check.
    const attempted: { error?: string } = {};
    const page = await stack(<Widener attempted={attempted} />);
    page.grant({ application: false, dom: { inspect: false, interact: false }, evaluate: false });

    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to reach the agent',
    );

    expect(attempted.error).toBe('TypeError');

    const result = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(RUNTIME_FAILURE.capabilityDenied);
  });

  it('admits the call when the OPERATOR grants it, which is what makes the refusal above mean something', async () => {
    // The pairing. A runtime that refused everything satisfies the case above and would have made the
    // capability model a way to turn the library off.
    const attempted: { error?: string } = {};
    const page = await stack(<Widener attempted={attempted} />);
    page.grant({ application: true, dom: { inspect: false, interact: false }, evaluate: false });

    await until(
      async () => (await listedNames(page.client)).includes('invoice.mark_paid'),
      'the tool to reach the agent',
    );

    const result = (await page.client.callTool({
      name: 'invoice.mark_paid',
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('paid');
  });
});
