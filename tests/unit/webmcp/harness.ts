import type { ModelContext, ModelContextToolInfo } from '@mcp-b/webmcp-types';

// Shared setup for the boundary's conformance cases.
//
// It exists because every case in this directory needs the same two things done exactly right, and
// getting either wrong makes a case pass for the wrong reason:
//
//   1. **A secure context must be declared, not inherited.** jsdom does not implement
//      `isSecureContext` at all, so a case that simply runs is a case in an environment that cannot
//      say whether it is secure. Declaring it here means each case states the environment it is
//      simulating, rather than benefiting from an omission.
//   2. **The document must be returned to a state with no registry.** The portability layer defines
//      its host properties as configurable, so they can be deleted. A case that inherited a registry
//      from its predecessor would silently exercise the already-present path while claiming to test
//      installation.
//
// The layer is never imported here. Importing it initializes it — that is the finding this whole
// feature is shaped around — so a harness that imported it would install a registry into every case
// before the first line ran.

/** Declares the environment a real page is in: a secure context with no registry yet. */
export function enterSecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: true,
    configurable: true,
    writable: true,
  });
}

/** Declares an insecure origin — a page served over plain HTTP from a network address. */
export function enterInsecureContext(): void {
  Object.defineProperty(globalThis, 'isSecureContext', {
    value: false,
    configurable: true,
    writable: true,
  });
}

/** Removes the property entirely: an environment that cannot say what it is. */
export function enterUnknownContext(): void {
  Reflect.deleteProperty(globalThis as object, 'isSecureContext');
}

/** Returns the document and navigator to having no registry on them. */
export function clearRegistryHosts(): void {
  Reflect.deleteProperty(document as object, 'modelContext');
  if (typeof navigator !== 'undefined') Reflect.deleteProperty(navigator as object, 'modelContext');
  Reflect.deleteProperty(globalThis as object, '__webMCPPolyfillOptions');
}

/**
 * Reads whatever is at the canonical location.
 *
 * Cases assert through this rather than naming the host object themselves. The first attempt at the
 * change-absorption experiment found the reason: a case that spelled out
 * `document.modelContext` made a revision of the standard reach a second file, which is the seam
 * leaking one assertion at a time. The suite has to name the platform somewhere — it exists to pin the
 * platform's behaviour — and that somewhere is here.
 */
export function readCanonicalHost(): unknown {
  return (document as unknown as { modelContext?: unknown }).modelContext;
}

/** Installs a value at `document.modelContext`, standing in for an implementation already present. */
export function placeOnDocument(registry: ModelContext): void {
  Object.defineProperty(document, 'modelContext', {
    value: registry,
    configurable: true,
    enumerable: true,
  });
}

/** Installs a value at the deprecated host object only — the environment the boundary must tolerate,
 *  because the standard's host object has migrated once already (`docs/conformance.md`). */
export function placeOnNavigatorOnly(registry: ModelContext): void {
  Object.defineProperty(navigator, 'modelContext', {
    value: registry,
    configurable: true,
    enumerable: true,
  });
}

/**
 * A minimal registry standing in for an implementation this project cannot run.
 *
 * **What a case using this establishes, and what it does not.** It establishes that the boundary and
 * the portability layer behave correctly toward *something already present at the canonical location*
 * — which is the behaviour this library depends on. It does **not** establish that a real native
 * implementation behaves like this. **What a real one does is now measured elsewhere**, in
 * `tests/e2e/native-registry/` against Chromium 151 under `--enable-features=WebMCP` —
 * and it differs from this stub on at least one point that matters: a duplicate name REJECTS there
 * and THROWS in the adopted package. A requirement resting on the native path is claimed from that
 * lane, never from here.
 */
export function createStubRegistry(options: { failRegistration?: unknown } = {}): ModelContext {
  const tools = new Map<string, { name: string; description: string; title?: string }>();
  const target = new EventTarget();

  const registry = {
    // Deliberately NOT an `async` function. The real registry throws a duplicate synchronously, before
    // any promise exists — an `async` stub would convert that into a rejection and quietly test the
    // channel the platform does not use, which is how a case ends up guarding nothing.
    registerTool(tool: { name: string; description: string; title?: string }): Promise<void> {
      if (options.failRegistration !== undefined) throw options.failRegistration;
      tools.set(tool.name, tool);
      target.dispatchEvent(new Event('toolchange'));
      return Promise.resolve();
    },
    async getTools(): Promise<ModelContextToolInfo[]> {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description,
        origin: 'https://stub.invalid',
        window: globalThis.window,
      }));
    },
    async executeTool(): Promise<string | null> {
      return null;
    },
    ontoolchange: null,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };

  return registry as unknown as ModelContext;
}

/**
 * Makes installation at the canonical location silently fail, so the unexplained-failure path can be
 * reached.
 *
 * Lives here for the same reason `readCanonicalHost` does: a case that intercepted the property by
 * name would be a second file a revision of the standard has to touch.
 */
export function suppressCanonicalInstallation(): { restore(): void; wasAttempted(): boolean } {
  const original = Object.defineProperty;
  let attempted = false;
  Object.defineProperty = ((target: object, key: PropertyKey, descriptor: PropertyDescriptor) => {
    if (key === 'modelContext') {
      attempted = true;
      return target;
    }
    return original(target, key, descriptor);
  }) as typeof Object.defineProperty;

  return {
    restore: () => {
      Object.defineProperty = original;
    },
    wasAttempted: () => attempted,
  };
}

/** An ownership record standing in for the runtime's, which does not exist yet. */
export function ownershipHolding(...names: string[]): { holds(name: string): boolean } {
  const held = new Set(names);
  return { holds: (name: string) => held.has(name) };
}

/** Waits one microtask, which is where the platform delivers coalesced change events. */
export function afterMicrotask(): Promise<void> {
  return Promise.resolve();
}
