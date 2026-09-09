import { expect, test } from '@playwright/test';
import { type PageServer, startPageServer, topDocumentUrl } from './fixture.ts';

// **What a real implementation of the tool registry actually does**, as opposed to what the draft says
// and what the adopted package does. Every other layer here substitutes a shim.
//
// **What a failure means, and it is not the usual thing.** These cases pin one build of one engine
// tracking a moving draft. A red run may mean Chromium changed rather than this library breaking —
// which is why the lane is opt-in (`pnpm test:e2e:native`) and outside the release gate. Three failure
// shapes, kept distinct on purpose:
//
//   the precondition case fails   the flag stopped working, or the engine dropped the feature
//   a behaviour case fails        Chromium changed its behaviour; a finding has expired
//   the version guard warns       results are being attributed to a Chromium this is not
//
// Findings are transcribed into `docs/conformance.md` with the version recorded below.

/** The build every finding in `docs/conformance.md` was measured against. */
const MEASURED_AGAINST = '151.0.7922.34';

let server: PageServer;

test.beforeAll(async ({ browser }) => {
  server = await startPageServer();
  // **Recorded, not asserted.** Pinning the version would turn a Playwright bump into a red run that
  // says nothing about the platform — but silently attributing results to a version that is not
  // running is how a report becomes wrong without anyone editing it (the failure this lane exists to
  // avoid). So a mismatch prints and the run continues.
  if (browser.version() !== MEASURED_AGAINST) {
    console.warn(
      `[native-registry] running Chromium ${browser.version()}; docs/conformance.md records ${MEASURED_AGAINST}. Re-measure before citing these results.`,
    );
  }
});
test.afterAll(async () => {
  await server.close();
});

test.beforeEach(async ({ page }) => {
  // **The probe runs at document load.** In an application page the portability layer installs a
  // registry at exactly this location, so a check made after load returns `true` on every engine
  // forever and reports a shim as an implementation. Nothing installs a shim here, but the ordering is
  // kept because the technique is the transferable part.
  await page.addInitScript(() => {
    (globalThis as { __nativeAtLoad?: unknown }).__nativeAtLoad = {
      onDocument: typeof (document as { modelContext?: unknown }).modelContext,
      secureContext: globalThis.isSecureContext,
    };
  });
  await page.goto(`${server.sameOrigin}/`);

  // **Asserted in beforeEach rather than in a case of its own, because `fullyParallel` is on.** A
  // standalone "the lane has its subject" test does not gate anything: with the flag removed it fails
  // beside five cases failing with "cannot read property of undefined", which is the confusing red it
  // was written to prevent. Here every case fails with this message instead.
  const seen = await page.evaluate(
    () => (globalThis as { __nativeAtLoad?: unknown }).__nativeAtLoad,
  );
  expect(seen, 'a native registry must be present AT DOCUMENT LOAD, in a secure context').toEqual({
    onDocument: 'object',
    secureContext: true,
  });
});

test('the deprecated host still resolves to the same object — an alias, not a second registry', async ({
  page,
}) => {
  // **Separate from the precondition on purpose.** `navigator.modelContext` is a compatibility alias
  // the draft moved away from on 2026-05-27; Chromium could drop it tomorrow without invalidating a
  // single case below. Requiring it as a precondition would tie the whole lane to a member the
  // standard is retiring. This library reads the canonical location and treats the other as a
  // fallback, so what matters is that they are not two registries.
  const alias = await page.evaluate(() => ({
    exists: typeof (navigator as { modelContext?: unknown }).modelContext,
    sameObject:
      (document as { modelContext?: unknown }).modelContext ===
      (navigator as { modelContext?: unknown }).modelContext,
  }));
  expect(alias).toEqual({ exists: 'object', sameObject: true });
});

test('a duplicate name REJECTS — the draft, and not what the adopted package does', async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const registry = document.modelContext;
    const tool = {
      name: 'dup.probe',
      description: 'probe',
      inputSchema: { type: 'object' },
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    await registry.registerTool(tool, { signal: new AbortController().signal });
    let returnedPromise = false;
    try {
      const pending = registry.registerTool(tool, { signal: new AbortController().signal });
      returnedPromise = typeof pending?.then === 'function';
      await pending;
      return { settled: 'accepted' };
    } catch (cause) {
      return {
        settled: returnedPromise ? 'rejected' : 'threw synchronously',
        name: (cause as { name?: string })?.name,
      };
    }
  });

  // **This is what makes `src/webmcp/registry.ts`'s `try { await }` load-bearing rather than merely
  // defensive.** The adopted package throws synchronously; Chromium rejects. Two real implementations,
  // two channels, and one spelling that catches both — which is why the comment at that call site says
  // not to simplify it into a `.catch()`.
  expect(outcome).toEqual({ settled: 'rejected', name: 'InvalidStateError' });
});

test('executeTool takes a JSON string, the handler receives an object, and no second argument arrives', async ({
  page,
}) => {
  const outcome = await page.evaluate(async () => {
    const registry = document.modelContext;
    let callback: unknown = null;
    let calls = 0;
    await registry.registerTool(
      {
        name: 'exec.probe',
        description: 'probe',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        async execute(...args: unknown[]) {
          calls += 1;
          callback = {
            argumentCount: args.length,
            firstIsObject: typeof args[0] === 'object' && args[0] !== null,
            first: JSON.stringify(args[0]),
            second: args[1] === undefined ? 'undefined' : typeof args[1],
          };
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
      { signal: new AbortController().signal },
    );
    const info = (await registry.getTools()).find((tool) => tool.name === 'exec.probe');
    // The cast is the finding, not a workaround: the ambient types come from `@mcp-b/webmcp-types`,
    // which describes the ADOPTED PACKAGE, so they cannot spell the draft's object form. Trying it is
    // the point of the case.
    //
    // **`.bind(registry)` is required here, and the reason is EXTRACTION rather than the cast.**
    // Storing the method in a variable and calling `call(...)` invokes it with no receiver, and the
    // platform answers `TypeError: Failed to execute 'executeTool' on 'ModelContext': Illegal
    // invocation`. An immediately-invoked member expression — `(registry.getTools as T)(options)`,
    // used further down — keeps its receiver and needs no bind. A type assertion is erased and never
    // detaches anything; do not "consistency-fix" the other call site to match this one.
    //
    // Worth the paragraph because of how it presented: the failure was first read as the registry
    // refusing the INPUT, since the message names `executeTool` and this case is about that method's
    // argument types. It was truncated to 40 characters at the time, which cut off "Illegal
    // invocation" — the two words that would have identified it immediately. The slice below is 120
    // for that reason.
    const call = registry.executeTool.bind(registry) as (
      tool: unknown,
      input: unknown,
    ) => Promise<unknown>;
    // **Each failure keeps its name.** Collapsing every rejection to "refused" would let a lookup
    // error, a parse error and a validation error read identically — and the interesting claim here
    // is specifically that the object is refused while PARSING, before anything runs.
    const attempt = async (input: unknown): Promise<unknown> => {
      const before = calls;
      try {
        await call(info, input);
        return { outcome: 'accepted', handlerRan: calls > before };
      } catch (cause) {
        return {
          outcome: 'refused',
          name: (cause as { name?: string })?.name,
          message: String((cause as { message?: string })?.message ?? '').slice(0, 120),
          handlerRan: calls > before,
        };
      }
    };
    const withObject = await attempt({ q: 'x' });
    const withJsonString = await attempt(JSON.stringify({ q: 'y' }));
    return { withObject, withJsonString, callback };
  });

  // **This overturns what this repository first concluded from the IDL alone.** The draft declares
  // `optional object inputObject`; the package takes a JSON string. The obvious inference — "the
  // package diverges, so our conformance case would fail against a real registry" — is WRONG. Chromium
  // takes the string and refuses the object, so on this member the DRAFT is the outlier and both
  // implementations agree.
  //
  // **The error is asserted, not merely recorded.** `handlerRan: false` says the object never reached
  // the tool; only the message says WHY, and "refused while parsing the input" is a different finding
  // from "refused because the tool was not found" or "refused because validation failed". Those three
  // are indistinguishable from the outcome alone, and one of them would mean this case is testing
  // nothing.
  expect(outcome.withObject).toEqual({
    outcome: 'refused',
    name: 'UnknownError',
    message: 'Failed to parse input arguments',
    handlerRan: false,
  });
  expect(outcome.withJsonString).toEqual({ outcome: 'accepted', handlerRan: true });

  // **The handler still receives a parsed object** — only the call boundary takes a string.
  //
  // And the second argument: the draft declares `ToolExecuteCallbackOptions { required AbortSignal
  // signal }`. **Chromium passes nothing at all.** A library that had taken the specification at its
  // word and destructured `{ signal }` would be reading a property of `undefined` on the only engine
  // that implements this. Cancellation here comes from `src/runtime/`, which races the handler itself
  // (docs/design.md#cancellation) — a choice made for its own reasons, and this is what turns it into
  // the thing that keeps cancellation working.
  expect(outcome.callback).toEqual({
    argumentCount: 1,
    firstIsObject: true,
    first: '{"q":"y"}',
    second: 'undefined',
  });
});

test('no output schema survives registration, and annotations are narrowed to the two normative hints', async ({
  page,
}) => {
  const listed = await page.evaluate(async () => {
    const registry = document.modelContext;
    await registry.registerTool(
      {
        name: 'shape.probe',
        title: 'Shape',
        description: 'probe',
        inputSchema: { type: 'object' },
        // Both are offered deliberately, to see what the platform keeps.
        outputSchema: { type: 'object' },
        annotations: {
          readOnlyHint: true,
          untrustedContentHint: true,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
      { signal: new AbortController().signal },
    );
    const tool = (await registry.getTools()).find((entry) => entry.name === 'shape.probe');
    return {
      ownKeys: Object.keys(tool ?? {}).sort(),
      annotationKeys: Object.keys((tool as { annotations?: object })?.annotations ?? {}).sort(),
      origin: (tool as { origin?: string })?.origin,
    };
  });

  // **`outputSchema` is dropped.** The platform confirming what `src/runtime/listing.ts` asserts: an
  // output schema cannot come back from the registry, so the ownership record is the only way one
  // reaches an agent. Previously read out of the IDL; now measured.
  expect(listed.ownKeys).not.toContain('outputSchema');

  // **Annotations are narrowed to the draft's two**; three of the five offered are dropped. The
  // adopted package keeps all five, so an application relying on `destructiveHint` would see it on the
  // shim and lose it here. This library sets none, which is why that divergence is inert for it.
  expect(listed.annotationKeys).toEqual(['readOnlyHint', 'untrustedContentHint']);

  // **`origin` and `window` are NOT a Chromium extension** — an earlier version of this case called
  // them undeclared, which was wrong. They are absent from `ModelContextTool` because that type is the
  // registration INPUT; the draft's `RegisteredTool`, which is what an enumeration returns, declares
  // them. They exist because enumeration spans documents: a listing that can cross a frame boundary
  // has to say which document each entry came from.
  expect(listed.ownKeys).toContain('origin');
  expect(listed.ownKeys).toContain('window');
  // And the value identifies the owning document rather than merely existing.
  expect(listed.origin).toBe(new URL(server.sameOrigin).origin);
});

test('enumeration crosses into a same-origin iframe — registration is per-document, enumeration is not', async ({
  page,
}) => {
  await page.goto(
    topDocumentUrl(server, [{ src: `${server.sameOrigin}/frame?name=same.origin.tool` }]),
    {
      waitUntil: 'networkidle',
    },
  );
  const names = await page.evaluate(async () => {
    const registry = document.modelContext;
    await registry.registerTool(
      {
        name: 'top.tool',
        description: 'declared by the top document',
        inputSchema: { type: 'object' },
        async execute() {
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
      { signal: new AbortController().signal },
    );
    return (await registry.getTools()).map((tool) => tool.name).sort();
  });

  // **The finding that corrects this repository's mental model, measured rather than read.** The frame
  // registered into ITS OWN document; the parent's `getTools()` returns it. So "the registry belongs to
  // the document" is true of registration and false of enumeration.
  //
  // `src/runtime/listing.ts`'s foreign-entry exclusion is unaffected — it is keyed on the ownership
  // record, not on where an entry came from — so a wider set arriving changes the size of what is
  // filtered, not the correctness of the filter.
  expect(names).toEqual(['same.origin.tool', 'top.tool']);
});

/**
 * Collects the frames' postMessage reports, then answers a listing question.
 *
 * The reports come first and are asserted first — see `fixture.ts` for why a listing alone cannot tell
 * "the option did something" from "the experiment did not run".
 */
async function embedAndReport(
  page: import('@playwright/test').Page,
  frames: readonly { readonly src: string; readonly delegatePolicy?: boolean }[],
): Promise<{
  reports: { name: string; hasRegistry: string; settled: string }[];
  plain: string[];
  scopedToCrossOrigin: string[];
}> {
  await page.goto(topDocumentUrl(server, frames), { waitUntil: 'networkidle' });
  return await page.evaluate(async (crossOrigin) => {
    // Read what the init-script listener recorded. It was installed before the document loaded, which
    // is the only ordering in which a frame's message cannot be missed.
    const reports = [
      ...((
        globalThis as { __frameReports?: { name: string; hasRegistry: string; settled: string }[] }
      ).__frameReports ?? []),
    ];
    const registry = document.modelContext;
    const listing = async (options?: unknown): Promise<string[]> =>
      (
        await (options === undefined
          ? registry.getTools()
          : (registry.getTools as (o: unknown) => ReturnType<typeof registry.getTools>)(options))
      )
        .map((tool) => tool.name)
        .sort();
    return {
      reports: reports.sort((a, b) => a.name.localeCompare(b.name)),
      plain: await listing(),
      scopedToCrossOrigin: await listing({ fromOrigins: [crossOrigin] }),
    };
  }, new URL(server.crossOrigin).origin);
}

test('cross-origin exposure IS implemented, behind three gates that all have to open', async ({
  page,
}) => {
  // The listener must exist before any frame loads, so it is installed for the whole document.
  await page.addInitScript(() => {
    const host = globalThis as { __frameReports?: unknown[] };
    host.__frameReports = [];
    globalThis.addEventListener('message', (event) => {
      (host.__frameReports as unknown[]).push((event as MessageEvent).data);
    });
  });
  const exposed = encodeURIComponent(JSON.stringify([new URL(server.sameOrigin).origin]));
  const observed = await embedAndReport(page, [
    // The positive control: same origin, no delegation needed.
    { src: `${server.sameOrigin}/frame?name=same.origin.control` },
    // Cross origin, delegated, but NOT declaring who it is exposed to.
    { src: `${server.crossOrigin}/frame?name=cross.delegated`, delegatePolicy: true },
    // Cross origin, delegated, AND exposed to the parent's origin.
    {
      src: `${server.crossOrigin}/frame?name=cross.exposed&exposed=${exposed}`,
      delegatePolicy: true,
    },
    // Cross origin with NO delegation — the platform's default.
    { src: `${server.crossOrigin}/frame?name=cross.undelegated` },
  ]);

  // **STEP ONE: did the experiment run?** Every frame must have got a registry and settled its
  // registration the way the gate under test predicts. Two earlier versions of this case skipped
  // straight to the listing and drew a conclusion from tools that were missing because registration
  // had been REFUSED — an outcome that looks identical to "the option did nothing".
  expect(observed.reports).toEqual([
    { name: 'cross.delegated', hasRegistry: 'object', settled: 'fulfilled' },
    { name: 'cross.exposed', hasRegistry: 'object', settled: 'fulfilled' },
    // **Gate one: Permissions Policy.** The registry OBJECT exists in an undelegated cross-origin
    // frame — so checking for its presence proves nothing — and `registerTool` rejects with
    // `NotAllowedError`. The default allowlist is `self`, and this is what enforces it.
    { name: 'cross.undelegated', hasRegistry: 'object', settled: 'rejected: NotAllowedError' },
    { name: 'same.origin.control', hasRegistry: 'object', settled: 'fulfilled' },
  ]);

  // **STEP TWO: gate two — `exposedTo`, declared by the tool's own document.** A plain enumeration
  // returns only the same-origin tool. Both delegated frames registered successfully and neither is
  // here, so registration succeeding is not exposure.
  expect(observed.plain).toEqual(['same.origin.control']);

  // **STEP THREE: gate three — `fromOrigins`, declared by the enumerating document.** Asking for the
  // cross origin returns the tool that declared `exposedTo` and NOT the one that did not. This is the
  // discriminating line: the two cross-origin frames differ in exactly one option, and they land on
  // opposite sides of it.
  expect(observed.scopedToCrossOrigin).toEqual(['cross.exposed', 'same.origin.control']);

  // **What this means for the cross-origin non-goal (docs/design.md#non-goals), corrected twice
  // before arriving here.**
  //
  //   version 1  asserted both options were "accepted" and concluded the doors were open. Worthless:
  //              an invented option name is accepted too, because WebIDL ignores unknown members.
  //   version 2  asserted the tools never appeared and concluded neither option was implemented.
  //              WRONG: the frames had been blocked by a policy gate nobody had delegated.
  //   version 3  this one, which reports how each registration settled before reading any listing.
  //
  // **Both options are fully implemented and both are required**, on top of a policy gate. So the
  // non-goal is kept by three independent things, and this library owns exactly one of them: it
  // never passes either option. `tests/conformance/enumeration-origin-scope.spec.ts` guards that, and
  // it is guarding a live door rather than an empty frame — which is what version 2 wrongly concluded.
});
