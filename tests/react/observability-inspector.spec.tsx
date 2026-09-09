// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInspector } from '../../src/devtools/index.ts';
import type { AgentMcpProvider } from '../../src/react/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import { clearRegistry, enterSecureContext } from './harness.ts';

// The inspector: that it explains, and that it cannot act.
//
// **The read-only claim is the one that matters, and it is asserted at RUNTIME rather than by a type.**
// Authority only narrows: no devtool may widen what the provider's capabilities admit, so the
// inspector must not be able to invoke, enable or register anything the agent could not already
// reach. A `readonly` is a compile-time promise an `as` cast erases, and a module that holds a handle
// it promises not to use is the same hazard as a module that decides whether it may run. So the case
// below reaches for something callable through every property the handle exposes and finds nothing
// — which is a claim about the object, not about its declared type.

afterEach(() => {
  clearRegistry();
  delete (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__;
});

const DEAD_PORT = 'ws://127.0.0.1:1/';

describe('the handle the inspector hands back', () => {
  it('exposes nothing callable but dispose', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const inspector = createInspector({ host });

    // Every own and inherited property, walked. The only function reachable is `dispose`.
    const reachable: string[] = [];
    for (const key in inspector) reachable.push(key);
    reachable.push(...Object.getOwnPropertyNames(inspector));

    const callable = [...new Set(reachable)].filter(
      (key) => typeof (inspector as unknown as Record<string, unknown>)[key] === 'function',
    );
    expect(callable).toEqual(['dispose']);

    // And nothing on it leads to a runtime, a gateway, an ownership record or a tool handler — the
    // four things that would turn an observer into a participant.
    const values = Object.values(inspector as unknown as Record<string, unknown>);
    for (const value of values) {
      expect(typeof value === 'object' && value !== null).toBe(false);
    }
    inspector.dispose();
    host.remove();
  });

  it('ignores anything handed to it besides a host', () => {
    // **Corrected after a review.** The first version asserted `createInspector.length === 1`, which
    // proves nothing at all about the OPTIONS: adding a `runtime` field inside the same object leaves
    // the arity at one. What can actually be asserted is the behaviour — something smuggled in
    // alongside the host is not retained anywhere reachable.
    const host = document.createElement('div');
    document.body.append(host);
    const smuggled = { invoke: () => 'should never be reachable' };
    const inspector = createInspector({
      host,
      ...(smuggled as unknown as Record<string, never>),
    });

    const serialized = JSON.stringify(inspector, (_key, value) =>
      typeof value === 'function' ? '[function]' : value,
    );
    expect(serialized).not.toContain('invoke');
    for (const key of Object.keys(inspector as unknown as Record<string, unknown>)) {
      expect((inspector as unknown as Record<string, unknown>)[key]).not.toBe(smuggled.invoke);
    }
    inspector.dispose();
    host.remove();
  });
});

describe('with no channel installed', () => {
  it('renders an explanation instead of throwing', () => {
    const host = document.createElement('div');
    document.body.append(host);
    // A development affordance that took a page down when it was not switched on would be worse than
    // the absence it is reporting.
    const inspector = createInspector({ host });
    // **Read through the SHADOW ROOT, which is where the panel actually lives.** The library gives the
    // inspector its own root and its own stylesheet so it stays legible in a host with any CSS, or
    // none — a developer opens this precisely when the page is misbehaving. `host.textContent` is
    // empty by construction now, so asserting on it would be asserting on nothing.
    expect(host.shadowRoot?.textContent).toContain('No inspection channel');
    // Both conditions named, so a reader knows which one to change.
    expect(host.shadowRoot?.textContent).toContain('development build');
    expect(host.shadowRoot?.textContent).toContain('devtools=');
    inspector.dispose();
    host.remove();
  });

  it('leaves nothing rendered after dispose', () => {
    const host = document.createElement('div');
    document.body.append(host);
    createInspector({ host }).dispose();

    // **Asserted on the mount, not on `host.childNodes`.** That earlier assertion would now pass
    // without the panel disposing of anything at all: a shadow root is not a child node, so the host's
    // light-DOM child list is empty whether or not the panel is still on screen. A check that cannot
    // fail is worse than no check — it reports a disposal nobody performed.
    const mount = host.shadowRoot?.querySelector('.agent-mcp-inspector-mount');
    expect(mount).not.toBeNull();
    expect(mount?.childNodes).toHaveLength(0);
    expect(host.shadowRoot?.textContent).not.toContain('MCP Agent');
    host.remove();
  });

  it('reuses its root when an inspector is created on a host that had one', () => {
    // `attachShadow` throws on a host that already has a root, and disposing then re-creating on the
    // same element is an entirely reasonable thing for an application to do — a remount does it.
    const host = document.createElement('div');
    document.body.append(host);
    createInspector({ host }).dispose();
    const second = createInspector({ host });

    expect(host.shadowRoot?.textContent).toContain('No inspection channel');
    // One stylesheet, not one per inspector.
    expect(host.shadowRoot?.querySelectorAll('style')).toHaveLength(1);
    second.dispose();
    host.remove();
  });
});

describe('the development channel, under each build', () => {
  /**
   * Loads the library as the named build would have it.
   *
   * **Necessary, not ceremony.** This runner sets `NODE_ENV=test`, and `src/build-mode.ts` reads
   * `=== 'development'` on purpose — an unset flag, a typo, or a bundler that inlined nothing must not
   * read as development, because that is the direction that leaks. So under the suite's own conditions
   * the library is neither build, and a case that simply mounted a provider would find no channel and
   * could conclude nothing from its absence.
   */
  async function libraryBuiltFor(mode: 'development' | 'production') {
    vi.stubEnv('NODE_ENV', mode);
    vi.resetModules();
    return import('../../src/react/index.ts');
  }

  function mountWith(
    Provider: typeof AgentMcpProvider,
    devtools: { enabled: boolean } | undefined,
  ) {
    enterSecureContext();
    return render(
      <Provider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'inspector', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        {...(devtools === undefined ? {} : { devtools })}
      >
        {null}
      </Provider>,
    );
  }

  const channel = () => (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__;

  it('exists in exactly ONE of the four build-and-opt-in combinations', async () => {
    // The conjunction the design asks for (docs/observing-tool-calls.md), driven in full. Either
    // condition alone must not be enough: a
    // global that appeared because the build was development would be a debug surface an application
    // never asked for, and one that appeared because a flag was set would ship it to production.
    const development = await libraryBuiltFor('development');

    const off = mountWith(development.AgentMcpProvider, undefined);
    expect(channel()).toBeUndefined();
    off.unmount();

    const explicitlyOff = mountWith(development.AgentMcpProvider, { enabled: false });
    expect(channel()).toBeUndefined();
    explicitlyOff.unmount();

    const on = mountWith(development.AgentMcpProvider, { enabled: true });
    expect(channel()).toBeDefined();
    on.unmount();

    const production = await libraryBuiltFor('production');
    const askedButProduction = mountWith(production.AgentMcpProvider, { enabled: true });
    // The half that matters most: an application that left the flag on does not ship a debug channel.
    expect(channel()).toBeUndefined();
    askedButProduction.unmount();
  });

  it('is frozen, offers only a subscription and a snapshot, and is removed on unmount', async () => {
    const development = await libraryBuiltFor('development');
    const mounted = mountWith(development.AgentMcpProvider, { enabled: true });

    const installed = channel() as Record<string, unknown>;
    // Frozen at its source: unfrozen, a page script could replace `subscribe` and quietly intercept
    // everything the inspector sees.
    expect(Object.isFrozen(installed)).toBe(true);
    // Reading and watching, and nothing else. Every name here is a way to LEARN something; none of
    // them changes anything, because a devtool may never widen what the capabilities admit. The list
    // is exhaustive on purpose — a subset assertion
    // would let a command be added beside them without anything failing.
    const callable = Object.keys(installed).filter((key) => typeof installed[key] === 'function');
    expect(callable.sort()).toEqual(['snapshot', 'subscribe', 'subscribeSnapshot']);

    mounted.unmount();
    // A global outliving its provider would keep a torn-down subscription alive and report a
    // connection state nothing is maintaining.
    expect(channel()).toBeUndefined();
  });
});

describe('a second provider that will be refused', () => {
  it("does not overwrite or delete the live provider's channel", async () => {
    // **A review found this, and it is reachable through the second-provider case this library already
    // supports.** The channel is installed in a LAYOUT effect, but the document claim is not attempted
    // until the asynchronous startup that follows — so a second provider's layout effect ran first,
    // overwrote the live channel, was refused its claim, and then deleted the global on cleanup. The
    // working provider stayed connected with no channel and no way to reinstall one.
    //
    // Fixed by making the install claim-SHAPED: only into an empty slot, and remove only what we put
    // there. The existing second-provider cases never enabled devtools, so none of them could see it.
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();
    const { AgentMcpProvider: Provider } = await import('../../src/react/index.ts');

    const channel = () => (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__;

    enterSecureContext();
    const first = render(
      <Provider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'first', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        devtools={{ enabled: true }}
      >
        {null}
      </Provider>,
    );
    const original = channel();
    expect(original).toBeDefined();

    const second = render(
      <Provider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'second', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        devtools={{ enabled: true }}
      >
        {null}
      </Provider>,
    );

    // The live provider's channel is untouched — not replaced by the newcomer's.
    expect(channel()).toBe(original);

    second.unmount();
    // And still there after the newcomer leaves. This is the assertion that fails against a blind
    // `delete`: the first provider would be left connected and unobservable.
    expect(channel()).toBe(original);

    first.unmount();
    expect(channel()).toBeUndefined();
  });
});

describe('an inspector mounted the way an application mounts one', () => {
  /**
   * **Written because a live run found a defect every case above missed.**
   *
   * Those cases construct the inspector after the provider has mounted, which is convenient and is not
   * how anybody uses it. An application renders `<McpInspector />` INSIDE the provider — and React runs
   * effects child-before-parent, so the inspector's effect ran first, read no channel, rendered "no
   * inspection channel", and never looked again. The panel reported an absence while the channel was
   * demonstrably installed.
   *
   * The fix is the commit ORDER: the provider installs in a layout effect, so the sequence is
   * layout(child) → layout(parent) → passive(child) and the channel exists before any child looks.
   * This case holds that ordering, which is the thing that was actually wrong.
   */
  it('finds the channel even though its own effect runs first', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.resetModules();
    const { AgentMcpProvider: Provider } = await import('../../src/react/index.ts');
    const { createInspector: create } = await import('../../src/devtools/index.ts');

    function Panel(): React.ReactNode {
      const host = useRef<HTMLDivElement>(null);
      useEffect(() => {
        const element = host.current;
        if (element === null) return;
        const inspector = create({ host: element });
        return () => inspector.dispose();
      }, []);
      return <div data-testid="panel" ref={host} />;
    }

    enterSecureContext();
    const { getByTestId, unmount } = render(
      <Provider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'ordering', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        devtools={{ enabled: true }}
      >
        <Panel />
      </Provider>,
    );

    // The assertion that fails against a passive-effect installation. Read through the shadow root,
    // which is where the panel renders — the host's own light DOM is empty by construction.
    const panel = getByTestId('panel').shadowRoot;
    expect(panel?.textContent).not.toContain('No inspection channel');
    expect(panel?.textContent).toContain('Status:');
    unmount();
  });
});
