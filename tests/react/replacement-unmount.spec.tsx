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

// Unmounting while a descriptor change is still in flight.
//
// **The leak this file exists for.** A replacement is asynchronous — it waits for the gateway, then
// compiles the new schemas. The declaring component can unmount inside that window, and when it does,
// the hook's cleanup aborts the controller for the registration being CREATED. The one being REPLACED
// has its own controller, and until this case existed nothing aborted it: the replacement returned
// early on seeing its own controller aborted, and the previous registration stayed in the document's
// registry for the life of the page.
//
// A leaked registration is not a cosmetic problem. The registry is per-document, so the name stays
// taken: the next mount of the same component collides with a tool nobody can withdraw, and an agent
// can call a handler belonging to a tree that no longer exists.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});
afterEach(clearRegistry);

async function registeredNames(): Promise<string[]> {
  const registry = (
    document as unknown as { modelContext?: { getTools?: () => Promise<{ name: string }[]> } }
  ).modelContext;
  return ((await registry?.getTools?.()) ?? []).map((tool) => tool.name);
}

describe('a component that unmounts while its descriptor change is in flight', () => {
  it('leaves nothing registered', async () => {
    let describeIt: ((text: string) => void) | undefined;
    let hide: ((gone: boolean) => void) | undefined;

    function Tool({ note }: { note: string }): null {
      useMcpTool({
        name: 'panel.set',
        description: note,
        inputSchema: { type: 'object', properties: { level: { type: 'string' } } },
        handler: () => 'ok',
      });
      return null;
    }

    function Screen(): React.ReactNode {
      const [note, setNote] = useState('first');
      const [gone, setGone] = useState(false);
      describeIt = setNote;
      hide = setGone;
      return gone ? null : <Tool note={note} />;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'p', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(
        async () => (await registeredNames()).includes('panel.set'),
        'first registration',
      );
    });

    // **Two commits, and no microtask drained between them.** The change has to actually COMMIT so its
    // effect queues a replacement and the asynchronous work begins; the unmount then has to land while
    // that work is still suspended on an await. Doing both in one commit — which the first version of
    // this case did — means the effect never runs, nothing is queued, and there is no window to hit.
    //
    // The synchronous `act` form is deliberate: the awaited form drains microtasks, which is exactly
    // what would close the window before the unmount arrives.
    act(() => {
      describeIt?.('second');
    });
    act(() => {
      hide?.(true);
    });
    await act(async () => {
      for (let turn = 0; turn < 30; turn += 1) await new Promise((r) => setImmediate(r));
    });

    // Nothing. The component is gone, so the exposed set must describe a page that no longer declares
    // this tool. A tool is gone at unmount — the lifecycle property the whole library is built on.
    expect(await registeredNames()).toEqual([]);
  });

  it('still performs a change when the component stays mounted', async () => {
    let describeIt: ((text: string) => void) | undefined;

    function Screen(): React.ReactNode {
      const [note, setNote] = useState('first');
      describeIt = setNote;
      useMcpTool({
        name: 'panel.set',
        description: note,
        inputSchema: { type: 'object', properties: { level: { type: 'string' } } },
        handler: () => 'ok',
      });
      return null;
    }

    render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'p', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Screen />
      </AgentMcpProvider>,
    );
    await act(async () => {
      await until(
        async () => (await registeredNames()).includes('panel.set'),
        'first registration',
      );
    });

    await act(async () => {
      describeIt?.('second');
    });
    await act(async () => {
      for (let turn = 0; turn < 30; turn += 1) await new Promise((r) => setImmediate(r));
    });

    // The pairing. A replacement path that withdrew on every abort check would pass the case above
    // while quietly destroying descriptor changes.
    expect(await registeredNames()).toContain('panel.set');
  });
});
