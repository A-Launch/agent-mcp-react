import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { StrictMode, Suspense, useState } from 'react';
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

// A handler must act on current state, and only committed renders may make it current.
//
// **The first case renders outside `act()`, and that is not a stylistic choice.** `act()` flushes
// passive effects synchronously, so under React Testing Library a handler updated in a passive effect
// and one updated in a layout effect read identically — the window this feature closes does not exist
// inside `act()`, and the case cannot fail. The first version of the research probe reported no
// difference at all, which is how that was found.
//
// The window is real because an agent's call arrives as a MESSAGE, which is its own task: React commits
// in one task and runs passive effects in a later one, so a call landing between them runs the previous
// render's handler. State one render old, success reported, screen correct, nothing surfaces it.

beforeEach(() => {
  clearRegistry();
  enterSecureContext();
});
afterEach(clearRegistry);

// **Why there is no behavioural case for the window here.** Research measured it outside `act()`: a
// caller in the task following a commit reads `2` from a layout-updated ref and `1` from a
// passive-updated one. Reproducing that as a case is a RACE, not a property — React schedules passive
// effects through a MessageChannel, which can beat a `setTimeout(0)` queued before it, so the same case
// reports a difference on one run and none on the next. Buying a green run with timing is forbidden
// here — the cause gets fixed, never worked around — and a case that passes for scheduler reasons is worse than no case: it would be cited as
// evidence for a guarantee it did not check.
//
// So the mechanism is held structurally below, the measurement lives in research.md, and the gap
// between them is recorded in the feature's conformance claims rather than implied away.

describe('the hook uses the mechanism the case above requires', () => {
  it('updates its definition ref in a LAYOUT effect, not a passive one', async () => {
    // Asserted against the source, and that is a deliberate second-best.
    //
    // The case above holds the platform fact — a passive update is one render stale to a caller in the
    // following task. Nothing here can hold that the HOOK uses it: the window is one task wide, and
    // every reachable caller arrives later than that. An agent's call crosses a socket; the registry's
    // own execution surface is not installed by the portability layer outside its testing mode. So a
    // behavioural case would pass against either mechanism, which is the shape of assertion this
    // feature exists to stop trusting.
    //
    // A source assertion fails for the right reason when somebody changes the mechanism, and says why.
    // The gap it stands in for is recorded in the feature's conformance claims rather than implied
    // away by this file being green.
    const source = await readFile(resolve(process.cwd(), 'src/react/use-mcp-tool.ts'), 'utf8');

    expect(
      /useLayoutEffect\(\(\) => \{\s*definitionRef\.current = definition;/.test(source),
      "the definition ref must be updated in a layout effect — a passive update leaves a caller in the following task reading the previous render's handler",
    ).toBe(true);
  });
});

function Panel({ start }: { start: number }): React.ReactNode {
  const [value, setValue] = useState(start);
  useMcpTool({
    name: 'panel.read',
    description: 'Read the current panel value.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ value }),
  });
  return (
    <button type="button" data-testid="bump" onClick={() => setValue((v) => v + 1)}>
      {value}
    </button>
  );
}

function mount(children: React.ReactNode) {
  return render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'currency-page', version: '0.0.0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      {children}
    </AgentMcpProvider>,
  );
}

describe('a live tool and a render that never commits', () => {
  it('is untouched by it — the registration and the descriptor both', async () => {
    let renders = 0;
    function Suspending({ start }: { start: number }): React.ReactNode {
      renders += 1;
      // The second render suspends and is thrown away.
      if (renders === 2) throw new Promise<void>(() => undefined);
      return <Panel start={start} />;
    }

    const view = mount(
      <Suspense fallback={null}>
        <Suspending start={0} />
      </Suspense>,
    );
    await until(
      async () => (await registeredNames()).includes('panel.read'),
      'the tool to register',
    );
    const changes = recordChanges();

    view.rerender(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'currency-page', version: '0.0.0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Suspense fallback={null}>
          <Suspending start={99} />
        </Suspense>
      </AgentMcpProvider>,
    );
    await nextTask();

    // A discarded render must expose nothing — and that includes changing what a live tool is or does.
    expect(await registeredNames()).toEqual(['panel.read']);
    expect(changes.count()).toBe(0);
    changes.stop();
  });
});

describe('strict mode double-invoking the layout effect', () => {
  it('costs nothing, because the write is idempotent', async () => {
    const view = render(
      <StrictMode>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'currency-page', version: '0.0.0' }}
          validation={{ validator: testValidator }}
          onUnexpectedState={() => undefined}
        >
          <Panel start={5} />
        </AgentMcpProvider>
      </StrictMode>,
    );
    await until(
      async () => (await registeredNames()).includes('panel.read'),
      'the tool to register',
    );
    const changes = recordChanges();

    // Asserted so nobody adds a guard against a second invocation that costs nothing — and so that
    // the double render does not quietly become a second registration.
    view.getByTestId('bump').click();
    await nextTask();

    expect(await registeredNames()).toEqual(['panel.read']);
    expect(changes.count()).toBe(0);
    changes.stop();
  });
});
