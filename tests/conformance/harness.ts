import type { ModelContext } from '@mcp-b/webmcp-types';
import { type ToolDeclaration, toDescriptor } from '../../src/webmcp/descriptor.ts';

// Shared setup for the conformance layer — the cases that pin the behaviour of ADOPTED packages.
//
// **This is a different harness from `tests/unit/webmcp/harness.ts`, and the difference is the point
// of the whole layer.** That one supplies a STUB registry so this library's boundary can be tested
// without the adopted package. These cases do the opposite: they initialize the REAL portability layer
// and assert what it does, because the rule this layer exists for is that "an adopted dependency's
// documentation describes what its authors intended, not what the version this project resolves
// actually does" (`docs/conformance.md`).
//
// A conformance case that used a stub would be testing the stub.

/**
 * Builds a descriptor **through this library's own builder**, rather than hand-rolling the shape.
 *
 * That is deliberate and it makes the cases say something better. A hand-written descriptor would pin
 * "a descriptor of roughly this shape is accepted"; going through `toDescriptor` pins "**the descriptor
 * this library actually sends** is accepted by the version of the registry this project resolves",
 * which is the reliance a conformance case is asking about: what this library actually depends on in
 * the resolved version of somebody else's package.
 *
 * It also removed four casts. The registry's `registerTool` is overloaded, and a hand-rolled object
 * needed an `as` at every call site — casts that would have silently kept compiling if the adopted
 * package changed the shape underneath them.
 */
export function descriptorFor(
  name: string,
  handler: (args: Record<string, unknown>) => unknown = () => 'ok',
): ReturnType<typeof toDescriptor> {
  const declaration: ToolDeclaration = {
    name,
    description: `the ${name} tool`,
    handler,
  };
  return toDescriptor(declaration);
}

/** Declares a secure context. jsdom implements none, and the registry is defined only in one. */
export function enterSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Returns the environment to having no registry, and forgets the layer's own initialization state.
 *
 * **`cleanupWebMCPPolyfill` is the adopted package's own teardown**, used rather than deleting the
 * host properties by hand: the layer holds internal state beyond those properties, and a case that
 * only cleared the hosts would leave the next one initializing over a registry the layer still
 * believes it installed. Found by reading its exports.
 */
export async function resetRegistry(): Promise<void> {
  const layer = await import('@mcp-b/webmcp-polyfill');
  try {
    layer.cleanupWebMCPPolyfill();
  } catch {
    // Never initialized, which is the ordinary state before the first case. Not a failure.
  }
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Initializes the real portability layer the way `src/webmcp/registry.ts` does.
 *
 * Both options matter and both are the library's own choices: `autoInitialize: false` so the layer
 * installs when asked rather than when imported, and `installTestingShim: false` so no testing surface
 * reaches a page. A conformance case that initialized it differently would be pinning behaviour this
 * library never asks for.
 */
export async function initializePortabilityLayer(): Promise<void> {
  const host = globalThis as typeof globalThis & {
    __webMCPPolyfillOptions?: { autoInitialize?: boolean };
  };
  host.__webMCPPolyfillOptions = { autoInitialize: false };
  const layer = await import('@mcp-b/webmcp-polyfill');
  layer.initializeWebMCPPolyfill({ autoInitialize: false, installTestingShim: false });
}

/** Whatever is at the canonical location. */
export function canonicalRegistry(): ModelContext | undefined {
  return (document as unknown as { modelContext?: ModelContext }).modelContext;
}

/** Whatever is at the deprecated host. */
export function deprecatedHostRegistry(): ModelContext | undefined {
  return (navigator as unknown as { modelContext?: ModelContext }).modelContext;
}
