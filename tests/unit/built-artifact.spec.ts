import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// What the build actually produced, asserted by LOADING it.
//
// **This exists because the build was broken for twenty features and looked fine.** Running it
// reported `error TS5097` and exited 2 — and emitted 66 JavaScript files anyway, whose import
// specifiers Node's ESM resolver could not resolve:
//
//     Cannot find module '…/dist/page-identity'
//
// Nothing checked the artifact, so nothing noticed. A case that asserted "the build command exited 0"
// would not have noticed either — and would ALSO have missed the second failure, where an incremental
// build with a stale `tsconfig.build.tsbuildinfo` emitted **nothing** and exited **0**. Neither the
// exit code nor the file count is the thing to assert. What the artifact CONTAINS is.
//
// **Skipped, loudly, when `dist/` is absent**, rather than failing: `pnpm test` must pass on a clean
// checkout before `pnpm build` has ever run, and a case that demanded a build would make the two gate
// commands order-dependent. `pnpm build` is itself a gate command, so a genuinely missing build is
// caught there.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface Manifest {
  readonly version: string;
  readonly exports: Record<string, string>;
  readonly publishConfig: {
    readonly exports: Record<string, { readonly types: string; readonly default: string }>;
  };
}

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as Manifest;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(resolve(repoRoot, path));
    return true;
  } catch {
    return false;
  }
}

const built = await exists('dist/index.js');

describe.skipIf(!built)('the built artifact', () => {
  it('emits JavaScript and declarations for every declared export', async () => {
    // **Iterated from the manifest, never a snapshot of expected names.** A snapshot has to be updated
    // whenever a subpath is added, and that update is exactly what gets forgotten — so a new export
    // would ship unverified. Iterating means a subpath is covered the moment it is declared.
    const { publishConfig } = await manifest();
    const missing: string[] = [];

    for (const [name, entry] of Object.entries(publishConfig.exports)) {
      if (!(await exists(entry.default)))
        missing.push(`${name}: no JavaScript at ${entry.default}`);
      if (!(await exists(entry.types))) missing.push(`${name}: no declarations at ${entry.types}`);
    }

    expect(missing, `the build did not produce:\n${missing.join('\n')}`).toEqual([]);
  });

  it('produces JavaScript Node can actually load, from every subpath', async () => {
    // **The assertion the broken build would have failed.** Its emitted specifiers were extensionless,
    // so every one of these imports would have thrown ERR_MODULE_NOT_FOUND.
    const { publishConfig } = await manifest();
    const failures: string[] = [];

    for (const [name, entry] of Object.entries(publishConfig.exports)) {
      try {
        const loaded: Record<string, unknown> = await import(resolve(repoRoot, entry.default));
        // A module that loads and exports nothing is a module that was emitted empty, which is the
        // other way this can look fine and be wrong.
        if (Object.keys(loaded).length === 0) failures.push(`${name}: loaded but exports nothing`);
      } catch (cause) {
        failures.push(`${name}: ${(cause as Error).message.split('\n')[0]}`);
      }
    }

    expect(failures, `subpaths that do not load:\n${failures.join('\n')}`).toEqual([]);
  });

  it('rewrites every relative specifier to something resolvable', async () => {
    // The mechanism, asserted directly as well as through the loads above — so a failure says WHICH
    // property broke rather than only that an import threw. `tsc` writes extensionless specifiers
    // without `rewriteRelativeImportExtensions`, and those are the exact shape this catches.
    const source = await readFile(resolve(repoRoot, 'dist/index.js'), 'utf8');
    const specifiers = [...source.matchAll(/from\s*["'](\.[^"']*)["']/g)].map((match) => match[1]);

    expect(specifiers.length, 'the entry point imports something').toBeGreaterThan(0);
    const unresolvable = specifiers.filter((one) => one !== undefined && !one.endsWith('.js'));
    expect(
      unresolvable,
      `these relative specifiers are not resolvable by Node's ESM resolver:\n${unresolvable.join('\n')}`,
    ).toEqual([]);
  });

  it('does not leak a source-tree path into the published export map', async () => {
    // Development resolves to `src/`; consumers resolve to `dist/`. A `publishConfig` entry still
    // pointing at source would ship a package whose exports do not exist in it.
    const { publishConfig } = await manifest();
    const leaks = Object.entries(publishConfig.exports)
      .flatMap(([name, entry]) => [`${name}:${entry.types}`, `${name}:${entry.default}`])
      .filter((one) => one.includes('/src/'));
    expect(leaks, `published exports pointing at source:\n${leaks.join('\n')}`).toEqual([]);
  });
});

describe('the manifest describes a consumable package', () => {
  // These need no build, so they are not skipped — a manifest that stopped describing a package would
  // otherwise go unnoticed on a checkout where nobody had built.
  it('declares a real version', async () => {
    const { version } = await manifest();
    expect(version).not.toBe('0.0.0');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('publishes every development export, and no more', async () => {
    // The two maps must name the same subpaths. A subpath added to one and not the other is either an
    // export consumers cannot reach or one that points at nothing.
    const { exports: dev, publishConfig } = await manifest();
    expect(Object.keys(publishConfig.exports).sort()).toEqual(Object.keys(dev).sort());
  });
});
