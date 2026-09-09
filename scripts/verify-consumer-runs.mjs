#!/usr/bin/env node
// Loads the external consumer's PRODUCTION BUNDLE in a real browser and asserts it works.
//
// `verify:consumer` proves an outside project can install, typecheck and bundle this package. That is
// not the same as the bundle working: a build that succeeds can still throw on import, fail to install
// the tool registry, or register nothing. This asks the last question.
//
// **Kept OUT of the health gate deliberately**, exactly like `test:e2e`: it needs browser binaries, and
// a gate with setup is a gate that gets skipped. It fails LOUD when the browser is missing rather than
// skipping — a verification that quietly does nothing is the failure this file exists to prevent.
//
// What it asserts, and each is a different way the package could be broken while still building:
//   - the module graph evaluates with NO page errors
//   - the tool registry reaches `document.modelContext` from the PACKAGED build (the portability shim,
//     bundled rather than sourced)
//   - all THREE declaration paths register: `useMcpTool`, `useMcpState`, and a module-scope
//     `registerMcpTool` that runs before React mounts
//   - the provider mounted and published a page identity
//
// A refused socket is EXPECTED and not a failure: no gateway runs here, and the library reaching
// `status: error` on a refused dial is correct behaviour rather than a broken build.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const step = (message) => process.stdout.write(`  ${message}\n`);

const EXPECTED_TOOLS = ['counter.get_state', 'counter.increment', 'shell.ping'];
const PORT = 45098;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let workspace;
let server;
let browser;

try {
  const { chromium } = await import('@playwright/test');

  step('packing and building the consumer…');
  run('pnpm', ['build'], repo);
  const packed = run('pnpm', ['pack'], repo)
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'));
  if (packed === undefined) throw new Error('pnpm pack produced no tarball name');

  workspace = mkdtempSync(join(tmpdir(), 'agent-mcp-runs-'));
  cpSync(join(repo, 'tests/consumer/fixture'), workspace, { recursive: true });
  cpSync(join(repo, packed), join(workspace, packed));
  const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
  manifest.dependencies['agent-mcp-react'] = `file:./${packed}`;
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    run('pnpm', ['install', '--offline', '--ignore-workspace'], workspace);
  } catch {
    run('pnpm', ['install', '--ignore-workspace'], workspace);
  }
  run('pnpm', ['build'], workspace);
  rmSync(join(repo, packed), { force: true });

  // Served over http://localhost — NOT a file:// or data: URL. The registry's interface is
  // [SecureContext]; localhost qualifies and an opaque origin does not, so the wrong choice here
  // reports "no registry" on every engine forever.
  const root = join(workspace, 'dist');
  server = createServer((request, response) => {
    const path = request.url === '/' ? '/index.html' : (request.url ?? '/').split('?')[0];
    const file = join(root, path);
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(PORT, resolve));

  step('loading the bundle in a real browser…');
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(2500);

  const observed = await page.evaluate(async () => ({
    mounted: document.querySelector('main')?.textContent ?? null,
    registry: typeof document.modelContext,
    tools: document.modelContext
      ? (await document.modelContext.getTools()).map((tool) => tool.name).sort()
      : null,
  }));

  const failures = [];
  if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.join(' | ')}`);
  if (observed.mounted === null)
    failures.push('the application did not mount — no <main> rendered');
  if (observed.registry !== 'object') {
    failures.push(`no tool registry at document.modelContext (saw ${observed.registry})`);
  }
  const tools = observed.tools ?? [];
  const missing = EXPECTED_TOOLS.filter((name) => !tools.includes(name));
  if (missing.length > 0) {
    failures.push(
      `tools missing: ${missing.join(', ')} — registered: ${tools.join(', ') || 'none'}`,
    );
  }

  if (failures.length > 0) throw new Error(failures.join('\n  '));

  process.stdout.write(
    `\n  The packaged build runs in a browser.\n` +
      `    rendered : ${observed.mounted}\n` +
      `    registry : ${observed.registry}\n` +
      `    tools    : ${tools.join(', ')}\n`,
  );
} catch (cause) {
  const detail = cause?.stdout ?? cause?.message ?? cause;
  const hint = /Executable doesn't exist|browserType\.launch/.test(String(detail))
    ? '\n  Browser binaries are missing. Run: npx playwright install chromium\n'
    : '';
  process.stderr.write(
    `\n  Consumer runtime verification FAILED.\n\n  ${String(detail).trim()}\n${hint}`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.close();
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
}
