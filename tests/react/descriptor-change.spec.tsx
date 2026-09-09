import { render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  nextTask,
  recordChanges,
  registeredNames,
  testValidator,
  until,
} from './harness.ts';

// A genuine descriptor change costs exactly one cycle, and the registry reports it once.
//
// The one-event guarantee is bought by SEQUENCING, and that is the whole subtlety. The platform
// coalesces mutations onto a microtask, so an abort followed by `await register(...)` produces two
// events — the withdrawal's is delivered while the registration is still resolving the registry. The
// same pair with nothing awaited between them produces one. Measured both ways; the unit case in
// tests/unit/react/registration.spec.ts holds the two-event half so that the sequencing reads as a
// constraint rather than as style.
//
// Two events would mean an agent told twice, and — between them — a list that does not contain the
// tool and a call against it refused.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

/** Reads what the registry currently holds for one name. */
async function entryFor(name: string): Promise<{ description: string; title: string } | undefined> {
  const host = (
    document as unknown as {
      modelContext?: {
        getTools(): Promise<Array<{ name: string; description: string; title: string }>>;
      };
    }
  ).modelContext;
  return (await host?.getTools())?.find((tool) => tool.name === name);
}

function Tool({ description }: { description: string }): null {
  useMcpTool({
    name: 'panel.act',
    description,
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ ok: true }),
  });
  return null;
}

function Harness({ describeAs }: { describeAs: (tick: number) => string }): React.ReactNode {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button type="button" data-testid="bump" onClick={() => setTick((value) => value + 1)}>
        bump
      </button>
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'changing-page', version: '0.0.0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Tool description={describeAs(tick)} />
      </AgentMcpProvider>
    </>
  );
}

describe('a genuine descriptor change', () => {
  it('produces exactly one change event', async () => {
    const view = render(<Harness describeAs={(tick) => `revision ${tick}`} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );
    const changes = recordChanges();

    view.getByTestId('bump').click();
    await until(
      async () => (await entryFor('panel.act'))?.description === 'revision 1',
      'the new description to reach the registry',
    );
    await nextTask();

    // One. Not two — which is what an abort followed by an awaited registration produces.
    expect(changes.count()).toBe(1);
    changes.stop();
  });

  it('leaves the new descriptor readable from the registry, not from a library copy', async () => {
    const view = render(<Harness describeAs={(tick) => `revision ${tick}`} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );

    view.getByTestId('bump').click();
    await until(
      async () => (await entryFor('panel.act'))?.description === 'revision 1',
      'the new description to reach the registry',
    );

    // Read back from the document's registry — the sole authority on what a tool is, and the only
    // thing that can answer the question (docs/design.md#registration-follows-the-commit).
    expect((await entryFor('panel.act'))?.description).toBe('revision 1');
    expect(await registeredNames()).toEqual(['panel.act']);
  });

  it('costs one event per change, and no more', async () => {
    const view = render(<Harness describeAs={(tick) => `revision ${tick}`} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );
    const changes = recordChanges();

    for (let bump = 1; bump <= 3; bump += 1) {
      view.getByTestId('bump').click();
      await until(
        async () => (await entryFor('panel.act'))?.description === `revision ${bump}`,
        `revision ${bump} to reach the registry`,
      );
    }
    await nextTask();

    expect(changes.count()).toBe(3);
    changes.stop();
  });

  it('does not fire for a rerender that leaves the description alone', async () => {
    const view = render(<Harness describeAs={() => 'unchanging'} />);
    await until(
      async () => (await registeredNames()).includes('panel.act'),
      'the tool to register',
    );
    const changes = recordChanges();

    for (let bump = 0; bump < 4; bump += 1) view.getByTestId('bump').click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(changes.count()).toBe(0);
    changes.stop();
  });
});
