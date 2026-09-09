// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OBSERVED_PAYLOADS } from '../../src/index.ts';
import { APPLICATION_ONLY } from '../support/capabilities.ts';
import { clearRegistry, enterSecureContext } from './harness.ts';

// **The development global is metadata-only in EVERY configuration**, including when the provider's
// hooks were explicitly opted into carrying values.
//
// The two are different boundaries and only one of them is narrow. A provider callback is the
// application's own code. `window.__AGENT_MCP__` is readable by ANY script on the page — a widget, a
// browser extension, anything a page happens to be running — so putting values there would be a
// disclosure to exactly the untrusted page code the shared registry already forces this library to
// reason about. And a call refused before the handler ran never reached the application at all, so its
// arguments would be a first disclosure rather than an echo of something already held.

afterEach(() => {
  clearRegistry();
  delete (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__;
  vi.unstubAllEnvs();
});

const DEAD_PORT = 'ws://127.0.0.1:1/';
const CANARY = 'canary-value-c41f8b02de';

async function developmentLibrary() {
  // `NODE_ENV=test` under this runner reads as NOT development by design, so the channel would never
  // install and the case could conclude nothing. See tests/react/observability-inspector.spec.tsx.
  vi.stubEnv('NODE_ENV', 'development');
  vi.resetModules();
  return import('../../src/react/index.ts');
}

describe('the global, with the hooks opted into values', () => {
  it('installs a channel that carries no argument or result value', async () => {
    const { AgentMcpProvider, useMcpTool } = await developmentLibrary();

    function Tool(): ReactNode {
      useMcpTool({
        name: 'panel.set',
        description: 'Takes a value.',
        handler: (input) => ({ echoed: String(input.value) }),
      });
      return null;
    }

    enterSecureContext();
    const seenByGlobal: unknown[] = [];
    const seenByHook: unknown[] = [];

    const { unmount } = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'global', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        // The application asked for values on ITS OWN callbacks. The global must not follow.
        observability={{ payloads: OBSERVED_PAYLOADS.values }}
        devtools={{ enabled: true }}
        onToolCall={(event) => seenByHook.push(event)}
        onToolResult={(event) => seenByHook.push(event)}
      >
        <Tool />
      </AgentMcpProvider>,
    );

    const channel = (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__ as {
      subscribe(sink: (event: unknown) => void): () => void;
    };
    channel.subscribe((event) => seenByGlobal.push(event));

    // Invoke through the document's registry — no socket needed, and it is a real call on the route a
    // page script uses. Registration happens in an effect and the provider's mount is asynchronous, so
    // this waits for the tool to actually exist rather than assuming a render implies a registration.
    const registryOf = () =>
      (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
    for (let turn = 0; turn < 200 && registryOf() === undefined; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const registry = registryOf();
    if (registry === undefined) throw new Error('the document never got a registry');
    const listed = async () =>
      ((await (registry as { getTools(): Promise<{ name: string }[]> }).getTools()) ?? []).some(
        (tool) => tool.name === 'panel.set',
      );
    for (let turn = 0; turn < 200 && !(await listed()); turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const invoke = (registry as { executeToolByName(...a: unknown[]): Promise<unknown> })
      .executeToolByName;
    await invoke
      .call(registry, 'panel.set', JSON.stringify({ value: CANARY }), undefined, true)
      .catch(() => undefined);

    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // The hooks got what the application asked for.
    expect(JSON.stringify(seenByHook)).toContain(CANARY);
    // The global did not, and its records are not empty either — so this is a redaction, not a
    // subscription that never fired.
    expect(seenByGlobal.length).toBeGreaterThan(0);
    expect(JSON.stringify(seenByGlobal)).not.toContain(CANARY);

    unmount();
  });

  it('cannot be reached by an application callback MUTATING the record it was given', async () => {
    // **The sequence a review found, and the reason the record is now frozen all the way down.**
    //
    // One object reaches every subscriber. Under `values` an application callback legitimately sees
    // the arguments — so it could write a secret into a field the metadata-only channel IS allowed to
    // pass on (`event.name`), and the next subscriber would carry it to any script on the page. The
    // first shape of the global's projection was a rest-spread that dropped `arguments` and `result`,
    // which copies exactly such a mutation and would copy any future field by default.
    //
    // Two independent fixes, and this case holds both: the record is deep-frozen before delivery, so
    // the mutation cannot happen; and the global builds its own ALLOWLIST, so a field it does not
    // name cannot travel even if one did.
    const { AgentMcpProvider, useMcpTool } = await developmentLibrary();

    function Tool(): ReactNode {
      useMcpTool({
        name: 'panel.set',
        description: 'Takes a value.',
        handler: (input) => ({ echoed: String(input.value) }),
      });
      return null;
    }

    enterSecureContext();
    const seenByGlobal: unknown[] = [];
    let mutationThrew = false;

    const { unmount } = render(
      <AgentMcpProvider
        capabilities={APPLICATION_ONLY}
        connection={{ getUrl: () => DEAD_PORT }}
        server={{ name: 'mutation', version: '0.0.0' }}
        onUnexpectedState={() => {}}
        observability={{ payloads: OBSERVED_PAYLOADS.values }}
        devtools={{ enabled: true }}
        onToolCall={(event) => {
          // A hostile — or merely careless — consumer, writing what it can see into what the other
          // channel is allowed to publish.
          try {
            (event as unknown as { name: string }).name = String(
              (event.arguments as { value?: unknown })?.value ?? '',
            );
          } catch {
            mutationThrew = true;
          }
        }}
      >
        <Tool />
      </AgentMcpProvider>,
    );

    const channel = (globalThis as unknown as Record<string, unknown>).__AGENT_MCP__ as {
      subscribe(sink: (event: unknown) => void): () => void;
    };
    channel.subscribe((event) => seenByGlobal.push(event));

    const registryOf = () =>
      (document as unknown as { modelContext?: Record<string, unknown> }).modelContext;
    for (let turn = 0; turn < 200 && registryOf() === undefined; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const registry = registryOf();
    if (registry === undefined) throw new Error('the document never got a registry');
    const listed = async () =>
      ((await (registry as { getTools(): Promise<{ name: string }[]> }).getTools()) ?? []).some(
        (tool) => tool.name === 'panel.set',
      );
    for (let turn = 0; turn < 200 && !(await listed()); turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await (registry as { executeToolByName(...a: unknown[]): Promise<unknown> }).executeToolByName
      .call(registry, 'panel.set', JSON.stringify({ value: CANARY }), undefined, true)
      .catch(() => undefined);

    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    // The mutation was refused by the freeze — in strict mode, which modules are, assigning to a
    // frozen property throws.
    expect(mutationThrew).toBe(true);
    // And nothing carrying the canary reached the page-readable channel by any route.
    expect(seenByGlobal.length).toBeGreaterThan(0);
    expect(JSON.stringify(seenByGlobal)).not.toContain(CANARY);

    unmount();
  });
});
