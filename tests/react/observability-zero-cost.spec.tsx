// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMcpProvider, useMcpTool } from '../../src/react/index.ts';
import { currentCallId } from '../../src/runtime/call-record.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import { clearRegistry, enterSecureContext } from './harness.ts';

// **An application that asks for no observability pays nothing.**
//
// Claimed in the spec, in the provider's own prop documentation and in `docs/observing-tool-calls.md`
// — and it was FALSE until a review found it. The bus builds no record when it has no subscribers,
// which is the mechanism the claim rests on; but the provider subscribed unconditionally in order to
// route events to possibly-absent props. So the bus always had a subscriber, always built a record,
// and the zero-cost path existed only in the documentation.
//
// Nothing else could have caught it: the surface behaves identically either way. The only observable
// difference is whether a call ordinal was consumed, which is what this case measures.

afterEach(() => {
  clearRegistry();
});

const DEAD_PORT = 'ws://127.0.0.1:1/';

function Tool(): ReactNode {
  useMcpTool({
    name: 'panel.set',
    description: 'Takes a value.',
    handler: (input) => ({ echoed: String(input.value) }),
  });
  return null;
}

async function invokeThroughRegistry(name: string, args: Record<string, unknown>): Promise<void> {
  const registryOf = () =>
    (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
  for (let turn = 0; turn < 200 && registryOf() === undefined; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const registry = registryOf();
  if (registry === undefined) throw new Error('the document never got a registry');
  const listed = async () =>
    ((await (registry as { getTools(): Promise<{ name: string }[]> }).getTools()) ?? []).some(
      (tool) => tool.name === name,
    );
  for (let turn = 0; turn < 200 && !(await listed()); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await (registry as { executeToolByName(...a: unknown[]): Promise<unknown> }).executeToolByName
    .call(registry, name, JSON.stringify(args), undefined, true)
    .catch(() => undefined);
}

describe('with no observer and no inspector', () => {
  it('builds no record — measured on the ordinal, not read off the source', async () => {
    enterSecureContext();
    const { unmount } = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'zero-cost', version: '0.0.0' }}
        onUnexpectedState={() => {}}
      >
        <Tool />
      </AgentMcpProvider>,
    );

    // The counter is module-scoped and monotonic, so it is the one thing that can distinguish "no
    // record was built" from "a record was built and nobody read it". An assertion on the callbacks
    // could not: there are none to observe.
    const before = currentCallId();
    await invokeThroughRegistry('panel.set', { value: 'x' });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(currentCallId()).toBe(before);
    unmount();
  });

  it('DOES build one as soon as a single callback is supplied', async () => {
    // The positive half, and it is not decoration: a counter that never advanced would satisfy the
    // case above perfectly while meaning the surface was broken.
    enterSecureContext();
    const seen: unknown[] = [];
    const { unmount } = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'zero-cost', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        onToolCall={(event) => seen.push(event)}
      >
        <Tool />
      </AgentMcpProvider>,
    );

    const before = currentCallId();
    await invokeThroughRegistry('panel.set', { value: 'x' });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(currentCallId()).toBeGreaterThan(before);
    expect(seen.length).toBeGreaterThan(0);
    unmount();
  });
});

describe('a callback supplied after the provider mounted', () => {
  it('starts observing, and does not half-report a call that began before it', async () => {
    // **The risk the conditional subscription introduces**, checked rather than assumed. Gating the
    // subscription on "is any callback supplied" means the subscription comes and goes with the
    // props — so the question is whether a call spanning that change can produce half a pair.
    //
    // It cannot, and the reason is the epoch already in the bus: a subscriber receives only calls that
    // BEGAN after it attached. A call that started unobserved opened no observation at all, so there
    // is no terminal to arrive orphaned; a call that started observed and lost its subscriber mid-flight
    // is the deliberate case.
    enterSecureContext();
    const seen: { phase: string; callId: number }[] = [];

    function Harness({ observing }: { observing: boolean }): ReactNode {
      return (
        <AgentMcpProvider
          capabilities={APPLICATION_ONLY}
          connection={{ getUrl: () => DEAD_PORT }}
          server={{ name: 'late-observer', version: '0.0.0' }}
          onUnexpectedState={() => {}}
          {...(observing
            ? {
                onToolCall: (event: { phase: string; callId: number }) => seen.push(event),
                onToolResult: (event: { phase: string; callId: number }) => seen.push(event),
                onToolError: (event: { phase: string; callId: number }) => seen.push(event),
              }
            : {})}
        >
          <Tool />
        </AgentMcpProvider>
      );
    }

    const { rerender, unmount } = render(<Harness observing={false} />);

    // Unobserved: no record, so nothing to be half of.
    await invokeThroughRegistry('panel.set', { value: 'before' });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(seen).toEqual([]);

    // The application starts caring.
    rerender(<Harness observing />);
    await invokeThroughRegistry('panel.set', { value: 'after' });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // Exactly one complete pair, for the call that began while somebody was listening.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.phase).toBe('start');
    expect(seen[0]?.callId).toBe(seen[1]?.callId);

    unmount();
  });
});
