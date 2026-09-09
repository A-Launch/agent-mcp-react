// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalRegistry,
  descriptorFor,
  initializePortabilityLayer,
  resetRegistry,
} from './harness.ts';

// Two rows of the conformance table (`docs/conformance.md#the-rows`): "a duplicate name is refused"
// and "a deprecated-host-only registry registers **and invokes**".
//
// **The duplicate row is NOT the same question `tests/unit/webmcp/registration.spec.ts` answers.**
// That suite asserts how this library CLASSIFIES a refusal, against a stub whose behaviour it chose.
// This one asserts that the adopted registry refuses at all — because
// `classifyRegistrationFailure` in `src/webmcp/registration.ts` only runs if something throws, and a
// registry that silently accepted a duplicate would leave two tools under one name with nothing
// raised. The library would then be classifying an event that never happens.
//
// The synchronous-versus-rejected distinction is pinned too, because `src/webmcp/registry.ts` records
// it as a measured platform fact and shapes its `try`/`await` around it: "an already-aborted signal
// returns a rejected promise, while a duplicate name throws synchronously — before any promise exists
// to attach a handler to."

function register(
  descriptor: ReturnType<typeof descriptorFor>,
  signal: AbortSignal,
): Promise<void> {
  const registry = canonicalRegistry();
  if (registry === undefined) throw new Error('no registry — initialization did not run');
  return registry.registerTool(descriptor, { signal });
}

beforeEach(async () => {
  await resetRegistry();
  await initializePortabilityLayer();
});

describe('the adopted registry and a duplicate name', () => {
  it('accepts a name nobody holds', async () => {
    // The baseline that stops the refusal case below passing against a registry that refuses
    // everything.
    const controller = new AbortController();
    await expect(
      register(descriptorFor('conformance.unique'), controller.signal),
    ).resolves.toBeUndefined();
    const names = (await canonicalRegistry()?.getTools())?.map((tool) => tool.name) ?? [];
    expect(names).toContain('conformance.unique');
  });

  it('REFUSES a second registration of the same name', async () => {
    // The row. Without this, `classifyRegistrationFailure` is code that runs on an event nothing
    // proves happens — and two tools would share one name with nothing raised.
    const first = new AbortController();
    const second = new AbortController();
    await register(descriptorFor('conformance.contested'), first.signal);

    let refused = false;
    try {
      await register(descriptorFor('conformance.contested'), second.signal);
    } catch {
      refused = true;
    }
    expect(refused, 'the registry must refuse a duplicate name').toBe(true);
  });

  it('refuses it SYNCHRONOUSLY, which is the fact the boundary is shaped around', async () => {
    // `src/webmcp/registry.ts` records this as measured and writes `try { await ... }` rather than a
    // trailing `.catch()` because of it — a `.catch()` sees a rejected promise and lets a synchronous
    // throw escape as an uncaught exception. If the adopted package ever moved this to a rejection,
    // that reasoning would be stale and this case is what says so.
    const first = new AbortController();
    const second = new AbortController();
    await register(descriptorFor('conformance.sync'), first.signal);

    const registry = canonicalRegistry();
    let threwSynchronously = false;
    try {
      // Deliberately NOT awaited: a synchronous throw happens before a promise exists.
      void registry?.registerTool(descriptorFor('conformance.sync'), { signal: second.signal });
    } catch {
      threwSynchronously = true;
    }
    expect(
      threwSynchronously,
      'a duplicate must throw before a promise exists — the boundary omits a .catch() because of this',
    ).toBe(true);
  });

  it('frees the name once the first registration is withdrawn', async () => {
    // The other half: a refusal that were permanent would make a route change unable to re-register
    // its own tool, and the lifecycle guarantee is that a tool is gone at unmount and registrable
    // again by whatever mounts next (`docs/design.md#registration-follows-the-commit`).
    const first = new AbortController();
    const second = new AbortController();
    await register(descriptorFor('conformance.recycled'), first.signal);

    first.abort();
    await Promise.resolve();

    await expect(
      register(descriptorFor('conformance.recycled'), second.signal),
    ).resolves.toBeUndefined();
  });
});

describe('withdrawal by aborting the registration signal', () => {
  it('removes the tool from the registry', async () => {
    // The withdrawal mechanism the design specifies — registration is bound to an AbortSignal
    // (`docs/design.md#registration-follows-the-commit`) — against the adopted package rather than a
    // stub: this library never calls an
    // unregister method, it aborts a signal. If that stopped working, every unmount would leak a tool
    // and `tools/list` would grow forever.
    const controller = new AbortController();
    await register(descriptorFor('conformance.withdrawn'), controller.signal);
    expect((await canonicalRegistry()?.getTools())?.map((t) => t.name)).toContain(
      'conformance.withdrawn',
    );

    controller.abort();
    await Promise.resolve();

    expect((await canonicalRegistry()?.getTools())?.map((t) => t.name)).not.toContain(
      'conformance.withdrawn',
    );
  });

  it('is idempotent under a DOUBLE-INVOKED effect, as React Strict Mode produces', async () => {
    // The conformance table's row for idempotent withdrawal, and the abort-bound registration the
    // design specifies. React double-invokes effects in development: register, abort,
    // register again — the registry must end holding exactly one, not two and not none.
    const first = new AbortController();
    await register(descriptorFor('conformance.strict'), first.signal);
    first.abort();

    // No await between the abort and the re-registration: the registry coalesces mutations onto a
    // microtask, and `src/webmcp/registration.ts` depends on that ordering.
    const second = new AbortController();
    await register(descriptorFor('conformance.strict'), second.signal);
    await Promise.resolve();

    const names = (await canonicalRegistry()?.getTools())?.map((tool) => tool.name) ?? [];
    expect(names.filter((name) => name === 'conformance.strict')).toHaveLength(1);
  });
});

describe('an environment exposing only the deprecated host', () => {
  it('registers and invokes through it', async () => {
    // The deprecated-host row. The layer aliases both hosts to one object, so a page reaching the registry by the
    // deprecated name gets a working one — which is what "still registers and invokes" means.
    const registry = (
      navigator as unknown as { modelContext?: ReturnType<typeof canonicalRegistry> }
    ).modelContext;
    expect(registry, 'the deprecated host exposes a registry').toBeDefined();

    const controller = new AbortController();
    let ran = false;
    await registry?.registerTool(
      descriptorFor('conformance.deprecated', () => {
        ran = true;
        return 'invoked through the deprecated host';
      }),
      { signal: controller.signal },
    );

    const names = (await registry?.getTools())?.map((tool) => tool.name) ?? [];
    expect(names).toContain('conformance.deprecated');

    // **`executeTool` takes the tool INFO and a JSON string, not a name and an object.** Read from
    // `@mcp-b/webmcp-types` rather than guessed — the first attempt passed a name and an object and
    // got "Tool not found: undefined", which is the shape of a case that would have gone green against
    // a registry that silently did nothing.
    //
    // **And that signature is a DIVERGENCE from the draft — but NOT from the platform.** The normative
    // IDL at the pinned commit declares `executeTool(RegisteredTool tool, optional object
    // inputObject)` — an OBJECT. The resolved package takes a JSON string.
    //
    // **The obvious next inference is wrong, and this comment recorded it wrongly before measuring.**
    // This comment first said the line "would fail against a conformant native registry". It does not:
    // Chromium 151 takes a JSON string too and REFUSES the object — measured directly, in
    // `tests/e2e/native-registry/divergences.spec.ts`. On this member the DRAFT is the outlier and
    // both implementations agree, so this spelling is not merely what we happen to run against; it is
    // what both engines want. Nothing here needs to change if a native registry becomes the default.
    //
    // The lesson kept rather than the fact: a divergence between a draft and a package says nothing
    // on its own about which one an implementation follows.
    const info = (await registry?.getTools())?.find(
      (tool) => tool.name === 'conformance.deprecated',
    );
    expect(info, 'the registry reports the tool it was given').toBeDefined();
    if (info !== undefined) await registry?.executeTool(info, JSON.stringify({}));
    expect(ran, 'the tool must actually run when invoked through the deprecated host').toBe(true);
  });
});
