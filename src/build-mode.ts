// The one place in this library that decides whether it is running in a development or a production
// build.
//
// It exists as its own module — outside any concern directory — because the distinction belongs to
// none of them and is needed by three:
//
//   - `src/runtime/`  what an error sent to the agent may contain
//                     (docs/reference-error-vocabulary.md).
//   - `src/react/`    a duplicate registration throws and names its source in development, while
//                     production preserves the original and refuses the later one
//                     (docs/design.md#duplicate-and-foreign-names).
//   - `src/devtools/` later, for what the inspector surfaces.
//
// Invariant this file enforces: **it is the only reader of the build flag.** A case in the module-seam
// suite asserts that, and the reason is to close off a whole class of error rather than tidiness.
// Three sites reading the same condition is three chances to invert one comparison — and the failure
// that produces is silent and asymmetric: the two correct sites keep behaving correctly, so nothing
// looks broken, while the third sends stack traces to an agent in production.
//
// It is deliberately a constant rather than a function. Bundlers replace the flag textually at build
// time, so a top-level comparison against it folds to `true` or `false` and the dead branch is removed
// entirely. A function call would defeat that and ship both branches, including the development-only
// diagnostics this exists to keep out of production bundles.

/**
 * Whether this build is a development build.
 *
 * Resolved once, from **two** flags, because one of them does not exist where this library actually
 * runs. `process.env.NODE_ENV` is the Node-shaped flag: it is what a test runner and a
 * server-side render set, and what a bundler substitutes into a production bundle. But a browser
 * dev server serves ESM to a page where `process` is simply not defined — so a library reading only
 * that one answers "production" in every browser development session, which is precisely where the
 * development behaviour is meant to be.
 *
 * That was measured, not reasoned about: a duplicate tool name in the example application, served by
 * its dev server, took the production path and reported to the operator instead of stopping the
 * author. The development branch was unreachable in the one place it exists for.
 *
 * `import.meta.env.DEV` is the browser-bundler flag for the same question, and adding it here is not a
 * second owner — it is this owner learning the second dialect of one question, and this file is that
 * owner. Nothing else in `src/**` may read either, and a seam case enforces that.
 *
 * Both guards are structural, so this is safe where neither exists — a bare page, a worker, a runner
 * that set nothing. The answer there is **production**, which is the conservative direction: an unset
 * flag must not be a way to switch development diagnostics on.
 */
export const IS_DEVELOPMENT: boolean = readDevelopmentFlag();

function readDevelopmentFlag(): boolean {
  const scope = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const mode = scope.process?.env?.NODE_ENV;

  // **An explicitly set `NODE_ENV` decides on its own.** It is the deliberate statement of the two:
  // something set it, for this process, on purpose. `import.meta.env.DEV` is a bundler default that is
  // true in every dev-server context including a test runner, so letting it override an explicit
  // `production` would make the production branch unreachable wherever a Vite-based runner is in play —
  // which is where it has to be exercised.
  //
  // Explicitly `=== 'development'` rather than `!== 'production'`. The second reading treats an unset
  // flag, a typo and a bundler that inlined nothing as development — the direction that leaks.
  if (typeof mode === 'string' && mode !== '') return mode === 'development';

  // No `NODE_ENV` at all: a browser page served by a dev server, where `process` does not exist. This
  // is the flag that dialect speaks.
  //
  // Explicitly `=== true`, for the same reason as above: a bundler that left the property absent, or a
  // runtime whose `import.meta` carries no `env`, must not read as development.
  const bundled = (import.meta as { env?: { DEV?: unknown } }).env;
  return bundled?.DEV === true;
}
