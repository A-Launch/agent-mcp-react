import { defineConfig, devices } from '@playwright/test';

// The end-to-end layer: a real browser, a real socket, a real page. It exists for the four things no
// other layer can observe — that the published bundle actually loads in a browser, that the provider
// survives the SSR boundary, that `crypto.randomUUID` is present in the context the page runs in, and
// that a socket closed by the peer produces the closure semantics the reconnection policy assumes.
//
// It starts nothing. `webServer` is deliberately absent: the pages and the mock agent are started by
// the operator, so a broken start command fails the run instead of hiding inside it.
//
// **THREE servers, as of the composable board (026):**
//
//   pnpm dev:agent      :45000
//   pnpm dev:example    :45010
//   pnpm dev:board      :45030
//
// The third is not merely another page. `tests/e2e/composable-board.spec.ts` asserts that a page
// addresses ITSELF when more than one is connected — and with a single tab up the runtime answers an
// unaddressed request happily, so that case would pass while proving nothing. The dashboard is started
// so the ambiguity the case is about actually exists.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    // The example application's dev address. The page dials the mock agent outbound from here.
    baseURL: process.env.AMR_EXAMPLE_URL ?? 'http://localhost:45010',
    trace: 'on-first-retry',
  },
  // **Three engines, one suite.** Firefox and WebKit take the portability shim for the tool registry
  // and the design gives that path the same test obligation as any first-class path — so they run
  // the SAME cases rather than a reduced set, which is exactly the failure that rule names.
  //
  // What three engines evidence, stated precisely because the difference matters: the suite passed on
  // the Playwright-bundled Chromium, Firefox and WebKit revisions this run reports. Chromium is NOT
  // Chrome or Edge, WebKit is NOT Safari, and none of them can be pinned to the browser matrix's
  // "current and previous 2". That matrix therefore remains a support TARGET rather than verified
  // support; `docs/browser-support.md` records the gap
  // beside the claim.
  //
  // **`native-registry` is a FOURTH project and it is opt-in**, excluded from the default run by
  // `testIgnore` on the three above rather than by a convention someone has to remember. It launches
  // Chromium with `--enable-features=WebMCP`, which exposes Chromium's own implementation of the tool
  // registry — the thing every other layer in this repository substitutes a shim for.
  //
  // **It is opt-in for a reason that is not squeamishness.** The flag turns on an implementation of a
  // moving draft; a Chromium bump can change its behaviour with no dependency of ours moving, and a
  // release gate that could go red because a browser shipped is a gate that would be disabled. So it
  // MEASURES and is run deliberately (`pnpm test:e2e:native`), and its findings are transcribed into
  // `docs/conformance.md` where they carry a pinned Chromium version.
  //
  // This lane was opened after establishing that the repository's standing claim — "no
  // engine ships a native registry" — was false, and that its replacement, "it is behind an origin
  // trial", was false too. It is behind a flag, and the flag works.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /native-registry\//,
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /native-registry\// },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /native-registry\// },
    // Spread rather than declared: an empty spread contributes no project, so the lane is ABSENT from
    // a default run rather than present-and-skipped. A skipped project reports green and reads as
    // evidence that something ran; an absent one cannot be mistaken for one.
    ...(process.env.AMR_NATIVE_REGISTRY === undefined
      ? []
      : [
          {
            name: 'native-registry',
            // Anchored on `.spec.ts` rather than on the directory: the lane's page-server fixture
            // lives beside its cases, and a directory-wide match would treat that helper as a test.
            testMatch: /native-registry\/.*\.spec\.ts$/,
            use: {
              ...devices['Desktop Chrome'],
              // The one line that makes this lane different from the `chromium` project.
              launchOptions: { args: ['--enable-features=WebMCP'] },
            },
          },
        ]),
  ],
});
