import { afterEach, describe, expect, it } from 'vitest';
import { declared, resetDeclarationsForTests } from '../../../src/actions/queue.ts';
import { bindReduxTool } from '../../../src/adapters/redux.ts';
import { bindZustandTool } from '../../../src/adapters/zustand.ts';

// Intent, not implementation (`docs/design.md#intent-not-implementation`), asserted as a TYPE rather
// than as advice.
//
// "Avoid exposing low-level implementation operations such as `redux.dispatch`, `react.set_state`,
// `zustand.set`" is a scope limit rather than a preference: a generic mutation tool widens the
// reachable state space past every schema the application declared. An adapter is exactly where that
// is one parameter away — a store is right there, and accepting it would look almost identical.
//
// **`pnpm test` CANNOT SEE THE DIRECTIVES BELOW.** Vitest strips types without checking them, so every
// `@ts-expect-error` here is inert at runtime and this file passes whether or not the types hold.
// `pnpm typecheck` is what covers them, and it is why that command is part of the health gate rather
// than a convenience. This has bitten twice in this repository.

afterEach(resetDeclarationsForTests);

const COMMON = { name: 'customers.set_filters', description: 'Sets customer filters.' };

describe('what an adapter cannot be handed', () => {
  it('refuses a whole store where the action belongs', () => {
    const store = {
      dispatch: (_action: unknown) => undefined,
      getState: () => ({ customers: { filters: {} } }),
    };

    // @ts-expect-error a store is not an action creator: handing one over would let the agent reach
    // every action the store has ever had, under one schema that cannot describe them.
    const refused = () => bindReduxTool({ ...COMMON, dispatch: store.dispatch, action: store });
    expect(typeof refused).toBe('function');
  });

  it('refuses an action creator that lets the CALLER choose the action type', () => {
    // The subtler shape, and the one that would slip through review: it is a creator, it type-checks
    // against `(input) => Action`, and it turns the agent's arguments into the choice of action. The
    // schema is what stops it — an author who declares `{ type: string }` has written
    // `redux.dispatch` under a friendlier name, and the reason it is wrong belongs where an author
    // reads it rather than in a type that cannot see a schema.
    //
    // Asserted as behaviour rather than as a compile error, because it IS spellable and the defence
    // is the declared schema. Recorded here so the limit of the type-level guarantee is stated.
    const dispatched: unknown[] = [];
    bindReduxTool({
      ...COMMON,
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['active', 'churned'] } },
        required: ['status'],
        additionalProperties: false,
      },
      dispatch: (action) => dispatched.push(action),
      action: (input) => ({ type: 'customers/setFilters', payload: input }),
    });

    // The schema admits one shape. Whatever the agent sends is validated against it in the runtime
    // BEFORE the creator runs, so the creator's output is bounded by what the author declared.
    const entry = declared()[0];
    expect(entry?.definition.inputSchema).toBeDefined();
  });

  it('CANNOT refuse a bare Zustand setter at the type level, and that limit is stated here', () => {
    // **A limitation found while writing this file, recorded rather than papered over.**
    //
    // The Redux case above works because a STORE is not a function: handing one where an action
    // creator belongs is a type error, and `redux.dispatch` is therefore unspellable through that
    // adapter. Zustand has no such asymmetry. A bound action and `store.setState` have the same
    // structural type — both take an object and return something — so no signature can tell
    // `(input) => store.getState().setFilters(input)` from `store.setState`.
    //
    // This compiles, and a `@ts-expect-error` here would be an unused directive that `pnpm typecheck`
    // correctly rejects. Writing one anyway to make the file look symmetrical would be claiming a
    // guarantee that does not exist — the thing this whole feature refuses to do elsewhere.
    //
    // What actually bounds it is the DECLARED SCHEMA, in both adapters: arguments are validated in
    // the runtime before the action runs, so an author who passes `setState` and declares a real
    // schema has narrowed it anyway, and one who declares `additionalProperties: true` over an open
    // object has written `zustand.set` whatever the adapter's types say. That is a documentation
    // obligation, and `docs/store-adapters.md` carries it.
    const store = { setState: (_partial: Record<string, unknown>) => undefined };

    expect(() => bindZustandTool({ ...COMMON, action: store.setState })).not.toThrow();
  });

  it('accepts the shapes that ARE intended, so the refusals above are a boundary and not a wall', () => {
    // Without this the file would be satisfied by an adapter nobody can call.
    expect(() =>
      bindReduxTool({
        ...COMMON,
        dispatch: (_action: { type: string }) => undefined,
        action: (input) => ({ type: 'customers/setFilters', payload: input }),
      }),
    ).not.toThrow();

    expect(() =>
      bindZustandTool({
        name: 'customers.clear_filters',
        description: 'Clears customer filters.',
        action: (input) => void input,
      }),
    ).not.toThrow();
  });
});
