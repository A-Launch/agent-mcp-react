import { act, render, screen } from '@testing-library/react';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
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

// `context.afterRender()` — the state-consistency surface
// (docs/design.md#a-call-settles-after-the-commit), and the promise the design spends a paragraph
// warning against overstating.
//
// **What is asserted here is what is ON SCREEN**, not what the library believes. That distinction is
// the whole point: this project's characteristic defect is a handler that reports success while the
// DOM never changed, and a case that read the library's own state would agree with a broken barrier.
//
// **The break-it that matters**: replace the barrier's body with `new Promise(requestAnimationFrame)`
// — the implementation the design offers and then forbids the claim for — and the first case here
// goes RED.

/** A store below the provider, the way an application's own state lives. */
const StoreContext = createContext<
  { level: string; set: (to: string) => void; current: () => string } | undefined
>(undefined);

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});
afterEach(clearRegistry);

/**
 * Calls a tool the way a page script would: through the registry's OWN invocation entry point.
 *
 * That route does not pass through the runtime (docs/design.md#tool-results), which makes it the
 * sharper test of the
 * barrier: whatever the in-page path gives a handler has to mean the same thing the bridged path does,
 * or a tool's success depends on who called it.
 */
function callThroughRegistry(name: string, args: Record<string, unknown>): Promise<unknown> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('the document has no registry');
  // Called ON the registry rather than destructured off it: these are prototype methods using `this`.
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  return invoke.call(registry, name, JSON.stringify(args), undefined, true);
}

/**
 * Runs a call to completion, letting React commit while it is in flight.
 *
 * **The call is started OUTSIDE `act` and the flushing happens inside it, and that order is the
 * synchronization this mechanism actually needs rather than a workaround.** Awaiting the call from
 * inside an `act` scope deadlocks by construction: the handler is waiting for a commit, and `act` is
 * holding the commit until its own callback returns. A real page has no `act` and no such window; the
 * test has to give React the turn the browser would have taken.
 */
async function runCall(name: string, args: Record<string, unknown> = {}): Promise<void> {
  const call = callThroughRegistry(name, args);
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
  });
  await call;
}

/** Waits until the tool is actually in the document's registry — registration is asynchronous. */
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

function mount(children: React.ReactNode): void {
  render(
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'barrier', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      {children}
    </AgentMcpProvider>,
  );
}

describe('a handler that dispatches and then awaits the barrier', () => {
  it('sees the change already rendered when the barrier resolves', async () => {
    // What the handler read off the DOM at the moment the barrier resolved. Captured inside the
    // handler rather than asserted afterwards, because afterwards is true of a barrier that waited
    // for nothing at all — by then the render has happened for its own reasons.
    let onScreenWhenResolved: string | undefined;

    function Panel(): React.ReactNode {
      const [level, setLevel] = useState('low');
      useMcpTool({
        name: 'panel.set',
        description: 'sets the level',
        inputSchema: {
          type: 'object',
          properties: { level: { type: 'string' } },
          required: ['level'],
        },
        handler: async (input, context) => {
          setLevel(String(input.level));
          await context.afterRender();
          onScreenWhenResolved = document.querySelector('[data-testid="level"]')?.textContent ?? '';
          return 'applied';
        },
      });
      return <span data-testid="level">{level}</span>;
    }

    mount(<Panel />);
    await registered('panel.set');
    await runCall('panel.set', { level: 'high' });

    // The assertion the feature exists for. Not "the DOM eventually said high" — that is true of any
    // implementation — but "the DOM already said high at the line after the await".
    expect(onScreenWhenResolved).toBe('high');
  });

  it('does not already see it when the handler skips the barrier', async () => {
    // The pairing, and it is what proves the case above measures the barrier rather than React being
    // fast. Same component, same dispatch, one line removed.
    let onScreenImmediately: string | undefined;

    function Panel(): React.ReactNode {
      const [level, setLevel] = useState('low');
      useMcpTool({
        name: 'panel.set',
        description: 'sets the level',
        inputSchema: {
          type: 'object',
          properties: { level: { type: 'string' } },
          required: ['level'],
        },
        handler: (input) => {
          setLevel(String(input.level));
          onScreenImmediately = document.querySelector('[data-testid="level"]')?.textContent ?? '';
          return 'applied';
        },
      });
      return <span data-testid="level">{level}</span>;
    }

    mount(<Panel />);
    await registered('panel.set');
    await runCall('panel.set', { level: 'high' });

    expect(onScreenImmediately).toBe('low');
    // And it did land, eventually — so the difference above is about WHEN, not about whether the
    // dispatch worked at all.
    expect(screen.getByTestId('level').textContent).toBe('high');
  });
});

describe('a page that is not being given frames', () => {
  it('still resolves the barrier, with the change committed', async () => {
    // **The case that actually discriminates, and it exists because the obvious one does not.**
    //
    // Swapping the barrier for `new Promise(requestAnimationFrame)` — the implementation the design
    // suggests, and whose accompanying claim it forbids — leaves every other case in this file GREEN.
    // Measured, not
    // assumed: in jsdom a frame is a ~16 ms timer and React's commit lands in a microtask well before
    // it, so a frame-based barrier resolves later than the commit and therefore also sees the change.
    // It is a weaker guarantee that happens to hold here.
    //
    // What separates them is a page that gets no frames. A background tab is throttled to zero, and a
    // barrier built on one waits until the user comes back — for a call an agent made and is waiting
    // on. So frames are switched off, which is the browser condition rather than a contrivance.
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (() => 0) as typeof globalThis.requestAnimationFrame;

    try {
      let onScreenWhenResolved: string | undefined;

      function Panel(): React.ReactNode {
        const [level, setLevel] = useState('low');
        useMcpTool({
          name: 'panel.set',
          description: 'sets the level',
          handler: async (_input, context) => {
            setLevel('high');
            await context.afterRender();
            onScreenWhenResolved =
              document.querySelector('[data-testid="level"]')?.textContent ?? '';
            return 'applied';
          },
        });
        return <span data-testid="level">{level}</span>;
      }

      mount(<Panel />);
      await registered('panel.set');
      await runCall('panel.set');

      expect(onScreenWhenResolved).toBe('high');
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });
});

describe('the barrier when there is nothing to wait for', () => {
  it('resolves for a handler that scheduled no update at all', async () => {
    let resolved = false;

    function Panel(): React.ReactNode {
      useMcpTool({
        name: 'panel.ping',
        description: 'changes nothing',
        handler: async (_input, context) => {
          await context.afterRender();
          resolved = true;
          return 'pong';
        },
      });
      return <span data-testid="panel">here</span>;
    }

    mount(<Panel />);
    await registered('panel.ping');
    await runCall('panel.ping');

    // A handler is entitled to await this without having dispatched anything, and it must not hang.
    // The barrier waits for a commit, and asking for one always produces one.
    expect(resolved).toBe(true);
  });
});

describe('what the barrier costs', () => {
  it('does not rerender the application, only the provider', async () => {
    // **The performance budget's exception, bounded by measurement rather than by assertion.**
    //
    // The budget (docs/records/performance-budgets.md) forbids a React rerender caused solely by an
    // MCP request unless application state actually
    // changes, and this feature amended it to permit the one the barrier commits — a handler that
    // awaits it has asked, in application code, for a commit. The amendment is only defensible if the
    // cost is what it claims, so the cost is counted: the provider rerenders, and the tree beneath it
    // does not, because `props.children` is the same element and React bails out of that subtree.
    //
    // A change that moved the counter into a context value, or that rebuilt `children`, would turn one
    // provider render into a whole-application render on every awaited call, and nothing else here
    // would notice.
    let childRenders = 0;

    function Child(): React.ReactNode {
      childRenders += 1;
      useMcpTool({
        name: 'panel.ping',
        description: 'changes no application state at all',
        handler: async (_input, context) => {
          await context.afterRender();
          return 'pong';
        },
      });
      return <span data-testid="child">x</span>;
    }

    mount(<Child />);
    await registered('panel.ping');

    const before = childRenders;
    await runCall('panel.ping');

    expect(childRenders).toBe(before);
  });
});

describe('the barrier after the provider has gone', () => {
  it('resolves instead of joining a list nothing will drain', async () => {
    // The descriptor this library leaves in the shared registry outlives the React tree by however
    // long the registry takes to withdraw it, so a page script can reach a handler — and through it
    // `afterRender()` — in that window. A waiter registered then would join a list whose one-time
    // drain has already run, and wait for a commit that can never come.
    let resolved = false;
    let held: ((value: () => Promise<void>) => void) | undefined;
    const barrier = new Promise<() => Promise<void>>((resolve) => {
      held = resolve;
    });

    function Panel(): React.ReactNode {
      useMcpTool({
        name: 'panel.ping',
        description: 'hands its barrier out',
        handler: (_input, context) => {
          held?.(() => context.afterRender());
          return 'pong';
        },
      });
      return null;
    }

    const view = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'torn', version: '0' }}
        validation={{ validator: testValidator }}
        onUnexpectedState={() => undefined}
      >
        <Panel />
      </AgentMcpProvider>,
    );
    await registered('panel.ping');
    await runCall('panel.ping');
    const afterRender = await barrier;

    view.unmount();

    await act(async () => {
      const waited = Promise.race([
        afterRender().then(() => 'resolved'),
        new Promise<'hung'>((resolve) => {
          setTimeout(() => resolve('hung'), 300);
        }),
      ]);
      for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
      resolved = (await waited) === 'resolved';
    });

    expect(resolved).toBe(true);
  });
});

describe('the barrier under concurrent use', () => {
  it('settles a handler that awaits it twice', async () => {
    // Two waiters from one call, allocated one after the other. A drain that cleared the whole set on
    // the first commit would resolve the second before its own update was committed — which is the
    // generation bug this file's counterpart exists for, reachable without a second caller.
    const seen: string[] = [];

    function Panel(): React.ReactNode {
      const [level, setLevel] = useState('low');
      useMcpTool({
        name: 'panel.step',
        description: 'changes twice',
        handler: async (_input, context) => {
          setLevel('middle');
          await context.afterRender();
          seen.push(document.querySelector('[data-testid="level"]')?.textContent ?? '');
          setLevel('high');
          await context.afterRender();
          seen.push(document.querySelector('[data-testid="level"]')?.textContent ?? '');
          return 'done';
        },
      });
      return <span data-testid="level">{level}</span>;
    }

    mount(<Panel />);
    await registered('panel.step');
    await runCall('panel.step');

    // Each await saw its OWN change, not the first one twice and not the last one twice.
    expect(seen).toEqual(['middle', 'high']);
  });

  it('settles overlapping calls, each against its own change', async () => {
    // Two calls in flight at once. The waiters are distinguished by the tick their own bump produced,
    // so one call's commit cannot settle the other's waiter early.
    const seen: Record<string, string> = {};

    function Panel(): React.ReactNode {
      const [level, setLevel] = useState('low');
      useMcpTool({
        name: 'panel.set',
        description: 'sets the level',
        handler: async (input, context) => {
          const to = String(input.level);
          setLevel(to);
          await context.afterRender();
          seen[to] = document.querySelector('[data-testid="level"]')?.textContent ?? '';
          return to;
        },
      });
      return <span data-testid="level">{level}</span>;
    }

    mount(<Panel />);
    await registered('panel.set');

    const first = callThroughRegistry('panel.set', { level: 'middle' });
    const second = callThroughRegistry('panel.set', { level: 'high' });
    await act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => setImmediate(r));
    });
    await Promise.all([first, second]);

    // Both settled — neither is missing, which is what a lost waiter would look like.
    expect(Object.keys(seen).sort()).toEqual(['high', 'middle']);
  });
});

describe('a call started from inside a child effect', () => {
  it('waits for its own commit, not the one that was already draining', async () => {
    // **The generation case, and it needs a shape none of the others have.**
    //
    // React runs a child's passive effects BEFORE the parent's. So a child effect that starts a tool
    // call registers its waiter during the very commit the provider's drain is about to run for. A
    // drain that emptied the whole list would settle that waiter against a commit which predates the
    // update it is waiting on — the barrier silently promising less than it says, for a caller that
    // did nothing unusual.
    //
    // **The break-it does NOT redden, and that is recorded rather than glossed.** Draining every
    // waiter regardless of its tick leaves this case green, and every other case in this file green
    // too. So the generation guard in the provider is **not covered by a test** — I could not
    // construct an arrangement in jsdom where a waiter registered during a drain is settled early,
    // and this case asserts the property without proving the mechanism that delivers it.
    //
    // The guard is kept anyway. It is strictly more correct than draining everything, the failure it
    // prevents is silent, and the reason it is unreachable here may simply be that React's effect
    // ordering under `act` closes the window that a real browser leaves open. What is not honest is a
    // comment claiming coverage this file does not have.
    let observedByLate: string | undefined;
    let startLate: (() => void) | undefined;

    function Panel(): React.ReactNode {
      const [level, setLevel] = useState('low');
      const [phase, setPhase] = useState(0);
      startLate = () => setPhase(1);

      useMcpTool({
        name: 'panel.late',
        description: 'changes and waits',
        handler: async (_input, context) => {
          setLevel('high');
          await context.afterRender();
          observedByLate = document.querySelector('[data-testid="level"]')?.textContent ?? '';
          return 'done';
        },
      });

      // The child effect that starts a call. Keyed on `phase` so the case controls when it fires, and
      // so it fires during a commit the provider is already draining for.
      useEffect(() => {
        if (phase !== 1) return;
        void callThroughRegistry('panel.late', {}).catch(() => undefined);
      }, [phase]);

      return <span data-testid="level">{level}</span>;
    }

    mount(<Panel />);
    await registered('panel.late');

    // A first call, so the provider is mid-drain when the child effect below starts the second.
    const primer = callThroughRegistry('panel.late', {});
    act(() => {
      startLate?.();
    });
    await act(async () => {
      for (let turn = 0; turn < 25; turn += 1) await new Promise((r) => setImmediate(r));
    });
    await primer;

    // The waiter registered during the drain must have seen its own change, not the state before it.
    expect(observedByLate).toBe('high');
  });
});

describe('the barrier under StrictMode, with application state below the provider', () => {
  it('waits for the commit rather than resolving instantly', async () => {
    // **The shape a real page has, and the one every other case in this file was missing.**
    //
    // StrictMode runs mount effects setup → cleanup → setup, so a provider's teardown cleanup fires
    // once during a perfectly normal mount. A flag latched there and never cleared makes the barrier
    // resolve immediately for the life of the page: every handler reports success before anything has
    // rendered. That shipped for an hour and every test stayed green — the flat StrictMode case below
    // asserts the change eventually landed, which is true whether the barrier waited or not.
    //
    // What catches it is asserting what the handler SAW: the store's own value, read after the await,
    // from a store that lives below the provider the way an application's does.
    const seen: string[] = [];

    function Store({ children }: { children: React.ReactNode }): React.ReactNode {
      const [level, setLevel] = useState('low');
      const latest = useRef('low');
      latest.current = level;
      return (
        <StoreContext.Provider value={{ level, set: setLevel, current: () => latest.current }}>
          {children}
        </StoreContext.Provider>
      );
    }

    function Panel(): React.ReactNode {
      const store = useContext(StoreContext);
      useMcpTool({
        name: 'panel.set',
        description: 'sets the level',
        handler: async (_input, context) => {
          store?.set('high');
          await context.afterRender();
          seen.push(store?.current() ?? 'no store');
          return 'applied';
        },
      });
      return <span data-testid="level">{store?.level}</span>;
    }

    render(
      <React.StrictMode>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'barrier-strict-nested', version: '0' }}
          validation={{ validator: testValidator }}
          onUnexpectedState={() => undefined}
        >
          <Store>
            <Panel />
          </Store>
        </AgentMcpProvider>
      </React.StrictMode>,
    );
    await registered('panel.set');
    await runCall('panel.set');

    // Not "it ended up high" — that is true of a barrier that waited for nothing. What the handler read
    // at the line after the await is the assertion.
    expect(seen).toEqual(['high']);
  });
});

describe('the barrier under StrictMode', () => {
  it('settles once and is not lost to the second effect pass', async () => {
    // StrictMode double-invokes the effect that drains the pending set. The set is emptied before it
    // resolves anything, so the second pass has nothing to do — a "drain then clear" written the other
    // way round would resolve the same promises twice, which is harmless, or throw on an emptied
    // iterator, which is not.
    let resolutions = 0;

    function Panel(): React.ReactNode {
      const [level, setLevel] = useState('low');
      useMcpTool({
        name: 'panel.set',
        description: 'sets the level',
        handler: async (_input, context) => {
          setLevel('high');
          await context.afterRender();
          resolutions += 1;
          return level;
        },
      });
      return <span data-testid="level">{level}</span>;
    }

    render(
      <React.StrictMode>
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: neverConnects }}
          server={{ name: 'barrier-strict', version: '0' }}
          validation={{ validator: testValidator }}
          onUnexpectedState={() => undefined}
        >
          <Panel />
        </AgentMcpProvider>
      </React.StrictMode>,
    );
    await registered('panel.set');
    await runCall('panel.set');

    expect(resolutions).toBe(1);
    expect(screen.getByTestId('level').textContent).toBe('high');
  });
});
