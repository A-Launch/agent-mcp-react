#!/usr/bin/env node
// Measures this library against its size budget: "initial runtime overhead under 50 KB gzip
// excluding the MCP SDK and optional schema library" (docs/records/performance-budgets.md).
//
// **This exists because the claim was prose for the life of the project.** Nobody had built a bundle,
// so a number the design had stated all along had never actually been produced.
//
// **Run by a person, never by CI.** Bundle-size enforcement in CI is deliberately absent
// (CONTRIBUTING.md#11-scope) and must not be added ahead of a maintainer asking for it. So this exits
// non-zero for a person to read rather than failing a pipeline.
//
//     node scripts/measure-bundle.mjs
//
// **The integrity of the number is the externals list**, which is why each entry says why it is there.
// "Excluding the MCP SDK" is a structural exclusion — the SDK is marked external so esbuild does not
// walk into it — rather than a subtraction from a total, which nobody could check.
//
// **The budget's two exclusions turn out to be one, and that was discovered by running this rather
// than by reading the manifest.** The clause excludes "the MCP SDK and optional schema library" as though they
// were two payloads. They are not: Ajv is not a dependency of this package at all — the validation
// adapter imports it from `@modelcontextprotocol/server/validators/ajv`, a subpath of the SDK. So
// externalizing the SDK excludes both, structurally, and there is no second exclusion to argue about.
//
// The consequence for the table below: `./validation` measures the ADAPTER GLUE only — this library's
// own error-message composition and its boundary onto a validator — and not a schema engine. That is
// the honest reading of the number, and it is stated because 0.8 KB for "the validation subpath" would
// otherwise look like a schema library that had been quietly subtracted.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/**
 * What is not this library's weight.
 *
 * Each entry is a peer or a dependency the budget excludes, and nothing else is here — the portability shim, the
 * validation adapter glue and every part of `src/` all count toward the number.
 */
const EXTERNAL = [
  // The host application's own React. A peer dependency: an embedder already has it.
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  // "excluding the MCP SDK" — the budget's own words. Marked external so esbuild never walks into it, which is
  // what makes the exclusion structural rather than a subtraction nobody can verify.
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server/*',
];

/** The gzip figure, computed the same way every time so two runs are comparable. */
function gzipBytes(source) {
  return gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).length;
}

async function measure(entryPath, label) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    external: EXTERNAL,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0].text;
  return { label, raw: output.length, gzip: gzipBytes(output) };
}

const BUDGET_BYTES = 50 * 1024;

const work = mkdtempSync(join(tmpdir(), 'amr-measure-'));
try {
  // **Measured against the BUILD OUTPUT when there is one, and against source otherwise.**
  //
  // An earlier measurement took these figures from source through esbuild and said so, noting that the
  // number should be taken again once a real artifact was published.
  // A number from source is a good estimate of the shipped one. It is not the same number — the
  // emitted JavaScript is what an embedder downloads — so this prefers `publishConfig.exports` when
  // `dist/` exists, and says which it used.
  const publishedExports = pkg.publishConfig?.exports;
  const useBuilt =
    publishedExports !== undefined &&
    existsSync(join(process.cwd(), publishedExports['.'].default.replace('./', '')));
  const subpaths = useBuilt
    ? Object.entries(publishedExports).map(([name, entry]) => [name, entry.default])
    : Object.entries(pkg.exports);

  // Each subpath on its own, so an embedder can see what any one of them costs.
  const perSubpath = [];
  for (const [name, file] of subpaths) {
    const entry = join(work, `entry-${name.replace(/[^a-z0-9]/gi, '_')}.mjs`);
    // A namespace import that is observably used, so nothing is tree-shaken away and the figure is
    // what the module actually weighs rather than what survived elimination.
    writeFileSync(
      entry,
      `import * as ns from ${JSON.stringify(join(process.cwd(), file))};\nglobalThis.__keep = ns;\n`,
    );
    perSubpath.push(await measure(entry, name));
  }

  // Everything at once — the ceiling, for an application that imported every export.
  const allEntry = join(work, 'entry-all.mjs');
  writeFileSync(
    allEntry,
    `${subpaths
      .map(([, file], i) => `import * as ns${i} from ${JSON.stringify(join(process.cwd(), file))};`)
      .join('\n')}\nglobalThis.__keep = [${subpaths.map((_unused, i) => `ns${i}`).join(', ')}];\n`,
  );
  const all = await measure(allEntry, 'ALL EXPORTS');

  const main = perSubpath.find((one) => one.label === '.');

  let revision = 'unknown';
  try {
    revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // Not a repository, or no git. The number is still valid; it is just less traceable, and saying so
    // is better than printing a plausible blank.
  }

  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

  console.log('size budget — measured\n');
  console.log(`  source revision : ${revision}`);
  console.log(`  esbuild         : ${esbuild.version}`);
  console.log(`  node            : ${process.version}`);
  console.log(`  gzip            : zlib level 9`);
  console.log(
    `  measured from   : ${useBuilt ? 'dist/ — the BUILT artifact an embedder downloads' : 'src/ — no build present; run pnpm build for the shipped figure'}`,
  );
  console.log(`  external        : ${EXTERNAL.join(', ')}\n`);

  console.log('  per subpath (gzip):');
  for (const one of perSubpath.sort((a, b) => b.gzip - a.gzip)) {
    console.log(`    ${one.label.padEnd(14)} ${kb(one.gzip).padStart(9)}   (raw ${kb(one.raw)})`);
  }
  console.log(
    `\n    ${'ALL EXPORTS'.padEnd(14)} ${kb(all.gzip).padStart(9)}   (raw ${kb(all.raw)})`,
  );

  console.log(`\n  BUDGET: ${kb(BUDGET_BYTES)} gzip, initial runtime overhead`);
  console.log(
    `  PASS/FAIL is the MAIN ENTRY — "initial" is what an embedder pays by default, and the`,
  );
  console.log(
    `  clause already excludes the optional schema library. Levels 2 and 3 are optional in`,
  );
  console.log(`  exactly that sense, measured: neither reaches a bundle that does not import it.`);
  console.log(
    `\n  main entry: ${kb(main.gzip)} / ${kb(BUDGET_BYTES)}  →  ${main.gzip < BUDGET_BYTES ? 'WITHIN BUDGET' : 'OVER BUDGET'}`,
  );

  if (main.gzip >= BUDGET_BYTES) {
    console.error('\n  Over budget. A release must not be cut at this size.');
    process.exit(1);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
