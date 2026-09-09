import { defineConfig } from 'vitest/config';

// The test-layer wiring for the whole repository. Each project below is a layer of the testing
// discipline (CONTRIBUTING.md#8-testing),
// and each exists because it can catch something no other layer can: `unit` runs without a DOM or a
// renderer, `react` runs a real renderer against jsdom, `transport` runs against a real local
// WebSocket server, and `integration` drives the example application through the whole stack.
//
// Invariant this file enforces: a layer's include pattern never overlaps another's. A spec picked up
// by two projects runs twice under two environments, and the version that passes hides the one that
// does not.
//
// End-to-end tests are deliberately NOT a project here — they need a real browser and belong to
// Playwright (`playwright.config.ts`, `pnpm test:e2e`). Wrapping them in Vitest would mean asserting
// bundling, the SSR boundary and real socket closure against jsdom, which is the environment those
// tests exist to escape.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // `.tsx` too: a case about the SSR boundary has to render the provider, and writing that
          // as `createElement` calls obscures the one thing it asserts.
          //
          // **`tests/conformance/` runs here rather than as a project of its own.**
          // What is asked for is a layer of CASES, not of runners: those cases pin the behaviour of
          // adopted packages, and they need neither a server nor a browser. A separate gate command for
          // them would be a command that gets skipped, and a conformance layer nobody runs is exactly
          // what that layer exists to prevent. The DIRECTORY is what makes it findable and what a new row
          // is added to.
          include: [
            'tests/unit/**/*.spec.{ts,tsx}',
            'tests/conformance/**/*.spec.{ts,tsx}',
            'src/**/*.spec.{ts,tsx}',
          ],
        },
      },
      {
        test: {
          name: 'react',
          environment: 'jsdom',
          include: ['tests/react/**/*.spec.{ts,tsx}'],
          globals: true,
          setupFiles: ['tests/react/setup.ts'],
        },
      },
      {
        test: {
          name: 'transport',
          environment: 'node',
          // `.tsx` as well as `.ts`, because the whole-stack cases mount a real provider with a real
          // component tree over a real socket. The environment stays `node`: those files declare
          // jsdom with a per-file docblock, so a case that needs a document says so rather than every
          // case in this project inheriting one it does not use.
          include: ['tests/transport/**/*.spec.{ts,tsx}'],
          // A real server takes real time to bind, accept and close. This is a wall-clock allowance
          // for the harness, never a synchronization mechanism. The rule against timing workarounds
          // forbids widening
          // it to make a flaky case pass.
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'jsdom',
          include: ['tests/integration/**/*.spec.{ts,tsx}'],
          globals: true,
        },
      },
    ],
  },
});
