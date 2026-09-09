// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_UNAVAILABLE, WebMcpBoundaryError } from '../../../src/webmcp/errors.ts';
import { ensureRegistry, resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import {
  clearRegistryHosts,
  createStubRegistry,
  enterSecureContext,
  placeOnDocument,
  placeOnNavigatorOnly,
  readCanonicalHost,
} from './harness.ts';

// The portability claim, asserted directly: identical calls work whether or not the document already
// has a registry, and a caller can never tell which happened.
//
// This is US1, the reason the module exists. Everything else in this directory hardens it.

beforeEach(() => {
  resetResolutionForTests();
  clearRegistryHosts();
  enterSecureContext();
});

afterEach(() => {
  resetResolutionForTests();
  clearRegistryHosts();
});

describe('resolving the tool registry', () => {
  it('installs one where none exists', async () => {
    const resolved = await ensureRegistry();

    expect(resolved.provenance).toBe('installed');
    expect(typeof resolved.registry.registerTool).toBe('function');
    // Reachable at the canonical location, which is the postcondition every caller depends on without
    // ever naming the location itself.
    expect(readCanonicalHost()).toBe(resolved.registry);
  });

  it('returns the same registry on a second call, and installs nothing', async () => {
    const first = await ensureRegistry();
    const second = await ensureRegistry();

    expect(second.registry).toBe(first.registry);
    expect(second.provenance).toBe('installed');
  });

  it('leaves a registry that is already present untouched', async () => {
    const existing = createStubRegistry();
    placeOnDocument(existing);

    const resolved = await ensureRegistry();

    // Used unchanged: not wrapped, not proxied, not replaced. A wrapper would make the wrapper the
    // authority and the platform's registry a mirror.
    expect(resolved.registry).toBe(existing);
    expect(resolved.provenance).toBe('present');
    expect(readCanonicalHost()).toBe(existing);
  });

  it('works when the registry is offered only under the deprecated host object', async () => {
    const existing = createStubRegistry();
    placeOnNavigatorOnly(existing);

    const resolved = await ensureRegistry();

    // The requirement for the standard's deprecated host object (`docs/conformance.md`): the boundary
    // tolerates it, and no caller learns which host was involved —
    // the resolved value carries no trace of where it was found.
    expect(resolved.registry).toBe(existing);
    expect(Object.keys(resolved)).toEqual(expect.arrayContaining(['registry', 'provenance']));
    expect(JSON.stringify(Object.keys(resolved))).not.toContain('navigator');
  });

  it('fails with its own cause when the two host objects disagree', async () => {
    // The standard says the deprecated host resolves to the same instance wherever it exists. If it
    // does not, an assumption this entire module rests on is false — and an operator told
    // "installation refused" would go looking for an installation problem that is not there.
    placeOnDocument(createStubRegistry());
    placeOnNavigatorOnly(createStubRegistry());

    await expect(ensureRegistry()).rejects.toMatchObject({
      code: REGISTRY_UNAVAILABLE.hostsDiverged,
    });
  });

  it('does not memoize a failed resolution', async () => {
    placeOnDocument(createStubRegistry());
    placeOnNavigatorOnly(createStubRegistry());
    await expect(ensureRegistry()).rejects.toBeInstanceOf(WebMcpBoundaryError);

    // A memo that survived a failure would make the condition unrecoverable for the life of the page,
    // and would report the second attempt as succeeding once the divergence was fixed only by luck.
    clearRegistryHosts();
    const recovered = createStubRegistry();
    placeOnDocument(recovered);

    await expect(ensureRegistry()).resolves.toMatchObject({ registry: recovered });
  });
});

describe('importing the module', () => {
  it('installs nothing until resolution is asked for', async () => {
    // The portability layer initializes itself when its module evaluates. This case is what holds the
    // dynamic import in place: convert it back to a static one and every other case here still
    // passes, because they all call `ensureRegistry()` anyway.
    const boundary = await import('../../../src/webmcp/index.ts');

    expect(typeof boundary.ensureRegistry).toBe('function');
    expect(readCanonicalHost()).toBeUndefined();
    expect(
      (globalThis as unknown as { __webMCPPolyfillOptions?: unknown }).__webMCPPolyfillOptions,
    ).toBeUndefined();
  });
});
