import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TARGETED_REVISION } from '../../../src/webmcp/revision.ts';

// The targeted revision is recorded, and nothing branches on it.
//
// It exists so a maintainer comparing this module against a published draft can see which one its
// behaviour assumes, without reading code. The moment something reads it to make a decision it stops
// being a record and becomes version negotiation — which this library does not do, and which would put
// a second answer to "what does the platform support" next to the platform itself.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('the targeted revision', () => {
  it('is stated in a form a maintainer can compare against a published draft', () => {
    expect(TARGETED_REVISION.draft).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(TARGETED_REVISION.specification).toMatch(/^https:\/\//);
  });

  it('names the changes this module’s shape depends on', () => {
    const changes = TARGETED_REVISION.dependsOn.map((entry) => entry.change).join(' ');

    // Both are load-bearing rather than trivia: withdrawal is abort-only because one draft removed the
    // unregister operation, and the registry is reached on the document because another moved it there.
    expect(changes).toMatch(/unregisterTool/);
    expect(changes).toMatch(/Navigator to Document/);
  });

  it('is read by nothing', async () => {
    const readers: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(resolve(repoRoot, dir), { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          await walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (path.endsWith(join('webmcp', 'revision.ts'))) continue;
        const source = await readFile(resolve(repoRoot, path), 'utf8');
        if (/TARGETED_REVISION\s*\.\s*\w+/.test(source)) readers.push(path);
      }
    }

    await walk('src');

    expect(
      readers,
      `these files read the targeted revision. It is a record, not a version check:\n${readers.join('\n')}`,
    ).toEqual([]);
  });
});
