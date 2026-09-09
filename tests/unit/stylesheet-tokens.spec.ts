import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every custom property a stylesheet USES must be one it DEFINES.
//
// **This exists because the same defect shipped twice in one day, in two files, written hours apart.**
// The confirmation dialog — the human-in-the-loop gate for an agent mutation — set
// `background: var(--surface, #fff)`, and no `--surface` token has ever existed. The fallback applied
// in every scheme, so in dark mode a white panel carried text that had switched to the dark palette:
// 1.19:1, measured. The inspector dock then set `background: var(--card)` with no `--card` token and
// no fallback at all, which computes to `transparent` and looked correct against both grounds by
// accident.
//
// **The failure mode is what makes this worth a case rather than a code review.** An undefined custom
// property is not a CSS error. It does not warn, it does not fail a build, and it does not fail a
// lint: the declaration is simply invalid at computed-value time, so the property falls back to its
// inherited or initial value — and `transparent`, `inherit` or a fallback colour all render something.
// The page looks finished. Every other class of typo in this repository is caught by TypeScript or by
// Biome; this one is caught by a person noticing a panel is the wrong colour, in the one theme they
// happen to be using.
//
// Fallbacks are deliberately NOT treated as an excuse. `var(--surface, #fff)` had one and was the
// worse of the two bugs, because a fallback is a single fixed value while a token is the thing that
// changes with the colour scheme — so a fallback that looks right in light mode is a dark-mode defect
// that reads as intentional.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every stylesheet this repository ships, wherever it lives — INCLUDING the ones written in
 * TypeScript.
 *
 * **A review of the change that added this file caught the gap.** The check originally collected
 * `.css` only, which left `src/devtools/panel-styles.ts` — the library's own panel stylesheet, added
 * in the same day's work and the newest one in the repository — outside the very check written
 * because this class of bug is invisible. A guard that covers every stylesheet but the one most
 * likely to be edited next is a guard with a hole exactly where it is needed.
 */
async function stylesheets(): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(repoRoot, dir), { withFileTypes: true });
    } catch {
      return; // A root that does not exist yet is not a violation.
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        await walk(path);
        continue;
      }
      if (/\.(css|ts|tsx)$/.test(entry.name)) found.push(path);
    }
  }

  // Read, never imported — which is why this sits in the unit suite without touching the rule that
  // only `tests/integration/` may IMPORT the demonstrator. `module-seams.spec.ts` walks the same roots
  // the same way.
  for (const root of ['src', 'examples', 'tools']) await walk(root);
  return found;
}

/**
 * The CSS in a file: its whole text when it is a stylesheet, and only its template literals when it is
 * TypeScript.
 *
 * Scanning a whole `.ts` file would report every `--flag:` in a comment and every `var(--x)` in prose.
 * CSS-in-TS lives in template literals, so those are the only spans read — which keeps the check
 * precise without teaching it to parse TypeScript.
 */
async function cssOf(absolute: string, path: string): Promise<string> {
  const source = await readFile(absolute, 'utf8');
  if (path.endsWith('.css')) return source;

  // Everything OUTSIDE a template literal is blanked in place, rather than the literals being
  // extracted and joined. Joining restarts line numbering, which made the reported line wrong for
  // exactly the CSS-in-TS files this branch exists to cover — and this file claims a line a reader can
  // open. Blanking preserves every offset, so it stays true.
  const blanked = source.split('');
  let index = 0;
  const literal = /`(?:[^`\\]|\\[\s\S])*`/g;
  for (const match of source.matchAll(literal)) {
    for (; index < match.index; index += 1) {
      if (blanked[index] !== '\n') blanked[index] = ' ';
    }
    index = match.index + match[0].length;
  }
  for (; index < blanked.length; index += 1) {
    if (blanked[index] !== '\n') blanked[index] = ' ';
  }
  return blanked.join('');
}

/**
 * The custom properties a stylesheet defines and the ones it reads.
 *
 * Both sides are collected per FILE rather than repo-wide. A token defined in one application's
 * stylesheet is not available to another's, so pooling them would let a genuine miss hide behind an
 * unrelated file that happens to define the same name.
 */
function tokens(source: string): { defined: Set<string>; used: Map<string, number> } {
  // **Comments are blanked first, and this case caught its own author.** The fix that removed the
  // `--surface` bug explains it in a comment that necessarily spells the broken declaration out, and
  // the first run flagged that comment as the defect. Replaced with spaces rather than removed so
  // every reported line number still matches the file a reader opens.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

  const defined = new Set<string>();
  // A definition is `--name:` at the start of a declaration. The `[{;]` prefix is what separates it
  // from a USE inside `var(--name, ...)`, which is preceded by `(` or `,`.
  for (const match of css.matchAll(/[{;]\s*(--[a-zA-Z0-9-]+)\s*:/g)) {
    if (match[1] !== undefined) defined.add(match[1]);
  }

  const used = new Map<string, number>();
  for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
    const name = match[1];
    if (name === undefined) continue;
    // The line number, so a failure names where to look rather than only what is wrong.
    const line = css.slice(0, match.index).split('\n').length;
    if (!used.has(name)) used.set(name, line);
  }
  return { defined, used };
}

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const channels = (hex.replace('#', '').match(/../g) ?? []).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The value of one token, per colour scheme, from the demonstrator's stylesheet.
 *
 * Reads the LAST definition inside and outside the dark block respectively, which is how the cascade
 * resolves them.
 */
function scheme(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  const outside = css.replace(darkBlock, '');
  for (const match of outside.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    if (match[1] !== undefined && match[2] !== undefined) light.set(match[1], match[2]);
  }
  for (const match of darkBlock.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    if (match[1] !== undefined && match[2] !== undefined) dark.set(match[1], match[2]);
  }
  return { light, dark };
}

describe('the text tokens meet AA against the surfaces they sit on', () => {
  // **A specific check for the one regression that actually happened**, rather than a general contrast
  // engine. `--ink-faint` carries every piece of small text in the demonstrator — field labels,
  // statistics, table headers, empty states, drawer metadata, timestamps, and the 11.5px account
  // sub-line — and it sat at 3.09:1 on white for the life of the application, because nothing measures
  // a colour and a reviewer reads it as "intentionally quiet" rather than "unreadable".
  //
  // Scoped to foreground/background pairs that are DECLARED constants, which is why this is worth
  // having: it needs no browser and no rendering, so it costs nothing and cannot drift out of date.
  const SURFACES = ['--panel', '--ground'] as const;
  const TEXT = ['--ink', '--ink-soft', '--ink-faint'] as const;
  const AA_NORMAL = 4.5;

  it('holds in light and in dark', async () => {
    const css = await readFile(
      resolve(repoRoot, 'examples/customer-dashboard/src/styles.css'),
      'utf8',
    );
    const tokens = scheme(css);
    const failures: string[] = [];

    for (const [name, palette] of [
      ['light', tokens.light],
      ['dark', tokens.dark],
    ] as const) {
      for (const text of TEXT) {
        for (const surface of SURFACES) {
          const fg = palette.get(text);
          const bg = palette.get(surface);
          if (fg === undefined || bg === undefined) {
            failures.push(`${name}: ${text} or ${surface} is not defined as a hex value`);
            continue;
          }
          const ratio = contrast(fg, bg);
          if (ratio < AA_NORMAL) {
            failures.push(
              `${name}: ${text} (${fg}) on ${surface} (${bg}) is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}`,
            );
          }
        }
      }
    }

    expect(failures, `text that cannot be read:\n${failures.join('\n')}`).toEqual([]);
  });
});

describe('every custom property a stylesheet uses is one it defines', () => {
  it('finds no undefined token, with or without a fallback', async () => {
    const offenders: string[] = [];

    for (const path of await stylesheets()) {
      const { defined, used } = tokens(await cssOf(resolve(repoRoot, path), path));
      for (const [name, line] of used) {
        if (!defined.has(name)) offenders.push(`${path}:${line} — var(${name}) is never defined`);
      }
    }

    expect(
      offenders,
      `these stylesheets read a custom property nothing defines. CSS does not report this: the ` +
        `declaration is invalid at computed-value time, so the property silently falls back to its ` +
        `inherited or initial value and the page still renders — usually looking correct in whichever ` +
        `colour scheme the author had open:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('checks stylesheets that actually exist, so the case cannot pass by vacancy', async () => {
    // A table-driven check whose inputs vanished would pass every run while checking nothing, which is
    // the failure mode this repository names in `module-seams.spec.ts` and worth repeating here.
    const sheets = await stylesheets();
    expect(sheets.length).toBeGreaterThan(0);

    // And at least one of them genuinely uses tokens — a repository of stylesheets that defined none
    // would also pass the case above.
    let usages = 0;
    for (const path of sheets) {
      usages += tokens(await cssOf(resolve(repoRoot, path), path)).used.size;
    }
    expect(usages).toBeGreaterThan(0);
  });
});
