import { afterEach, describe, expect, it, vi } from 'vitest';

// The single owner of development-versus-production, and the two dialects it has to speak.
//
// It reads two flags because one of them does not exist where this library actually runs.
// `process.env.NODE_ENV` is the Node-shaped flag — a test runner, a server render, a bundler
// substituting into a production build. A browser dev server serves ESM to a page where `process` is
// not defined at all, so a library reading only that one answers "production" in every browser
// development session.
//
// That was measured, not reasoned about: a duplicate tool name in the example application, served by
// its own dev server, took the production path and reported to the operator instead of stopping the
// author. The development behaviour for a duplicate name — throw and name the source rather than
// reject the later registration quietly (`docs/design.md#duplicate-and-foreign-names`) — was
// unreachable in the one place it exists for.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function resolveWith(nodeEnv: string | undefined): Promise<boolean> {
  if (nodeEnv === undefined) {
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
  } else {
    vi.stubEnv('NODE_ENV', nodeEnv);
  }
  vi.resetModules();
  const { IS_DEVELOPMENT } = await import('../../src/build-mode.ts');
  return IS_DEVELOPMENT;
}

describe('an explicitly set NODE_ENV decides on its own', () => {
  it('is development only for exactly "development"', async () => {
    expect(await resolveWith('development')).toBe(true);
  });

  it('is production for "production"', async () => {
    expect(await resolveWith('production')).toBe(false);
  });

  it('is production for anything else, including a typo', async () => {
    // Explicitly `=== 'development'` rather than `!== 'production'`. The second reading treats a typo
    // and a bundler that inlined nothing as development, which is the direction that leaks.
    for (const value of ['test', 'staging', 'developement', 'DEVELOPMENT']) {
      expect(await resolveWith(value), `NODE_ENV=${value} must not read as development`).toBe(
        false,
      );
    }
  });

  it('treats an EMPTY value as not stated, and consults the other dialect', async () => {
    // An empty string is what an unset variable looks like once something has touched it, and it is
    // indistinguishable from absent to everything downstream. Treating it as a deliberate statement of
    // "not development" would make a browser page whose tooling emptied the variable silently
    // production — the failure this fallback exists to prevent, arriving by a different route.
    expect(await resolveWith('')).toBe(true);
  });

  it('wins over the bundler flag, so the production branch stays reachable under a dev-server runner', async () => {
    // This runner is Vite-based, so `import.meta.env.DEV` is true here and cannot be stubbed. Without
    // the precedence rule the production branch would be unreachable in every case in this repository
    // — which is where the production behaviour for a duplicate name has to be exercised.
    expect((import.meta as { env?: { DEV?: unknown } }).env?.DEV).toBe(true);
    expect(await resolveWith('production')).toBe(false);
  });
});

describe('with no NODE_ENV at all — a browser page from a dev server', () => {
  it('falls back to the bundler flag', async () => {
    // The dialect a browser speaks. `DEV` is true under this runner, which is what makes the fallback
    // observable at all; a case that could stub it would be testing the stub.
    expect(await resolveWith(undefined)).toBe(true);
  });
});
