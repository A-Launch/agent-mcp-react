import { render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { REGISTRATION_REFUSED } from '../../src/webmcp/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  codeOf,
  enterSecureContext,
  neverConnects,
  recorder,
  registeredNames,
  until,
} from './harness.ts';

// A descriptor an author computes changes on every render, and every one of those changes is real.
//
// The library performs all of them. It cannot tell a change an author meant from one they did not, and
// suppressing either would be worse than the churn — a tool whose description no longer matches what it
// does is a worse failure than a noisy one. What it can do is make the cost visible, once, so the
// author learns it from their own telemetry rather than from an agent behaving oddly.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

function Computed({ tick }: { tick: number }): null {
  useMcpTool({
    name: 'panel.act',
    // The shape that churns: a template string over a changing value.
    description: `Act on ${tick} pending items.`,
    handler: () => ({ tick }),
  });
  return null;
}

function Harness({ seen }: { seen: ReturnType<typeof recorder> }): React.ReactNode {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button type="button" data-testid="bump" onClick={() => setTick((value) => value + 1)}>
        bump
      </button>
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'churning-page', version: '0.0.0' }}
        onUnexpectedState={(failure) => seen.unexpected.push(failure)}
      >
        <Computed tick={tick} />
      </AgentMcpProvider>
    </>
  );
}

async function churn(view: ReturnType<typeof render>, times: number): Promise<void> {
  for (let bump = 0; bump < times; bump += 1) {
    view.getByTestId('bump').click();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('a descriptor that changes on every render', () => {
  it('is performed as declared — nothing is suppressed', async () => {
    const seen = recorder();
    const view = render(<Harness seen={seen} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );

    await churn(view, 5);

    const host = (
      document as unknown as {
        modelContext?: { getTools(): Promise<Array<{ name: string; description: string }>> };
      }
    ).modelContext;
    const tool = (await host?.getTools())?.find((entry) => entry.name === 'panel.act');
    expect(tool?.description).toBe('Act on 5 pending items.');
  });

  it('is not reported before the churn is implausible', async () => {
    const seen = recorder();
    const view = render(<Harness seen={seen} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );

    await churn(view, 5);

    // A screen that legitimately re-declares its tool a few times must stay quiet, or the report is
    // noise and an operator learns to ignore the destination it arrives in.
    expect(seen.unexpected).toEqual([]);
  });

  it('is reported ONCE when it is, naming the tool and the count', async () => {
    const seen = recorder();
    const view = render(<Harness seen={seen} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );

    await churn(view, 40);

    // Once, however many cycles follow. An alarm per cycle is the storm it is reporting.
    expect(seen.unexpected).toHaveLength(1);
    expect(codeOf(seen.unexpected[0])).toBe(REGISTRATION_REFUSED.churning);
    expect(String(seen.unexpected[0])).toContain('panel.act');
    expect(String(seen.unexpected[0])).toMatch(/\d+ times/);
  });

  it('keeps the tool registered and current throughout', async () => {
    const seen = recorder();
    const view = render(<Harness seen={seen} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );

    await churn(view, 40);

    // The report is information, not a refusal: every cycle the application asked for happened.
    expect(await registeredNames()).toEqual(['panel.act']);
  });
});
