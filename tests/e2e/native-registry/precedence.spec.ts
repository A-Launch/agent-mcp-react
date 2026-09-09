import { expect, test } from '@playwright/test';
import { LAYER_PATH, type PageServer, startPageServer } from './fixture.ts';

// **Native precedence — a native registry is used unchanged, and the shim is initialized only in its
// absence (docs/design.md#the-provider) — asserted against a real native registry.**
//
// This row stood unticked on the stated grounds that no engine exposed an implementation to test it
// against. One does — Chromium behind a flag, in a secure context
// (docs/conformance.md#what-these-cases-do-not-evidence) — and this is the case those grounds ought
// to have been blocking.
//
// **It is the most valuable case in this lane, because it is the only one about THIS LIBRARY.** The
// others ask what the platform does. This one asks the question an embedder's user actually runs into:
// a page ships this library, the browser has its own registry, and something has to give way.
//
// The claim under test, from `src/webmcp/registry.ts`: the portability layer is initialized only when
// no native implementation is present, and a native one is used **unchanged**. A shim that replaced a
// native registry would be a second registry on the page — and the symptom would not be an error, it
// would be an agent enumerating tools nobody could invoke.
//
// **This case runs against the real example application** rather than the lane's own page server,
// which is the opposite choice from `divergences.spec.ts` and deliberately so: there the subject is the
// platform and a page carrying the provider would contaminate it; here the provider IS the subject.
//
// ---
//
// **WHAT THIS CASE DOES NOT EVIDENCE, and it was measured rather than reasoned about** — a state is
// explainable only from evidence, and that includes what was NOT verified.
//
// Its break-it — deleting `ensureRegistry()`'s `alreadyPresent` branch so the library always installs
// the portability layer — **leaves this case GREEN**. The reason is that there are TWO independent
// guards, and this case cannot see which one fired: the adopted polyfill's own installer opens with
// `if (… || document.modelContext) return`, so it declines over a native registry whether or not this
// library checks first.
//
// So the division of labour, stated so neither case is mistaken for the other:
//
//   tests/unit/webmcp/resolution.spec.ts   evidences THIS LIBRARY's branch — a registry already
//                                          present resolves with provenance 'present', and the
//                                          break-it above turns it RED there
//   this case                              evidences the COMPOSITE guarantee against a REAL native
//                                          registry: whatever the two layers do between them, an
//                                          application ends up using the browser's registry and its
//                                          tools are in it
//
// **And it now discriminates after all**, which is better than documenting that it cannot.
// `installPortabilityLayer()` writes `globalThis.__webMCPPolyfillOptions` UNCONDITIONALLY, before it
// imports the adopted layer — so that property's absence proves this library never entered the install
// path, independently of what the layer would have done on arrival. Asserting the absence turns the
// break-it red. The paragraph above is kept because the reasoning that produced it is still true of
// object identity alone, and a future reader will otherwise re-derive it.
//
// **Our check must stay even though it is redundant today.** The polyfill's decline is behaviour this
// project does not control; a version that dropped it would silently install a second registry over
// the browser's, and the symptom would be an agent enumerating tools nobody can invoke.

test('the library uses a native registry unchanged rather than installing over it', async ({
  page,
}) => {
  // **Captured at document load, before the application's bundle evaluates.** This is the whole
  // technique: after load, `document.modelContext` is populated either way, so a later read cannot
  // distinguish "deferred to the native registry" from "installed a shim over it". The object identity
  // captured here is the only thing that can.
  await page.addInitScript(() => {
    const host = globalThis as { __nativeAtLoad?: { present: boolean; registry: unknown } };
    host.__nativeAtLoad = {
      present: typeof (document as { modelContext?: unknown }).modelContext === 'object',
      registry: (document as { modelContext?: unknown }).modelContext,
    };
  });

  await page.goto('/');
  // The application declares its tools in effects, so the listing is not populated at first paint.
  await expect
    .poll(
      async () => await page.evaluate(async () => (await document.modelContext.getTools()).length),
      { message: 'the example application registers its tools after mount' },
    )
    .toBeGreaterThan(0);

  const observed = await page.evaluate(async () => {
    const captured = (globalThis as { __nativeAtLoad?: { present: boolean; registry: unknown } })
      .__nativeAtLoad;
    return {
      nativePresentAtLoad: captured?.present ?? false,
      // **The assertion that carries the whole case.** Not "a registry exists now" — that is true in
      // every configuration, including the broken one.
      sameObjectAfterApplicationLoaded: captured?.registry === document.modelContext,
      // The marker `installPortabilityLayer()` sets before it imports anything. Present means this
      // library decided to install; absent means it never tried.
      installMarkerPresent: '__webMCPPolyfillOptions' in globalThis,
      toolNames: (await document.modelContext.getTools()).map((tool) => tool.name).sort(),
    };
  });

  expect(
    observed.nativePresentAtLoad,
    'the lane requires --enable-features=WebMCP; without it this case cannot say anything',
  ).toBe(true);

  // **The registry the application ends up using is the one the browser supplied.** The user-visible
  // half of native precedence (docs/design.md#the-provider) — though object identity alone cannot say
  // which layer's check produced it.
  expect(
    observed.sameObjectAfterApplicationLoaded,
    'the library must use the native registry unchanged, never install over it',
  ).toBe(true);

  // **And this library never entered the install path at all** — the discriminating assertion. It
  // fails if `ensureRegistry()` stops deferring, even though the adopted layer would still decline on
  // arrival and leave the identity check above green.
  expect(
    observed.installMarkerPresent,
    'the library must not begin installing the portability layer when a native registry is present',
  ).toBe(false);

  // **And it is genuinely in use, not merely left alone.** A library that deferred to the native
  // registry and then registered nowhere would satisfy the identity check above and be useless — the
  // failure mode where every gate passes and no tool exists. These are the demonstrator's own tools,
  // read back out of the browser's registry.
  expect(observed.toolNames).toContain('customers.set_filters');
  expect(observed.toolNames).toContain('customers.get_state');
});

// The second case needs the lane's OWN page — a clean document that serves the adopted layer — rather
// than the example application, because the subject is the layer in isolation.
let server: PageServer;
test.beforeAll(async () => {
  server = await startPageServer();
});
test.afterAll(async () => {
  await server.close();
});

test('the ADOPTED LAYER itself declines over a native registry, invoked directly', async ({
  page,
}) => {
  await page.goto(`${server.sameOrigin}/`);

  // **The case above proves this library never asks the layer to install. This one proves what the
  // layer does when it IS asked** — and they are different sentences, which is the whole reason this
  // exists. `docs/adopted-dependencies.md` carries the claim as *"the shim declines to install when a
  // native registry exists"*, and that row cannot be ticked by a case which only shows we never
  // invoked it.
  //
  // **Nor by the jsdom conformance case**, which is the subtler gap: `tests/conformance/
  // registry-precedence.spec.ts` initializes the layer twice, so the registry already present is the
  // layer's OWN instance. A layer that preserved its own instance and replaced a native object would
  // pass that case and fail here.
  //
  // So the real package's browser build is served and run against the browser's own registry.
  const observed = await page.evaluate(async (layerPath) => {
    // `autoInitialize: false` so loading the script installs nothing — the same option this library
    // sets. Installation has to be an explicit call, or the measurement is of an import side effect.
    (globalThis as { __webMCPPolyfillOptions?: unknown }).__webMCPPolyfillOptions = {
      autoInitialize: false,
    };
    const nativeBefore = document.modelContext;

    // **A dynamic `import()`, because that is how this library loads it.**
    // `installPortabilityLayer()` does `await import('@mcp-b/webmcp-polyfill')`, which resolves through
    // the package's `exports` map to its ESM entry — the same file being fetched here.
    const layer = (await import(layerPath)) as {
      initializeWebMCPPolyfill?: (options: unknown) => void;
    };
    if (typeof layer.initializeWebMCPPolyfill !== 'function') {
      return { loaded: false } as Record<string, unknown>;
    }

    // The install, asked for explicitly, over a registry that is already there.
    layer.initializeWebMCPPolyfill({ autoInitialize: false, installTestingShim: false });

    return {
      loaded: true,
      sameObjectAfterInstallAttempt: document.modelContext === nativeBefore,
    };
  }, LAYER_PATH);

  expect(
    observed.loaded,
    'the adopted layer must actually load, or this case measures nothing',
  ).toBe(true);
  expect(
    observed.sameObjectAfterInstallAttempt,
    'the adopted layer must leave a native registry in place when asked to install over it',
  ).toBe(true);
  // **The assertion is known to discriminate, measured rather than assumed.** Run the same sequence on
  // a Chromium WITHOUT the flag — no native registry — and the layer installs:
  //
  //   no flag    { nativeBefore: 'undefined', sameObject: false }
  //   with flag  { nativeBefore: 'object',    sameObject: true  }
  //
  // **An earlier version also asserted the layer's `__isWebMCPPolyfill` marker was absent. Removed:**
  // it is an undocumented internal, and object identity already proves the browser's registry was not
  // replaced. The marker added no evidence and would fail on a harmless rename — a case that breaks
  // when nothing broke. Recorded here rather than added as a second case, because a case asserting
  // that the layer installs when nothing is present would need a project without the flag — a second
  // Playwright project to evidence a control for one assertion. This lane's precondition would also
  // refuse to run it, correctly: without the flag the whole lane has no subject.
});
