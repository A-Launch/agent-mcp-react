import { render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  recordChanges,
  registeredNames,
  testValidator,
  until,
} from './harness.ts';

// A rerender must not touch the registry at all.
//
// **These cases count the registry's own change events, never registrations.** That distinction is the
// whole reason they exist. Before this feature, a tool declared with an inline `inputSchema` was
// withdrawn and re-registered on every rerender — and the registration count stayed at exactly one
// throughout, correct at rest and correct after every cycle. A case counting registrations passes
// against the defect, which is how it shipped.
//
// What the extra cycles cost an agent: a `tools/list_changed` for nothing, and a window inside each
// cycle where the tool does not exist and a call against it is refused.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

/** Declared the way the documentation shows: an inline schema and an inline handler. */
function InlineTool({ tick }: { tick: number }): null {
  useMcpTool({
    name: 'panel.set',
    description: 'Set the panel value.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    handler: (input) => ({ received: input.value, tick }),
  });
  return null;
}

/** The same tool with no schema at all — the shape that happened to be safe before. */
function BareTool({ tick }: { tick: number }): null {
  useMcpTool({
    name: 'panel.set',
    description: 'Set the panel value.',
    handler: () => ({ tick }),
  });
  return null;
}

function Harness({ Tool }: { Tool: (props: { tick: number }) => null }): React.ReactNode {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button type="button" data-testid="bump" onClick={() => setTick((value) => value + 1)}>
        bump
      </button>
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'rerendering-page', version: '0.0.0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Tool tick={tick} />
      </AgentMcpProvider>
    </>
  );
}

async function mountAndSettle(Tool: (props: { tick: number }) => null) {
  const view = render(<Harness Tool={Tool} />);
  await until(async () => (await registeredNames()).includes('panel.set'), 'the tool to register');
  const changes = recordChanges();
  return { view, changes };
}

describe('a rerender that changes nothing', () => {
  it('produces zero change events for a tool with an INLINE schema', async () => {
    const { view, changes } = await mountAndSettle(InlineTool);

    for (let bump = 0; bump < 5; bump += 1) view.getByTestId('bump').click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The number that can see the defect. Before this feature it was 5.
    expect(changes.count()).toBe(0);
    changes.stop();
  });

  it('produces zero change events for a tool with no schema', async () => {
    const { view, changes } = await mountAndSettle(BareTool);

    for (let bump = 0; bump < 5; bump += 1) view.getByTestId('bump').click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(changes.count()).toBe(0);
    changes.stop();
  });

  it('leaves the tool registered throughout, so the count is right for the right reason', async () => {
    const { view, changes } = await mountAndSettle(InlineTool);

    for (let bump = 0; bump < 5; bump += 1) view.getByTestId('bump').click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Asserted alongside the event count, never instead of it: this is the assertion that stayed true
    // while the defect was live, and it is kept so a reader can see that it is not the control.
    expect(await registeredNames()).toEqual(['panel.set']);
    expect(changes.count()).toBe(0);
    changes.stop();
  });

  it('does not re-register for a new handler identity alone', async () => {
    // An inline handler is a new function on every render. If that counted as a change, every tool in
    // every application would cycle on every render.
    const { view, changes } = await mountAndSettle(InlineTool);

    view.getByTestId('bump').click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(changes.count()).toBe(0);
    changes.stop();
  });
});
