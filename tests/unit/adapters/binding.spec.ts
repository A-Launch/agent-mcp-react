import { afterEach, describe, expect, it } from 'vitest';
import { declared, resetDeclarationsForTests } from '../../../src/actions/queue.ts';
import { bindReduxTool } from '../../../src/adapters/redux.ts';
import { bindNavigationTool, bindUrlFilterTool } from '../../../src/adapters/router.ts';
import { bindZustandTool } from '../../../src/adapters/zustand.ts';

// What an adapter binds, and what it refuses to be handed.
//
// These run with no provider and no registry: an adapter is a translation into a DECLARATION, and the
// declaration is the thing to check. Whether that declaration then registers, gates and refuses
// correctly is not this file's business — it is the imperative path's, and it is asserted there.

afterEach(resetDeclarationsForTests);

/** The declared handler, reached the way the runtime would. */
function handlerOf(index = 0): (input: Record<string, unknown>, context: unknown) => unknown {
  const entry = declared()[index];
  if (entry === undefined) throw new Error('nothing was declared');
  return entry.definition.handler as (i: Record<string, unknown>, c: unknown) => unknown;
}

/** A context whose `afterRender` resolves, standing in for a committed render. */
const settled = { signal: new AbortController().signal, afterRender: () => Promise.resolve() };

describe('the Redux adapter', () => {
  it('dispatches the ONE bound creator, with the call arguments', async () => {
    const dispatched: unknown[] = [];
    bindReduxTool({
      name: 'customers.set_filters',
      description: 'Sets customer filters.',
      dispatch: (action) => dispatched.push(action),
      action: (input) => ({ type: 'customers/setFilters', payload: input }),
    });

    await handlerOf()({ status: 'active' }, settled);

    expect(dispatched).toEqual([{ type: 'customers/setFilters', payload: { status: 'active' } }]);
  });

  it('resolves only AFTER the application accepted the mutation', async () => {
    // The line that makes an adapter worth having over a hand-written handler. Dispatch is
    // synchronous and a render is not: reporting before the commit is a success the agent believes
    // and a person cannot see on screen. A call settles only after the application accepted the
    // mutation (`docs/design.md#a-call-settles-after-the-commit`).
    const order: string[] = [];
    bindReduxTool({
      name: 'customers.set_filters',
      description: 'Sets customer filters.',
      dispatch: () => order.push('dispatched'),
      action: (input) => input,
      selectResult: () => {
        order.push('selected');
        return { done: true };
      },
    });

    await handlerOf()(
      {},
      {
        signal: new AbortController().signal,
        afterRender: () => {
          order.push('committed');
          return Promise.resolve();
        },
      },
    );

    expect(order).toEqual(['dispatched', 'committed', 'selected']);
  });

  it('reports what the selector produced, and nothing it went looking for', async () => {
    bindReduxTool({
      name: 'customers.set_filters',
      description: 'Sets customer filters.',
      dispatch: () => undefined,
      action: (input) => input,
      selectResult: () => ({ filters: { status: 'active' }, matched: 7 }),
    });

    expect(await handlerOf()({}, settled)).toEqual({
      filters: { status: 'active' },
      matched: 7,
    });
  });

  it('invents no state shape when there is no selector', async () => {
    // The same rule the runtime follows for a tool that declared no output schema: structure is never
    // fabricated for a tool that did not promise one.
    bindReduxTool({
      name: 'customers.clear_filters',
      description: 'Clears customer filters.',
      dispatch: () => undefined,
      action: () => ({ type: 'customers/clear' }),
    });

    expect(await handlerOf()({}, settled)).toEqual({ applied: true });
  });
});

describe('the Zustand adapter', () => {
  it('calls the bound action directly, with no creator to compose', async () => {
    // The reason this is a separate module rather than a rename: Redux composes a creator with a
    // dispatcher, a Zustand action is already a function. Two modules differing only by a name would
    // be a second spelling of one truth with no owner; these differ in what they do.
    const calls: unknown[] = [];
    bindZustandTool({
      name: 'customers.set_filters',
      description: 'Sets customer filters.',
      action: (input) => calls.push(input),
    });

    await handlerOf()({ status: 'active' }, settled);

    expect(calls).toEqual([{ status: 'active' }]);
  });
});

describe('the router adapter', () => {
  it('navigates through the application own navigate, via a path it builds', async () => {
    const went: string[] = [];
    bindNavigationTool({
      name: 'customers.open',
      description: 'Opens one customer.',
      navigate: (path) => went.push(path),
      toPath: (input) => `/customers/${String(input.customerId)}`,
    });

    await handlerOf()({ customerId: 'cus_123' }, settled);

    // The agent supplied an id, not a URL. It cannot construct an internal path — the router
    // adapter's preference for a domain identifier over a path expressed as a shape rather than as
    // advice (`docs/store-adapters.md`).
    expect(went).toEqual(['/customers/cus_123']);
  });

  it('applies URL-backed filters through the application own router', async () => {
    const applied: unknown[] = [];
    bindUrlFilterTool({
      name: 'customers.set_filters',
      description: 'Narrows the customer list.',
      applyToUrl: (input) => applied.push(input),
    });

    await handlerOf()({ status: 'active' }, settled);

    expect(applied).toEqual([{ status: 'active' }]);
  });

  it('declares navigation as an ordinary tool, consulting no capability of its own', async () => {
    // A tool expresses application intent, and the three levels of control are separate layers with
    // no fourth member. This file used to claim navigation was separately capability-gated;
    // CAPABILITY_MEMBER is application | dom | evaluate and nothing else, so the claim described a
    // gate that never existed. A tool declared here is Level 1 like any other.
    bindNavigationTool({
      name: 'navigation.go',
      description: 'Navigates within the application.',
      navigate: () => undefined,
      toPath: (input) => String(input.path),
    });

    const entry = declared()[0];
    expect(entry?.definition.name).toBe('navigation.go');
    // No capability, level or authority field anywhere on what an adapter declares.
    expect(Object.keys(entry?.definition ?? {})).not.toContain('capability');
    expect(Object.keys(entry?.definition ?? {})).not.toContain('level');
  });
});

describe('an async action', () => {
  it('finishes BEFORE the tool reports anything', async () => {
    // A store action that awaits a request before it mutates is ordinary. Typed `void`, its promise
    // would be discarded and the tool would report success while the mutation had not happened — the
    // same false success the `afterRender()` await exists to prevent, arriving one step earlier.
    const order: string[] = [];
    bindZustandTool({
      name: 'customers.sync',
      description: 'Syncs customers.',
      action: async () => {
        await Promise.resolve();
        order.push('mutated');
      },
      selectResult: () => {
        order.push('selected');
        return { synced: true };
      },
    });

    const result = await handlerOf()(
      {},
      {
        signal: new AbortController().signal,
        afterRender: () => {
          order.push('committed');
          return Promise.resolve();
        },
      },
    );

    expect(order).toEqual(['mutated', 'committed', 'selected']);
    expect(result).toEqual({ synced: true });
  });

  it('turns a rejecting action into a failed call, not an unhandled rejection', async () => {
    bindZustandTool({
      name: 'customers.sync',
      description: 'Syncs customers.',
      action: () => Promise.reject(new Error('the sync endpoint refused')),
    });

    await expect(handlerOf()({}, settled)).rejects.toThrow('the sync endpoint refused');
  });

  it('awaits a middleware-wrapped Redux dispatch that returns a promise', async () => {
    // Thunks, sagas and RTK Query all make `dispatch` return something awaitable. Discarding it would
    // make "the call resolves after the application accepted the mutation" true only for synchronous
    // actions — which is the majority case and therefore the one that hides the defect.
    const order: string[] = [];
    bindReduxTool({
      name: 'customers.refresh',
      description: 'Refreshes customers.',
      dispatch: async () => {
        await Promise.resolve();
        order.push('dispatched');
      },
      action: (input) => input,
      selectResult: () => {
        order.push('selected');
        return { refreshed: true };
      },
    });

    await handlerOf()({}, settled);

    expect(order).toEqual(['dispatched', 'selected']);
  });
});
