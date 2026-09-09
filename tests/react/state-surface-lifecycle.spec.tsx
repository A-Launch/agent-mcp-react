import { act, render } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpState } from '../../src/index.ts';
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

// A state surface's lifecycle IS a tool's lifecycle, because it is one. These cases exist to prove
// that the composition in the plan is real rather than nominal: if `useMcpState` had grown its own
// registration path, every claim below would have to be re-established for it, and the ones that
// silently do not hold are exactly the ones a new path gets wrong.
//
// **The claim that matters most here is the zero-churn one**, and it is why `recordChanges` counts
// registry CHANGE events rather than registrations. A withdraw-and-register cycle leaves the
// registration count at exactly one — correct at rest and correct after every cycle — which is how a
// cycle-per-rerender once shipped past a green suite. A state surface makes that trap worse than it
// was for `useMcpTool`: `getState` is a new closure on every render, and state moves on every
// keystroke.

const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, resultCount: { type: 'number' } },
  required: ['query'],
} as const;

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(clearRegistry);

function Surface({
  query = 'initial',
  description = 'the current customer query',
  schema = SCHEMA as unknown as Record<string, unknown>,
}: {
  query?: string;
  description?: string;
  schema?: Record<string, unknown>;
}): React.ReactNode {
  useMcpState({
    name: 'customers',
    description,
    schema,
    getState: () => ({ query, resultCount: 48 }),
  });
  return null;
}

function Host({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <AgentMcpProvider
      capabilities={APPLICATION_ONLY}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page', version: '0' }}
      validation={{ validator: testValidator }}
      onUnexpectedState={() => undefined}
    >
      {children}
    </AgentMcpProvider>
  );
}

async function settled(): Promise<void> {
  await act(async () => {
    await until(async () => (await registeredNames()).length > 0, 'waited for registration');
  });
}

describe('a declared state surface', () => {
  it('publishes exactly one tool, named by derivation, and nothing else', async () => {
    render(
      <Host>
        <Surface />
      </Host>,
    );
    await settled();

    expect(await registeredNames()).toEqual(['customers.get_state']);
  });

  it('disappears when the declaring component unmounts', async () => {
    const { unmount } = render(
      <Host>
        <Surface />
      </Host>,
    );
    await settled();
    expect(await registeredNames()).toContain('customers.get_state');

    unmount();
    await act(async () => {
      await until(async () => (await registeredNames()).length === 0, 'waited for withdrawal');
    });

    expect(await registeredNames()).toEqual([]);
  });
});

describe('what a rerender costs', () => {
  it('touches the registry not at all across a hundred rerenders of an unchanged declaration', async () => {
    // The schema is written INLINE in the component below, so it is a new object every render, and
    // `getState` is a new closure every render. Both are the exact shapes that made the content-based
    // comparison necessary in the first place.
    function Churner({ tick }: { tick: number }): React.ReactNode {
      useMcpState({
        name: 'customers',
        description: 'the current customer query',
        schema: { type: 'object', properties: { tick: { type: 'number' } } },
        getState: () => ({ tick }),
      });
      return null;
    }

    const view = render(
      <Host>
        <Churner tick={0} />
      </Host>,
    );
    await settled();

    const changes = recordChanges();
    changes.reset();

    for (let tick = 1; tick <= 100; tick += 1) {
      view.rerender(
        <Host>
          <Churner tick={tick} />
        </Host>,
      );
    }
    await act(async () => {
      await Promise.resolve();
    });

    expect(changes.count()).toBe(0);
    expect(await registeredNames()).toEqual(['customers.get_state']);
    changes.stop();
  });

  it('sends nothing when the state itself moves, however often', async () => {
    // **Not a rule this hook remembers but a consequence of what it does.** The change signal is
    // driven by the registry and the ownership record; `getState`'s return value writes to neither.
    // There is no `notifications/state_changed` in the negotiated 2025-11-25 era, so an agent learns
    // new state by calling again — and this case is what would fail if a future change tried to
    // express "state moved" as a list-changed, which would be a false statement about the tool set.
    let push: React.Dispatch<React.SetStateAction<string>> | undefined;
    function Typing(): React.ReactNode {
      const [query, setQuery] = useState('');
      push = setQuery;
      useMcpState({
        name: 'customers',
        description: 'the current customer query',
        schema: SCHEMA as unknown as Record<string, unknown>,
        getState: () => ({ query, resultCount: 48 }),
      });
      return null;
    }

    render(
      <Host>
        <Typing />
      </Host>,
    );
    await settled();

    const changes = recordChanges();
    changes.reset();

    // Every keystroke of a realistic filter box.
    for (const character of 'acme corporation') {
      await act(async () => {
        push?.((previous) => previous + character);
      });
    }

    expect(changes.count()).toBe(0);
    changes.stop();
  });
});

describe('what a real change costs', () => {
  it('is exactly one cycle when the description changes', async () => {
    const view = render(
      <Host>
        <Surface description="the current customer query" />
      </Host>,
    );
    await settled();

    const changes = recordChanges();
    changes.reset();

    view.rerender(
      <Host>
        <Surface description="the customer query, as filtered" />
      </Host>,
    );
    await act(async () => {
      await until(async () => changes.count() > 0, 'waited for the change to land');
    });

    // Withdraw and register is necessarily two registry events — the standard has no update operation.
    // What matters is that it is ONE cycle rather than one per rerender.
    expect(changes.count()).toBeLessThanOrEqual(2);
    expect(changes.count()).toBeGreaterThan(0);
    expect(await registeredNames()).toEqual(['customers.get_state']);
    changes.stop();
  });

  it('re-registers when the SCHEMA changes, though the registry cannot carry a schema', async () => {
    // **The case most likely to be missing**, because the registry's descriptor has no output-schema
    // field: the change is invisible to anything comparing only what the registry holds. Without it
    // the tool goes on advertising an output contract its handler no longer honours, and the mismatch
    // surfaces as a result the agent is told violates a schema nobody changed.
    const view = render(
      <Host>
        <Surface schema={{ type: 'object', properties: { query: { type: 'string' } } }} />
      </Host>,
    );
    await settled();

    const changes = recordChanges();
    changes.reset();

    view.rerender(
      <Host>
        <Surface
          schema={{
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          }}
        />
      </Host>,
    );
    await act(async () => {
      await until(async () => changes.count() > 0, 'waited for the schema change to land');
    });

    expect(changes.count()).toBeGreaterThan(0);
    changes.stop();
  });

  it('costs nothing when the schema is rewritten to the same content', async () => {
    // The other half of the previous case, and the one that makes it a comparison rather than a
    // trigger: equal content compares equal however it was written, so a schema literal rebuilt each
    // render is not a change.
    const view = render(
      <Host>
        <Surface schema={{ type: 'object', properties: { query: { type: 'string' } } }} />
      </Host>,
    );
    await settled();

    const changes = recordChanges();
    changes.reset();

    view.rerender(
      <Host>
        <Surface schema={{ properties: { query: { type: 'string' } }, type: 'object' }} />
      </Host>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(changes.count()).toBe(0);
    changes.stop();
  });
});

describe('under StrictMode', () => {
  it('leaves exactly one registration after mount / unmount / mount', async () => {
    // **The claim being tested is the COMPOSITION, not StrictMode.** The mount-cleanup-mount cycle is
    // survived by `useMcpTool`'s own machinery — one abort controller per registration, and a
    // module-level token so a double-mount cleans up only its own. If a state surface needed anything
    // of its own here, the composition would be partial and the plan would be what needs correcting.
    //
    // What makes this worth asserting rather than assuming: registration is ASYNCHRONOUS and effects
    // are not, so under StrictMode two registrations of one name are in flight at once. Exactly one
    // survives and it is the right one — which is precisely why a case counting registrations at rest
    // passes whether or not the mechanism works, and why this asserts the registry's contents.
    render(
      <StrictMode>
        <Host>
          <Surface />
        </Host>
      </StrictMode>,
    );
    await settled();

    expect(await registeredNames()).toEqual(['customers.get_state']);
  });

  it('reads current state after the double-mount, not the discarded render', async () => {
    // The two halves together. A double-mount that left the FIRST mount's handler installed would
    // register exactly one tool, list correctly, and answer from a component React already threw
    // away — success in every count-based assertion.
    function Live({ value }: { value: string }): React.ReactNode {
      useMcpState({
        name: 'customers',
        description: 'the current customer query',
        schema: SCHEMA as unknown as Record<string, unknown>,
        getState: () => ({ query: value, resultCount: 48 }),
      });
      return null;
    }

    const view = render(
      <StrictMode>
        <Host>
          <Live value="first" />
        </Host>
      </StrictMode>,
    );
    await settled();

    view.rerender(
      <StrictMode>
        <Host>
          <Live value="second" />
        </Host>
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const registry = (document as unknown as { modelContext?: Record<string, unknown> })
      .modelContext;
    const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
      .executeToolByName;
    const raw = await invoke.call(
      registry,
      'customers.get_state',
      JSON.stringify({}),
      undefined,
      true,
    );
    const shaped = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      structuredContent?: Record<string, unknown>;
    };

    expect(shaped.structuredContent).toEqual({ query: 'second', resultCount: 48 });
  });
});
