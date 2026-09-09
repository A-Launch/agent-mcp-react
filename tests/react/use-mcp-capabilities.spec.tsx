import { render } from '@testing-library/react';
import { memo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentCapabilities,
  AgentMcpProvider,
  useMcpCapabilities,
  useMcpTool,
} from '../../src/index.ts';
import { APPLICATION_ONLY, NOTHING_GRANTED } from '../support/capabilities.ts';
import { clearRegistry, enterSecureContext, neverConnects } from './harness.ts';

// `useMcpCapabilities`: what an application is allowed to know about the agent above it.
//
// **A reading, never a gate — and the cases are shaped by that distinction.** Nothing here asserts
// that the hook refuses anything, because it refuses nothing: the capability gate runs in the runtime
// before every handler, on both call routes, and it does so whether or not any component ever calls
// this hook. What the hook is for is the honest UI — showing what the agent can do, explaining a
// refusal, disabling an affordance that would only fail.
//
// Two claims here cost something and are the reason the file exists:
//
//   - **Publishing the connection's authority must not become a way to WIDEN it.** The runtime reads
//     the granted set live at every check, so the object this hook hands out is the object the gate
//     consults. It is frozen at its source; a case writes to it and asserts nothing moved.
//   - **A component that declares a tool must not rerender because a profile changed.** That is what
//     the separate context buys, and a merged context would satisfy every value assertion here while
//     quietly rerendering every tool in the tree on each capability change.

beforeEach(() => {
  enterSecureContext();
  clearRegistry();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  clearRegistry();
});

/** A provider that never reaches a socket — none of these cases is about the connection. */
function mount(capabilities: AgentCapabilities, children: ReactNode) {
  return render(
    <AgentMcpProvider
      capabilities={capabilities}
      connection={{ getUrl: neverConnects }}
      server={{ name: 'page-under-test', version: '0.0.0' }}
      onUnexpectedState={() => undefined}
    >
      {children}
    </AgentMcpProvider>,
  );
}

/** Reports what the hook returned, and how many times this component rendered. */
function Readout({ seen }: { seen: { value?: AgentCapabilities; renders: number } }): ReactNode {
  const capabilities = useMcpCapabilities();
  seen.value = capabilities;
  seen.renders += 1;
  return null;
}

describe('what the hook answers', () => {
  it('reports the set the operator granted', () => {
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    mount(
      { application: true, dom: { inspect: true, interact: false }, evaluate: false },
      <Readout seen={seen} />,
    );

    expect(seen.value).toEqual({
      application: true,
      dom: { inspect: true, interact: false },
      evaluate: false,
    });
  });

  it('denies everything with no provider above it, which is the true answer rather than a default', () => {
    // No provider means no connection and no agent, so nothing is reachable. Deliberately not a
    // refusal like `useMcpTool`'s: a tool declared with no provider is a lie an author must be stopped
    // on, while a capability READING with no provider is simply correct.
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    render(<Readout seen={seen} />);

    expect(seen.value).toEqual(NOTHING_GRANTED);
  });

  it('reports what the GATE is enforcing when the set could not be understood', () => {
    // Production, because development throws from the render. The provider denies everything in this
    // state and refuses to start; a hook that echoed the author's rejected set back would describe
    // authority the runtime is actively refusing — the hidden unknown the fail-loud rule forbids.
    vi.stubEnv('NODE_ENV', 'production');
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    mount(
      { application: true, wat: true } as unknown as AgentCapabilities,
      <Readout seen={seen} />,
    );

    expect(seen.value).toEqual(NOTHING_GRANTED);
  });

  it('follows a change of profile without a remount', () => {
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    const page = mount(APPLICATION_ONLY, <Readout seen={seen} />);
    expect(seen.value?.application).toBe(true);

    page.rerender(
      <AgentMcpProvider
        capabilities={NOTHING_GRANTED}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page-under-test', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <Readout seen={seen} />
      </AgentMcpProvider>,
    );

    expect(seen.value?.application).toBe(false);
  });
});

describe('publishing the set must not become a way to widen it', () => {
  it('hands out a frozen set, so an application cannot grant itself Level 3', () => {
    // **The case this file exists for.** The runtime reads the granted set LIVE at every capability
    // check, so the object handed out here is the object the gate consults — not a copy of it. Without
    // the freeze at its source, `capabilities.evaluate = true` in application code reaches Level 3
    // with no operator anywhere in the story, which is the one change whose blast radius is the whole
    // page.
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    mount(APPLICATION_ONLY, <Readout seen={seen} />);

    const published = seen.value as AgentCapabilities;
    expect(() => {
      (published as { evaluate: boolean }).evaluate = true;
    }).toThrow(TypeError);
    expect(published.evaluate).toBe(false);
  });

  it('freezes the DOM pair too, because each half is a capability in its own right', () => {
    // A shallow freeze passes the case above and leaves `dom.interact` writable — the half that lets
    // an agent ACT on the page rather than read it.
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    mount(
      { application: true, dom: { inspect: true, interact: false }, evaluate: false },
      <Readout seen={seen} />,
    );

    const published = seen.value as AgentCapabilities;
    expect(() => {
      (published.dom as { interact: boolean }).interact = true;
    }).toThrow(TypeError);
    expect(published.dom.interact).toBe(false);
  });
});

describe('what reading capabilities costs the rest of the tree', () => {
  it('does not rerender a memoized component that only declares a tool', () => {
    // **The claim the separate context buys.** `memo` is what makes this measurable: React skips a
    // memoized subtree whose props did not change, so the ONLY thing that can still rerender it is a
    // context it subscribes to. Without it the provider rerenders its children regardless and the
    // count moves for reasons that have nothing to do with capabilities — which is how the first
    // version of this case asserted `>= before` and was true no matter what the code did.
    const declared = { renders: 0 };
    const Tool = memo(function Tool(): ReactNode {
      declared.renders += 1;
      useMcpTool({
        name: 'invoice.mark_paid',
        description: 'Mark the open invoice as paid.',
        inputSchema: { type: 'object', properties: {} },
        handler: () => ({ paid: true }),
      });
      return null;
    });

    const tree = (capabilities: AgentCapabilities): ReactNode => (
      <AgentMcpProvider
        capabilities={capabilities}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page-under-test', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <Tool />
      </AgentMcpProvider>
    );

    const page = render(tree(APPLICATION_ONLY));
    const before = declared.renders;

    // A capability change, and nothing else.
    page.rerender(tree(NOTHING_GRANTED));

    expect(declared.renders).toBe(before);
  });

  it('DOES rerender a memoized component that reads capabilities, which is what makes the case above mean something', () => {
    // The pairing. Without it, a hook wired to a context nothing ever publishes to satisfies the case
    // above perfectly — and would never tell an application that a profile changed.
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    const Reader = memo(function Reader(): ReactNode {
      return <Readout seen={seen} />;
    });

    const tree = (capabilities: AgentCapabilities): ReactNode => (
      <AgentMcpProvider
        capabilities={capabilities}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page-under-test', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <Reader />
      </AgentMcpProvider>
    );

    const page = render(tree(APPLICATION_ONLY));
    const before = seen.renders;

    page.rerender(tree(NOTHING_GRANTED));

    expect(seen.renders).toBeGreaterThan(before);
    expect(seen.value?.application).toBe(false);
  });

  it('holds the published set stable across a rerender that did not change it', () => {
    // `normalizeCapabilities` builds a new object every render, so publishing it directly would give
    // every consumer a new value on every provider render — including every render the connection
    // state causes, which has nothing to do with capabilities.
    const seen = { renders: 0 } as { value?: AgentCapabilities; renders: number };
    const tree = (capabilities: AgentCapabilities): ReactNode => (
      <AgentMcpProvider
        capabilities={capabilities}
        connection={{ getUrl: neverConnects }}
        server={{ name: 'page-under-test', version: '0.0.0' }}
        onUnexpectedState={() => undefined}
      >
        <Readout seen={seen} />
      </AgentMcpProvider>
    );

    const page = render(tree(APPLICATION_ONLY));
    const first = seen.value;

    // A NEW object with the same content, exactly as `capabilities={{ ... }}` written inline produces.
    page.rerender(
      tree({ application: true, dom: { inspect: false, interact: false }, evaluate: false }),
    );

    expect(seen.value).toBe(first);
  });
});
