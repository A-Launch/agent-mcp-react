#!/usr/bin/env node
// Proves the published package can be CONSUMED, which is a different question from whether it builds.
//
// `scripts/verify-package.mjs` asks whether the tarball's export map resolves to files that exist.
// This asks the question after that one: can a project OUTSIDE this repository install the tarball,
// typecheck against its shipped types, and bundle it — importing every subpath the package declares.
//
// **It found three things no in-repo check could, and that is why it exists**:
//   - `capabilities={{ application: true }}` — the README's own snippet — does not compile. Every
//     member of `AgentCapabilities` is required, deliberately: an omitted member is denied rather
//     than defaulted, because authority only narrows.
//   - `onUnexpectedState` is a REQUIRED provider prop the README omitted entirely, so the documented
//     minimal example could not build.
//   - The MCP SDK's shipped types reference `Buffer`, so a consumer with `skipLibCheck: false` and no
//     `@types/node` fails to typecheck. Invisible here because the root tsconfig sets
//     `"types": ["node"]`.
//
// The fixture under `tests/consumer/fixture/` is an ORDINARY embedder: it imports only public entry
// points, exactly as `docs/` instructs, and `src/surface.ts` is reachable from the entry module so the
// BUNDLER resolves every subpath rather than only `tsc` seeing them. A fixture whose surface file was
// unreachable would typecheck nine subpaths and bundle three — measured, before it was made reachable.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, cwd, quiet = true) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });

const step = (message) => process.stdout.write(`  ${message}\n`);
let workspace;

try {
  step('building and packing the library…');
  run('pnpm', ['build'], repo);
  // `pnpm pack`, never `npm pack`: only pnpm applies the `publishConfig` field overrides that point
  // the export map at `dist/`. An npm-packed tarball resolves none of its exports.
  const packed = run('pnpm', ['pack'], repo)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'));
  if (packed === undefined) throw new Error('pnpm pack produced no tarball name');
  const tarball = join(repo, packed);

  workspace = mkdtempSync(join(tmpdir(), 'agent-mcp-consumer-'));
  cpSync(join(repo, 'tests/consumer/fixture'), workspace, { recursive: true });
  cpSync(tarball, join(workspace, packed));

  // The library is injected here rather than committed into the fixture's manifest, so the fixture
  // cannot drift from the tarball actually under test.
  const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
  manifest.dependencies['agent-mcp-react'] = `file:./${packed}`;
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  step('installing the tarball into a project outside this repository…');
  try {
    run('pnpm', ['install', '--offline', '--ignore-workspace'], workspace);
  } catch {
    // Offline first so a warm store needs no network; the fall-back is loud rather than a skip,
    // because a verification that quietly does nothing is the failure this file exists to prevent.
    step('  store incomplete — retrying with the registry…');
    run('pnpm', ['install', '--ignore-workspace'], workspace);
  }

  step('typechecking the consumer against the SHIPPED types…');
  run('pnpm', ['typecheck'], workspace);

  step('bundling the consumer with a real bundler…');
  run('pnpm', ['build'], workspace);

  rmSync(tarball, { force: true });
  process.stdout.write('\n  An external project installs this package, typechecks and builds.\n');
} catch (cause) {
  const detail = cause?.stdout ?? cause?.stderr ?? cause?.message ?? cause;
  process.stderr.write(`\n  Consumer verification FAILED.\n\n${String(detail).trim()}\n`);
  process.exitCode = 1;
} finally {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
}
