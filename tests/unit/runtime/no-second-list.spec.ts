import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMcpRuntime } from '../../../src/runtime/server.ts';
import { APPLICATION_ONLY } from '../../support/capabilities.ts';

// The central claim of this feature, asserted as an absence: there is no second tool list, and no
// operation that would invalidate one.
//
// An absence is awkward to test and worth the awkwardness here, because the alternative design is not
// wrong-looking. A cached listing plus a `refresh()` is what most people would write, it passes every
// behavioural case as long as the refresh is called, and the day it is not called the agent's picture
// of the page is stale with nothing anywhere saying so.
//
// Two complementary checks: the runtime's public surface, and the module's source. The first catches
// an operation someone exposes; the second catches a private cache that no operation reveals.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeDir = join('src', 'runtime');

async function runtimeSources(): Promise<Array<{ path: string; source: string }>> {
  const names = await readdir(resolve(repoRoot, runtimeDir));
  const files = names.filter((name) => name.endsWith('.ts'));
  return Promise.all(
    files.map(async (name) => ({
      path: join(runtimeDir, name),
      source: await readFile(resolve(repoRoot, runtimeDir, name), 'utf8'),
    })),
  );
}

describe('the runtime exposes no way to refresh a listing', () => {
  it('offers only the operations a caller actually needs', () => {
    const runtime = createMcpRuntime({
      serverInfo: { name: 'p', version: '0' },
      onUnexpectedState: () => undefined,
      capabilities: () => APPLICATION_ONLY,
    });

    // A whitelist, so a NEW operation added later fails this case rather than slipping past a list of
    // forbidden names nobody thought to extend.
    // `capabilitiesChanged` is on this list and is NOT the operation this case exists to forbid. It
    // invalidates nothing and returns nothing: it tells the publisher to derive the listing again and
    // compare, exactly as a registry event does. A cache handle would let a caller ask for the OLD
    // answer; there is still no way to do that.
    expect(Object.keys(runtime).sort()).toEqual([
      'capabilitiesChanged',
      'connect',
      'ownership',
      'shutdown',
    ]);
  });

  it('has no member whose name suggests a cache to manage', () => {
    const runtime = createMcpRuntime({
      serverInfo: { name: 'p', version: '0' },
      onUnexpectedState: () => undefined,
      capabilities: () => APPLICATION_ONLY,
    });

    for (const forbidden of [
      'refresh',
      'invalidate',
      'sync',
      'reload',
      'update',
      'tools',
      'toolList',
      'listTools',
      'cache',
      'clearCache',
    ]) {
      expect(
        (runtime as unknown as Record<string, unknown>)[forbidden],
        `the runtime exposes "${forbidden}" — a listing is derived on every request, so there is nothing to refresh, invalidate or hold`,
      ).toBeUndefined();
    }
  });
});

describe('the runtime holds no tool list, exposed or otherwise', () => {
  it('has no module-level or instance-level collection of tools in its source', async () => {
    const offenders: string[] = [];

    for (const { path, source } of await runtimeSources()) {
      for (const [line, text] of source.split('\n').entries()) {
        if (text.trimStart().startsWith('//') || text.trimStart().startsWith('*')) continue;
        // A stored listing would have to live in a variable that survives a request. These are the
        // shapes that produce one: a retained array or map of tools, or an assignment of a derived
        // listing to something outside the handler.
        if (/\b(cachedTools|toolCache|toolList|lastListing|listingCache)\b/.test(text)) {
          offenders.push(`${path}:${line + 1} — ${text.trim()}`);
        }
        if (/^\s*(let|var)\s+\w*[Tt]ools\w*\s*(:|=)/.test(text)) {
          offenders.push(`${path}:${line + 1} — ${text.trim()}`);
        }
      }
    }

    expect(
      offenders,
      `these look like a stored tool list. The listing is derived on every request and never held — a second list is a second answer to a question the registry already answers:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('does not use the SDK high-level server, which keeps a tool list of its own', async () => {
    const offenders: string[] = [];

    for (const { path, source } of await runtimeSources()) {
      // `McpServer` registers tools into its own registry. Using it would mean the tool set lived in
      // two places that must agree, which is the failure this module is shaped to avoid.
      if (/\bMcpServer\b/.test(source)) offenders.push(path);
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
