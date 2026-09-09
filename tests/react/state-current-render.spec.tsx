import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpState } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import {
  clearRegistry,
  enterSecureContext,
  neverConnects,
  nextTask,
  registeredNames,
  testValidator,
  until,
} from './harness.ts';

// **The failure this file exists for is invisible, and that is the whole reason it is its own file.**
//
// A state read that answers from the render which REGISTERED the tool, rather than the current one,
// does not look like a bug from any angle a test usually takes. The call succeeds. The shape is
// right. The schema validates. Structured content is emitted. The only thing wrong is the values —
// and a wrong filter value looks exactly like a filter value.
//
// It is invariant #2 of the five this repository lists as breaking silently, and a state surface is
// where it is hardest to notice, because a mutating tool at least reports what it applied while a
// read reports only what it claims to have found.
//
// **What makes a case here able to see it**, stated because the obvious spelling cannot:
//
//   - It must rerender with a DIFFERENT value between the two reads. A case that rerenders without
//     changing the value passes with the mechanism deleted, because both renders' closures return the
//     same thing.
//   - It must rerender MANY times, not once. A single rerender can pass by accident if the stale
//     value happens to be one render behind rather than pinned to the registering render.
//   - It must read through the REGISTRY, the way a caller does, rather than by invoking the
//     application's own `getState` — which would test the component and not the binding.
//
// The break-it for this is recorded in the feature's research.md: replace the handler ref with the
// render-scoped closure and confirm this file goes RED. If it does not, this file is not testing what
// it claims and this file is what needs fixing.

const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, generation: { type: 'number' } },
  required: ['query', 'generation'],
} as const;

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(clearRegistry);

/** Reads a state tool the way a caller does — through the registry, never through the component. */
async function readState(name: string): Promise<Record<string, unknown>> {
  const registry = (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  if (registry === undefined) throw new Error('the document has no registry');
  const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
    .executeToolByName;
  const result = await invoke.call(registry, name, JSON.stringify({}), undefined, true);
  // **The registry hands back a JSON STRING of a result envelope, not an object** — measured rather
  // than assumed, because reading it as an object silently yields `undefined` for every field and a
  // case then compares nothing against nothing.
  const shaped = (typeof result === 'string' ? JSON.parse(result) : result) as {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: Record<string, unknown>;
  };
  if (shaped.isError === true) throw new Error(`the read was refused: ${JSON.stringify(result)}`);
  // **The structured channel is preferred, and its absence is a failure rather than a fallback.** A
  // state surface always declares a schema, so the structured content the result contract defines is
  // always populated; quietly falling back to the text rendering would let a case pass while the two
  // channels disagreed, which is the one discrepancy that contract exists to make impossible
  // (docs/design.md#tool-results).
  if (shaped.structuredContent === undefined) {
    throw new Error(`a state read carried no structured content: ${JSON.stringify(shaped)}`);
  }
  return shaped.structuredContent;
}

function Surface({ query, generation }: { query: string; generation: number }): React.ReactNode {
  useMcpState({
    name: 'customers',
    description: 'the current customer query',
    schema: SCHEMA as unknown as Record<string, unknown>,
    // A NEW closure on every render, over render-scoped values. This is the ordinary way an
    // application writes it, and it is what makes the ref necessary rather than optional.
    getState: () => ({ query, generation }),
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

describe('a state read after many rerenders', () => {
  it('answers from the CURRENT render, not the one that registered the tool', async () => {
    const view = render(
      <Host>
        <Surface query="initial" generation={0} />
      </Host>,
    );
    await act(async () => {
      await until(async () => (await registeredNames()).length > 0, 'waited for registration');
    });

    const first = await readState('customers.get_state');
    expect(first).toEqual({ query: 'initial', generation: 0 });

    // Twelve rerenders, each with a different value, where at least ten are asked for. Every one of
    // these produces a new `getState` closure, and every one of them must be reachable by a later
    // call without the registry being touched.
    for (let generation = 1; generation <= 12; generation += 1) {
      view.rerender(
        <Host>
          <Surface query={`typed-${generation}`} generation={generation} />
        </Host>,
      );
      await act(async () => {
        await Promise.resolve();
      });
    }

    const second = await readState('customers.get_state');

    // The assertion that fails when the ref is gone. With the render-scoped closure this reads
    // `{ query: 'initial', generation: 0 }` — a complete, well-shaped, schema-valid, entirely wrong
    // answer.
    expect(second).toEqual({ query: 'typed-12', generation: 12 });
  });

  it('is current for a call arriving in a LATER task, which is how every agent call arrives', async () => {
    // An agent's call arrives as a socket message, which is its own task. A binding that updated its
    // handler in a passive effect would be correct under `act()` and wrong in a browser — the window
    // this closes does not exist inside `act()`, which is why the update is a layout effect.
    const view = render(
      <Host>
        <Surface query="first" generation={1} />
      </Host>,
    );
    await act(async () => {
      await until(async () => (await registeredNames()).length > 0, 'waited for registration');
    });

    view.rerender(
      <Host>
        <Surface query="second" generation={2} />
      </Host>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await nextTask();

    expect(await readState('customers.get_state')).toEqual({ query: 'second', generation: 2 });
  });

  it('reads the current value even though the registry was never touched by those rerenders', async () => {
    // The two halves of this feature's central claim asserted together, because they are in tension
    // and a wrong fix for one breaks the other: re-registering on every render WOULD keep the handler
    // current, and it is exactly the storm the descriptor comparison exists to prevent. Currency
    // without churn is the requirement; either one alone is a defect.
    const view = render(
      <Host>
        <Surface query="a" generation={1} />
      </Host>,
    );
    await act(async () => {
      await until(async () => (await registeredNames()).length > 0, 'waited for registration');
    });

    const namesBefore = await registeredNames();

    for (let generation = 2; generation <= 11; generation += 1) {
      view.rerender(
        <Host>
          <Surface query={`value-${generation}`} generation={generation} />
        </Host>,
      );
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(await registeredNames()).toEqual(namesBefore);
    expect(await readState('customers.get_state')).toEqual({ query: 'value-11', generation: 11 });
  });
});
