import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  testValidator,
  until,
} from './harness.ts';

// Which changes cancel a call that is already running, and which do not.
//
// **This is the file that separates two things a registration controller cannot tell apart.** The
// registry has no update operation, so a descriptor change is a withdraw-and-register cycle — the same
// abort an unmount performs. Composing that abort into a call's signal would mean a component whose
// description depends on state cancels its own in-flight calls whenever that state moves, and feature
// 006 made a rerender cost a call nothing precisely so it would not.
//
// The three cases below are the whole rule:
//
//   - descriptor changed, same name  → the tool is still there. The call runs.
//   - the name changed               → the old tool is gone. The call is abandoned.
//   - the component unmounted        → the tool is gone. The call is abandoned.
//
// **Break-it**: hand the registration controller's signal to the call instead of the declaration
// lifetime and the first case goes RED while the other two stay green — which is exactly how this
// would have shipped, since the two that matter most would have looked correct.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});
afterEach(clearRegistry);

/** Calls a tool through the registry's own entry point and reports how the handler's signal behaved. */
function callThroughRegistry(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('the document has no registry');
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  return invoke.call(registry, name, JSON.stringify(args), undefined, true);
}

async function registered(name: string): Promise<void> {
  await act(async () => {
    await until(async () => {
      const registry = (
        document as unknown as { modelContext?: { getTools?: () => Promise<{ name: string }[]> } }
      ).modelContext;
      const tools = (await registry?.getTools?.()) ?? [];
      return tools.some((tool) => tool.name === name);
    }, `${name} to be registered`);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 30; turn += 1) await new Promise((r) => setImmediate(r));
  });
}

/** One call the handler under test received, and whether its signal ever aborted while it ran. */
interface Observed {
  readonly tool: string;
  aborted: boolean;
  release?: () => void;
}

describe('a call in flight while its tool changes', () => {
  /**
   * Mounts a component whose tool's name and description are both controllable, and starts one call
   * that blocks until released.
   */
  async function startCall(): Promise<{
    calls: Observed[];
    rename: (to: string) => void;
    redescribe: (to: string) => void;
    hide: () => void;
    callAgain: (tool: string) => Promise<void>;
  }> {
    // One record per call rather than one for the whole case, so a case can start a SECOND call after
    // a rename and ask about that one. Sharing a single record makes the rename's own cancellation
    // indistinguishable from the later call's.
    const calls: Observed[] = [];
    let rename: ((to: string) => void) | undefined;
    let redescribe: ((to: string) => void) | undefined;
    let hide: (() => void) | undefined;

    function Tool({ name, note }: { name: string; note: string }): null {
      useMcpTool({
        name,
        description: note,
        handler: (_input, context) =>
          new Promise((resolve) => {
            const record: Observed = { tool: name, aborted: false };
            calls.push(record);
            context.signal.addEventListener('abort', () => {
              record.aborted = true;
            });
            record.release = () => resolve('done');
          }),
      });
      return null;
    }

    function Screen(): React.ReactNode {
      const [name, setName] = useState('panel.set');
      const [note, setNote] = useState('first');
      const [gone, setGone] = useState(false);
      rename = setName;
      redescribe = setNote;
      hide = () => setGone(true);
      return gone ? null : <Tool name={name} note={note} />;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'lifetime', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await registered('panel.set');

    void callThroughRegistry('panel.set').catch(() => undefined);
    await settle();

    return {
      calls,
      rename: (to) => rename?.(to),
      redescribe: (to) => redescribe?.(to),
      hide: () => hide?.(),
      callAgain: async (tool) => {
        void callThroughRegistry(tool).catch(() => undefined);
        await settle();
      },
    };
  }

  it('keeps running when only the description changed', async () => {
    const scenario = await startCall();

    await act(async () => {
      scenario.redescribe('second');
    });
    await settle();

    // The tool is still declared, by the same component, under the same name, and the handler running
    // is the current one. Nothing was withdrawn as far as an agent can tell.
    expect(scenario.calls[0]?.aborted).toBe(false);

    scenario.calls[0]?.release?.();
    await settle();
  });

  it('is cancelled when the name changed, because the old tool is gone', async () => {
    const scenario = await startCall();

    await act(async () => {
      scenario.rename('panel.adjust');
    });
    await settle();

    // Nothing an agent can call resolves to `panel.set` any more. A call still running under it has
    // been abandoned exactly as if the component had unmounted.
    expect(scenario.calls[0]?.aborted).toBe(true);
  });

  it('is cancelled by an unmount that follows a rename', async () => {
    // **The leak a rename created, and why the cleanup reads the ref rather than its own closure.**
    //
    // The mounting effect closes over the lifetime it created. A rename replaces that lifetime — the
    // old tool is genuinely gone and the new name gets its own — so on unmount the captured controller
    // is already aborted while the live one is somewhere else. Aborting the captured one leaves the
    // current lifetime open for the life of the page, and a call under the renamed tool never learns
    // its component unmounted: the agent waits for a handler nothing will stop.
    //
    // The unmount case below cannot see this. Without a rename the two controllers are one object.
    const scenario = await startCall();

    await act(async () => {
      scenario.rename('panel.adjust');
    });
    await settle();
    await scenario.callAgain('panel.adjust');

    const underNewName = scenario.calls.find((call) => call.tool === 'panel.adjust');
    expect(underNewName).toBeDefined();
    expect(underNewName?.aborted).toBe(false);

    await act(async () => {
      scenario.hide();
    });
    await settle();

    expect(underNewName?.aborted).toBe(true);
  });

  it('is cancelled when the declaring component unmounts', async () => {
    const scenario = await startCall();

    await act(async () => {
      scenario.hide();
    });
    await settle();

    expect(scenario.calls[0]?.aborted).toBe(true);
  });
});
