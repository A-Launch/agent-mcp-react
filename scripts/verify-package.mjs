#!/usr/bin/env node
// Packs the package and verifies the TARBALL — not `dist/`, and not the exit code of anything.
//
// **This exists because a release review found the tarball was broken while every gate was green.**
// The six gate commands build `dist/`, load it, and pass. None of them packs. And the packed manifest
// is not the repository's manifest: `publishConfig` rewrites the `exports` map at pack time, so what a
// consumer resolves through is a file no test had ever read.
//
// **The failure was total, not marginal.** `npm pack` does NOT apply `publishConfig` field overrides —
// that is a pnpm feature. Packed with npm, the tarball's `exports` still pointed at `./src/index.ts`,
// and `files` deliberately excludes `src/`. Every import in the published package would have failed.
//
//     npm pack   → exports: { ".": "./src/index.ts" }        ← src/ is not in the tarball
//     pnpm pack  → exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
//
// So **this package must be packed and published with pnpm**, and that is now a checked fact rather
// than a thing somebody has to know.
//
//     node scripts/verify-package.mjs
//
// It needs no network: it reads the tarball's own manifest and asserts every target it declares is
// present INSIDE the tarball. That is precisely the defect above, and it is what a consumer's
// resolver would hit on the first import.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'amr-pack-'));
const problems = [];

try {
  if (!existsSync('dist/index.js')) {
    console.error('No dist/. Run `pnpm build` first — this verifies what would be published.');
    process.exit(1);
  }

  // **Packed with pnpm deliberately**, because that is the only packer that applies `publishConfig`
  // here. Using `npm pack` would produce the broken tarball this script exists to catch — so the
  // command is part of the assertion rather than an implementation detail.
  execFileSync('pnpm', ['pack', '--pack-destination', work], { stdio: 'pipe' });
  const tarball = execFileSync('ls', [work], { encoding: 'utf8' }).trim().split('\n')[0];
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work]);

  const root = join(work, 'package');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  console.log(`Verifying ${tarball}\n`);
  console.log(`  version : ${manifest.version}`);
  console.log(`  types   : ${manifest.types ?? 'ABSENT'}`);
  console.log(`  files   : ${(manifest.files ?? []).join(', ') || 'ABSENT'}\n`);

  if (manifest.version === undefined || manifest.version.startsWith('0.0.0')) {
    problems.push('the packed version is a placeholder');
  }

  const exportsMap = manifest.exports ?? {};
  if (Object.keys(exportsMap).length === 0)
    problems.push('the packed manifest declares no exports');

  console.log('  every export target, resolved inside the tarball:');
  for (const [name, entry] of Object.entries(exportsMap)) {
    // A subpath is either a string or a conditions object; both are checked the same way — by asking
    // whether the file it names is actually in here.
    const targets = typeof entry === 'string' ? { default: entry } : entry;
    for (const [condition, target] of Object.entries(targets)) {
      const present = existsSync(join(root, target));
      console.log(`    ${present ? 'ok  ' : 'MISSING'} ${name} [${condition}] → ${target}`);
      if (!present) {
        problems.push(`${name} [${condition}] points at ${target}, which is not in the tarball`);
      }
      if (target.includes('/src/')) {
        problems.push(
          `${name} [${condition}] points into src/, which this package does not publish`,
        );
      }
    }
  }

  // Types beside every JavaScript entry, so a TypeScript consumer is not left compiling this library.
  for (const [name, entry] of Object.entries(exportsMap)) {
    if (typeof entry === 'object' && entry !== null && !('types' in entry)) {
      problems.push(`${name} declares no types condition`);
    }
  }

  console.log('');
  if (problems.length > 0) {
    console.error('This tarball would not work for a consumer:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nIf the export targets point at src/, the package was packed with `npm pack`. npm does not' +
        '\napply publishConfig field overrides; pnpm does. Pack and publish with pnpm.',
    );
    process.exit(1);
  }
  console.log('  The packed tarball resolves every export it declares.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
