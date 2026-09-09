import { describe, expect, it } from 'vitest';
import { REGISTRY_UNAVAILABLE } from '../../../src/webmcp/errors.ts';

// The server-side-rendering boundary, in the `unit` project's default `node` environment.
//
// **This file deliberately carries no `@vitest-environment` docblock.** That absence is the assertion:
// every other case in this directory declares a DOM, and this one runs where there genuinely is not
// one. Simulating "no document" inside jsdom would be simulating the thing under test.

describe('the boundary under server-side rendering', () => {
  it('imports without touching a document and without throwing', async () => {
    // The portability layer initializes itself when its module evaluates. It guards on `window` and
    // `document`, so it is inert here — but the guard is the layer's, not ours, and this case is what
    // notices if a future version drops it or if this module starts importing it statically.
    const boundary = await import('../../../src/webmcp/index.ts');

    expect(typeof boundary.ensureRegistry).toBe('function');
    expect(typeof globalThis.document).toBe('undefined');
  });

  it('reports the absence of a document as its own cause, not as a failure to install', async () => {
    const { ensureRegistry } = await import('../../../src/webmcp/registry.ts');

    const code = await ensureRegistry().then(
      () => undefined,
      (error: unknown) => (error as { code?: string }).code,
    );

    // Rendering on a server is a supported state. The provider renders, registers nothing, opens
    // nothing, and the browser phase does the rest — so this must be distinguishable from every cause
    // that means something is actually wrong.
    expect(code).toBe(REGISTRY_UNAVAILABLE.noDocument);
    expect(code).not.toBe(REGISTRY_UNAVAILABLE.installationRefused);
  });
});
