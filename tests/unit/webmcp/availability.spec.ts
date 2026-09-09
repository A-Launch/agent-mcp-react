// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY_UNAVAILABLE } from '../../../src/webmcp/errors.ts';
import { ensureRegistry, resetResolutionForTests } from '../../../src/webmcp/registry.ts';
import {
  clearRegistryHosts,
  createStubRegistry,
  enterInsecureContext,
  enterSecureContext,
  enterUnknownContext,
  placeOnDocument,
  placeOnNavigatorOnly,
  readCanonicalHost,
  suppressCanonicalInstallation,
} from './harness.ts';

// The failure story, which is what stops the portability claim from being a trap.
//
// A boundary that works when the registry is available and does something unclear when it is not is
// this project's characteristic defect wearing a different hat: the page looks like an application
// that instrumented nothing, and an operator spends the afternoon reading the wrong code.
//
// Every case here asserts two things — the cause is *this* one and not a neighbouring one, and nothing
// usable came back.

beforeEach(() => {
  resetResolutionForTests();
  clearRegistryHosts();
  enterSecureContext();
});

afterEach(() => {
  resetResolutionForTests();
  clearRegistryHosts();
  enterSecureContext();
});

/** Runs resolution and returns whatever it produced, so a case can assert on either outcome. */
async function attempt(): Promise<{ code?: string | undefined; value?: unknown }> {
  try {
    return { value: await ensureRegistry() };
  } catch (error) {
    return { code: (error as { code?: string }).code };
  }
}

describe('each cause is reported as itself', () => {
  it('reports an insecure context, which an operator can fix', async () => {
    enterInsecureContext();

    const outcome = await attempt();

    expect(outcome.code).toBe(REGISTRY_UNAVAILABLE.insecureContext);
    expect(outcome.value).toBeUndefined();
  });

  it('reports an environment that cannot say whether it is secure', async () => {
    // Not the same as "insecure", and deliberately not treated as permission to proceed. Silence is
    // not a secure context; assuming it is would be a check that never says no.
    enterUnknownContext();

    const outcome = await attempt();

    expect(outcome.code).toBe(REGISTRY_UNAVAILABLE.insecureContext);
    expect(outcome.value).toBeUndefined();
  });

  it('reports diverging host objects separately from an unexplained failure', async () => {
    placeOnDocument(createStubRegistry());
    placeOnNavigatorOnly(createStubRegistry());

    const outcome = await attempt();

    // The distinction is the whole point. "Installation refused" would send an operator to look for an
    // installation problem when a platform guarantee is what actually broke.
    expect(outcome.code).toBe(REGISTRY_UNAVAILABLE.hostsDiverged);
    expect(outcome.code).not.toBe(REGISTRY_UNAVAILABLE.installationRefused);
  });

  it('reports an unexplained installation failure as unknown', async () => {
    // The layer runs and produces nothing reachable. There is no better answer than "unknown", and
    // manufacturing one — the nearest plausible cause — would be worse than admitting it.
    const suppression = suppressCanonicalInstallation();

    try {
      const outcome = await attempt();
      expect(suppression.wasAttempted()).toBe(true);
      expect(outcome.code).toBe(REGISTRY_UNAVAILABLE.installationRefused);
      expect(outcome.value).toBeUndefined();
    } finally {
      suppression.restore();
    }
  });
});

describe('no failure yields anything a caller could proceed from', () => {
  it('produces no registry, no listing and no partial state', async () => {
    enterInsecureContext();

    const outcome = await attempt();

    // Measured as the absence of a usable value, not as the presence of an error. A boundary that
    // threw *and* left a half-installed registry behind would pass an error-shaped assertion.
    expect(outcome.value).toBeUndefined();
    expect(readCanonicalHost()).toBeUndefined();
  });

  it('does not leave the failed attempt cached, so a fixed environment recovers', async () => {
    enterInsecureContext();
    expect((await attempt()).code).toBe(REGISTRY_UNAVAILABLE.insecureContext);

    enterSecureContext();

    const recovered = await attempt();
    expect(recovered.code).toBeUndefined();
    expect(recovered.value).toBeDefined();
  });
});
