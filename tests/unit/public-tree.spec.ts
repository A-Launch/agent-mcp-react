import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The publish check, driven through its real command line against fixture git repositories.
//
// Black-box on purpose: the check is a gate command in two repositories, and what matters is what
// the COMMAND reports and exits with, not what a function returns. Every case here builds a small
// git repository (the check reads tracked paths, so a bare directory would not exercise it), runs
// `scripts/verify-public.mjs` in it, and reads the report.
//
// The one case that is not a fixture is the first: the REAL config, run over THIS repository. The
// four files that spell the forbidden patterns are exempt from the string rules, and the only way to
// know that exemption holds on the real inputs is to run the real inputs. A config that failed its
// own scanner would be found by every CI run — after it shipped.
//
// Many cases below are a review finding made permanent: each was a way the first draft printed PASS
// over something it should have refused (a symbolic link followed, a stale output directory, a
// quoted filename in history, a tilde fence hiding a backtick fence). Every rule has a break-it
// recorded in the feature's task list: delete the rule's branch in `scripts/lib/public-tree.mjs`,
// and its case goes red — and a case that would stay green is a defect in this file, not evidence.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = resolve(repoRoot, 'scripts/verify-public.mjs');
const realConfig = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/public-tree.json'), 'utf8'),
) as {
  tree: string;
  selfExempt: string[];
  mapped: Record<string, string>;
  forbidden: Array<{ name: string; pattern: string | number }>;
};

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cwd: string, ...args: string[]): Run {
  try {
    const stdout = execFileSync('node', [cli, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (cause) {
    const failure = cause as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** The rule lines of a report, e.g. `PASS link` or `FAIL citation (3)`. */
function verdicts(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^(PASS|FAIL) ([a-z-]+)/.exec(line);
    if (m !== null) out[m[2] ?? ''] = m[1] ?? '';
  }
  return out;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface Fixture {
  readonly root: string;
  write(path: string, content: string): void;
  config(overrides: Record<string, unknown>): void;
  commit(message?: string): string;
}

/** A git repository holding the real config with `tree` set, plus whatever a case writes. */
function fixture(tree: 'companion' | 'public', files: Record<string, string> = {}): Fixture {
  const root = temp('amr-public-tree-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  const write = (path: string, content: string): void => {
    const full = resolve(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const config = (overrides: Record<string, unknown>): void =>
    write(
      'scripts/public-tree.json',
      JSON.stringify({ ...realConfig, tree, ...overrides }, null, 2),
    );
  config({});
  if (tree === 'companion') {
    write('.specify/public/CLAUDE.md', 'public claude\n');
    write('.specify/public/AGENTS.md', 'public agents\n');
  }
  write('CLAUDE.md', tree === 'companion' ? 'long companion claude\n' : 'public claude\n');
  write('AGENTS.md', tree === 'companion' ? 'long companion agents\n' : 'public agents\n');
  write('.gitignore', '.env\n');
  for (const [path, content] of Object.entries(files)) write(path, content);
  return {
    root,
    write,
    config,
    commit(message = 'fixture'): string {
      git(root, 'add', '--all');
      git(root, 'commit', '-q', '-m', message);
      return git(root, 'rev-parse', 'HEAD').trim().slice(0, 12);
    },
  };
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}

describe('the real config, over this repository', () => {
  it('never reports a finding against the files that must spell the patterns', () => {
    const out = temp('amr-export-');
    const result = run(repoRoot, '--out', out);
    expect(result.stdout).toMatch(/^tree: (companion|public)\n/);
    // Exit 1 is the tree's remaining debt and is allowed here; exit 2 is a config that cannot run.
    expect(result.status, result.stderr).not.toBe(2);
    const offending = result.stdout
      .split('\n')
      .filter((line) => realConfig.selfExempt.some((path) => line.trimStart().startsWith(path)));
    expect(offending).toEqual([]);
  });
});

describe('companion mode', () => {
  it('omits hidden paths, replaces mapped destinations and flips the exported config to public', () => {
    const fx = fixture('companion', {
      'specs/001-x/spec.md': 'hidden\n',
      'MVP-PLAN.md': 'hidden\n',
      'docs/a.md': '# A\n\nclean\n',
    });
    const out = temp('amr-export-');
    const result = run(fx.root, '--out', out);
    expect(verdicts(result.stdout)['hidden-path']).toBe('PASS');
    expect(existsSync(join(out, 'specs'))).toBe(false);
    expect(existsSync(join(out, 'MVP-PLAN.md'))).toBe(false);
    expect(existsSync(join(out, '.specify'))).toBe(false);
    expect(readFileSync(join(out, 'CLAUDE.md'), 'utf8')).toBe('public claude\n');
    expect(readFileSync(join(out, 'AGENTS.md'), 'utf8')).toBe('public agents\n');
    const exportedConfig = readFileSync(join(out, 'scripts/public-tree.json'), 'utf8');
    expect(exportedConfig).toContain('"tree": "public"');
    expect(exportedConfig).not.toContain('"tree": "companion"');
    expect(result.status).toBe(0);
  });

  it('rewrites the tree member whatever the JSON spacing, and nothing else', () => {
    const fx = fixture('companion');
    const compact = JSON.stringify({ ...realConfig, tree: 'companion' });
    fx.write('scripts/public-tree.json', compact);
    const out = temp('amr-export-');
    const result = run(fx.root, '--out', out);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(out, 'scripts/public-tree.json'), 'utf8')).toBe(
      compact.replace('"tree":"companion"', '"tree":"public"'),
    );
  });

  it('refuses, with the path, when a mapped source is missing', () => {
    const fx = fixture('companion');
    rmSync(join(fx.root, '.specify/public/AGENTS.md'));
    const result = run(fx.root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('.specify/public/AGENTS.md');
    expect(result.stdout).not.toContain('PASS');
  });

  it('refuses a mapped source that is a symbolic link, rather than copying what it points at', () => {
    const fx = fixture('companion');
    const outside = temp('amr-outside-');
    writeFileSync(join(outside, 'secret.md'), 'sk-ant-LINKED\n');
    rmSync(join(fx.root, '.specify/public/CLAUDE.md'));
    symlinkSync(join(outside, 'secret.md'), join(fx.root, '.specify/public/CLAUDE.md'));
    const out = temp('amr-export-');
    const result = run(fx.root, '--out', out);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('symbolic link');
    expect(existsSync(join(out, 'CLAUDE.md'))).toBe(false);
  });

  it('refuses --history: the companion history is not the subject', () => {
    const fx = fixture('companion');
    fx.commit();
    const result = run(fx.root, '--history');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/history/);
  });
});

describe('public mode', () => {
  it('reports a hidden path through the CLI rather than removing it', () => {
    const fx = fixture('public', { 'specs/notes.md': 'a contributor added this\n' });
    const out = temp('amr-export-');
    const result = run(fx.root, '--out', out);
    expect(result.status).toBe(1);
    expect(verdicts(result.stdout)['hidden-path']).toBe('FAIL');
    expect(result.stdout).toContain('specs/notes.md');
    expect(existsSync(join(out, 'specs/notes.md'))).toBe(true);
  });

  it('reports a mapped source that reached the public tree', () => {
    const fx = fixture('public', { '.specify/public/CLAUDE.md': 'leaked\n' });
    const result = run(fx.root);
    expect(result.status).toBe(1);
    expect(verdicts(result.stdout).mapped).toBe('FAIL');
    expect(result.stdout).toContain('.specify/public/CLAUDE.md');
  });

  it('reports a missing mapped destination', () => {
    const fx = fixture('public');
    rmSync(join(fx.root, 'AGENTS.md'));
    const result = run(fx.root);
    expect(verdicts(result.stdout).mapped).toBe('FAIL');
    expect(result.stdout).toContain('AGENTS.md');
  });

  it('is an identity: the export is byte-identical to the tracked tree, and exporting it again is too', () => {
    const fx = fixture('public', { 'docs/a.md': '# A\n\nclean\n', 'src/x.ts': 'export {};\n' });
    const first = temp('amr-export-');
    expect(run(fx.root, '--out', first).status).toBe(0);
    expect(listFiles(first)).toEqual(listFiles(fx.root));
    for (const path of listFiles(first)) {
      expect(readFileSync(join(first, path))).toEqual(readFileSync(join(fx.root, path)));
    }
    // The export is not a git repository; exporting it requires one, so re-run on a fresh fixture
    // seeded with the exported files.
    const again = fixture('public');
    for (const path of listFiles(first)) again.write(path, readFileSync(join(first, path), 'utf8'));
    const second = temp('amr-export-');
    expect(run(again.root, '--out', second).status).toBe(0);
    expect(listFiles(second)).toEqual(listFiles(first));
  });
});

describe('what is never read or written', () => {
  it.each(['companion', 'public'] as const)(
    'an ignored .env holding a credential is neither exported nor scanned (%s)',
    (tree) => {
      const fx = fixture(tree, { '.env': 'ANTHROPIC_API_KEY=sk-ant-REALLOOKING\n' });
      const out = temp('amr-export-');
      const result = run(fx.root, '--out', out);
      expect(verdicts(result.stdout).credential).toBe('PASS');
      expect(existsSync(join(out, '.env'))).toBe(false);
    },
  );

  it('a tracked file reached through a symbolic-link directory is a finding and is not copied', () => {
    const fx = fixture('public', { 'docs/real/a.md': '# A\n' });
    fx.commit();
    const outside = temp('amr-outside-');
    mkdirSync(join(outside, 'real'));
    writeFileSync(join(outside, 'real/a.md'), 'sk-ant-THROUGHLINK\n');
    rmSync(join(fx.root, 'docs/real'), { recursive: true });
    symlinkSync(join(outside, 'real'), join(fx.root, 'docs/real'));
    const out = temp('amr-export-');
    const result = run(fx.root, '--out', out);
    expect(verdicts(result.stdout).symlink).toBe('FAIL');
    expect(result.stdout).toContain('docs/real/a.md');
    expect(existsSync(join(out, 'docs/real/a.md'))).toBe(false);
    expect(verdicts(result.stdout).credential).toBe('PASS');
  });

  it('refuses an output directory inside the tree, and one that is not empty', () => {
    const fx = fixture('public', { 'docs/a.md': '# A\n' });
    const inside = run(fx.root, '--out', '.');
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain('disjoint');
    expect(readFileSync(join(fx.root, 'CLAUDE.md'), 'utf8')).toBe('public claude\n');
    const stale = temp('amr-export-');
    writeFileSync(join(stale, 'left-over.md'), 'from a previous run\n');
    const reused = run(fx.root, '--out', stale);
    expect(reused.status).toBe(2);
    expect(reused.stderr).toContain('empty');
    expect(reused.stdout).not.toContain('PASS');
  });

  it('refuses a mapped destination that would leave the export, at load time', () => {
    const fx = fixture('companion');
    fx.config({ mapped: { ...realConfig.mapped, '.specify/public/X.md': '../escaped.md' } });
    const out = temp('amr-export-');
    const result = run(fx.root, '--out', out);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('..');
    expect(existsSync(resolve(out, '../escaped.md'))).toBe(false);
  });
});

describe('the string rules', () => {
  it('personal-path: a path on one machine fails, and names file and line', () => {
    const fx = fixture('public', { 'docs/a.md': '# A\n\nsee /Users/alice/work/thing\n' });
    const result = run(fx.root);
    expect(verdicts(result.stdout)['personal-path']).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:3');
  });

  it('credential: a placeholder passes, a real-looking key fails without echoing it', () => {
    const fx = fixture('public', {
      'tests/x.spec.ts': "const token = 'sk-ant-SECRETKEY';\n",
      'docs/b.md': '# B\n\nkey ghp_abcdefghijklmnopqrstuvwxyz0123\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).credential).toBe('FAIL');
    expect(result.stdout).toContain('docs/b.md:3');
    expect(result.stdout).not.toContain('tests/x.spec.ts');
    expect(result.stdout).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('credential: any value after ANTHROPIC_API_KEY= fails, except the documented ellipsis', () => {
    const fx = fixture('public', {
      'docs/a.md': '# A\n\nANTHROPIC_API_KEY=abcdefghijklmno\n',
      'docs/b.md': '# B\n\nRestart it as `ANTHROPIC_API_KEY=… pnpm dev:agent`.\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).credential).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:3');
    expect(result.stdout).not.toContain('docs/b.md');
  });

  it('credential: a finding under another rule never echoes a credential on the same line', () => {
    const fx = fixture('public', {
      'docs/a.md': '# A\n\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123 per §13\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).citation).toBe('FAIL');
    expect(result.stdout).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('scans every exported file: one under a tracked node_modules, and one holding a NUL byte', () => {
    const fx = fixture('public', {
      'node_modules/fixture/key.txt': 'sk-ant-TRACKEDDEP\n',
      'docs/blob.md': '\u0000# B\n\nsk-ant-AFTERNUL [gone](./missing.md)\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).credential).toBe('FAIL');
    expect(result.stdout).toContain('node_modules/fixture/key.txt');
    expect(result.stdout).toContain('docs/blob.md');
    expect(verdicts(result.stdout).link).toBe('FAIL');
  });

  it('citation: a section sign fails everywhere except the release notes', () => {
    const fx = fixture('public', {
      'docs/a.md': '# A\n\nper §13\n',
      'docs/releases/0.1.0.md': '# 0.1.0\n\nper §50 and the constitution\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).citation).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:3');
    expect(result.stdout).not.toContain('docs/releases/0.1.0.md');
    expect(verdicts(result.stdout).vocabulary).toBe('PASS');
  });

  it('vocabulary: the mandated contact passes, a plugin name fails, case does not matter', () => {
    const fx = fixture('public', {
      'SECURITY.md': '# Security\n\nWrite to research@thekaliper.com\n',
      'docs/a.md': '# A\n\nrecorded with kaliper:demo-video\n',
      'docs/b.md': '# B\n\nThe Constitution says\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).vocabulary).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:3');
    expect(result.stdout).toContain('docs/b.md:3');
    expect(result.stdout).not.toContain('SECURITY.md');
  });

  it('vocabulary: a commit scope and a task id are caught, ordinary parentheses are not', () => {
    // The prose forms were caught from the start; these two were not, and both reached the first
    // commit ever published — `docs(027): T071 …`. A feature number written the way this repository's
    // own commit convention writes it is still a feature number, and a task id points at a document
    // that is never published.
    const fx = fixture('public', {
      'docs/a.md': '# A\n\nlanded as docs(027) on a Tuesday\n',
      'docs/b.md': '# B\n\nsee T071 and T069a for the detail\n',
      'docs/ok.md': '# Fine\n\ncall it with resolve(url) and a status (200) afterwards\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).vocabulary).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:3');
    expect(result.stdout).toContain('docs/b.md:3');
    expect(result.stdout).not.toContain('docs/ok.md');
  });

  it('copyright-owner: an individual on the line fails, the owner passes, a third party is untouched', () => {
    // `LICENSE` carried `Copyright 2026 Nikolay Kvasov` in its appendix while `NOTICE` carried the
    // owner's line — the two disagreed in the published tree, and in the file that ships inside the
    // package. The ownership record named NOTICE, package.json#author and the README as its
    // projections; LICENSE was not on that list, which is why it drifted unnoticed.
    const fx = fixture('public', {
      LICENSE: '# Terms\n\nCopyright 2026 Someone Else\n',
      NOTICE: '# Notice\n\nCopyright 2026 A-Launch Inc. Originally written by Nikolay Kvasov.\n',
      // A third-party notice writes its year differently, and must not be caught.
      'docs/third-party.md': '# Third party\n\nCopyright © [$year] World Wide Web Consortium.\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout)['copyright-owner']).toBe('FAIL');
    expect(result.stdout).toContain('LICENSE:3');
    expect(result.stdout).not.toContain('NOTICE:');
    expect(result.stdout).not.toContain('docs/third-party.md');
  });

  it('docs/media/ is exempt from the two vocabulary rules and from nothing else', () => {
    // Binary media is scanned like every other file — the walker skips nothing — and compressed video
    // decodes to stray section marks and short tokens by chance: 161 citation findings and 1790
    // vocabulary findings on one recording. That is noise by construction, and a rule that reports
    // noise is a rule people learn to ignore.
    //
    // **The exemption is two rules, not the directory.** A credential or a personal path in that
    // directory is still a finding, because those patterns are long enough not to arise by accident
    // and are the ones worth catching.
    const fx = fixture('public', {
      'docs/media/demo.gif': 'pretend bytes with a § and the word speckit in them\n',
      'docs/media/leak.bin': 'pretend bytes carrying sk-ant-000 and /Users/someone/notes\n',
    });
    const result = run(fx.root);
    const v = verdicts(result.stdout);
    expect(v.citation).toBe('PASS');
    expect(v.vocabulary).toBe('PASS');
    expect(v.credential).toBe('FAIL');
    expect(v['personal-path']).toBe('FAIL');
    expect(result.stdout).toContain('docs/media/leak.bin');
    expect(result.stdout).not.toContain('docs/media/demo.gif');
  });

  it('an absolute link back into this repository is resolved and checked like a relative one', () => {
    // The README is published to two places. Relative links work in the repository and are dead on
    // the package page — sixteen of them were broken there before anyone looked — so the documentation
    // links are absolute. An absolute link used to be skipped outright, which would have traded a
    // working link for a lost guard.
    const fx = fixture('public', {
      'package.json': `${JSON.stringify({ name: 'x', repository: { url: 'https://github.com/acme/widget.git' } })}\n`,
      'docs/real.md': '# Real\n\n## A heading\n',
      'README.md': [
        '# R',
        '',
        '[ok](https://github.com/acme/widget/blob/main/docs/real.md)',
        '[ok anchor](https://github.com/acme/widget/blob/main/docs/real.md#a-heading)',
        '[raw](https://raw.githubusercontent.com/acme/widget/main/docs/real.md)',
        '[dead](https://github.com/acme/widget/blob/main/docs/missing.md)',
        '[dead anchor](https://github.com/acme/widget/blob/main/docs/real.md#nope)',
        // Somebody else's repository is still none of our business.
        '[elsewhere](https://github.com/other/repo/blob/main/whatever.md)',
        '',
      ].join('\n'),
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).link).toBe('FAIL');
    expect(result.stdout).toContain('docs/missing.md');
    expect(result.stdout).toContain('#nope');
    expect(result.stdout).not.toContain('other/repo');
    expect(result.stdout).not.toContain('docs/real.md → ');
  });

  it('the four files that spell the patterns are exempt from every string rule', () => {
    const fx = fixture('public', {
      'scripts/lib/public-tree.mjs': '// matches /Users/alice and sk-ant-X and § and kaliper\n',
    });
    const result = run(fx.root);
    for (const rule of ['personal-path', 'credential', 'citation', 'vocabulary']) {
      expect(verdicts(result.stdout)[rule], rule).toBe('PASS');
    }
  });
});

describe('the link rule', () => {
  it('fails a missing file and a missing anchor, and names the line', () => {
    const fx = fixture('public', {
      'docs/a.md': '# A\n\n[gone](./missing.md)\n\n[no such](./b.md#nowhere)\n',
      'docs/b.md': '# B\n\n## Present\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).link).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:3');
    expect(result.stdout).toContain('docs/a.md:5');
  });

  it('resolves headings, duplicates, directories, encoded and root-relative paths; skips fences, code spans and URLs', () => {
    const fx = fixture('public', {
      'docs/a.md': [
        '# A',
        '',
        '[ok](./b.md#present) [dup](./b.md#twice-1) [dir](../docs/) [self](#a) [root](/README.md)',
        '[web](https://example.com/x.md) [mail](mailto:research@thekaliper.com)',
        '[space](./a%20b.md) [setext](./b.md#under-lined) [gap](./b.md#foo--bar)',
        '[foo](./b.md#foo) [foo1](./b.md#foo-1) [foo11](./b.md#foo-1-1)',
        'An example in code: `[example](no-such-file.md)` is not a link.',
        '',
        '```md',
        '[not a link](./nope.md)',
        '```',
        '',
        '~~~',
        '```',
        '~~~',
        '',
        '````',
        '```',
        '````',
        '',
        '[after fences](./b.md#present)',
      ].join('\n'),
      'docs/a b.md': '# Space\n',
      'docs/b.md': [
        '# B',
        '',
        '## Present',
        '',
        '## Twice',
        '',
        '## Twice',
        '',
        'Under lined',
        '-----------',
        '',
        '## Foo  bar',
        '',
        '## Foo',
        '',
        '## Foo',
        '',
        '## Foo-1',
      ].join('\n'),
      'README.md': '# R\n',
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).link, result.stdout).toBe('PASS');
  });

  it('checks a reference definition, and a link after a tilde fence that contained a backtick fence', () => {
    const fx = fixture('public', {
      'docs/a.md': [
        '# A',
        '',
        '[broken][ref]',
        '',
        '[ref]: ./no-such-file.md',
        '',
        '~~~',
        '```',
        '~~~',
        '',
        '[also broken](./missing.md)',
      ].join('\n'),
    });
    const result = run(fx.root);
    expect(verdicts(result.stdout).link).toBe('FAIL');
    expect(result.stdout).toContain('docs/a.md:5');
    expect(result.stdout).toContain('docs/a.md:11');
  });

  it('refuses a target that escapes the tree even when something exists there on the host', () => {
    const fx = fixture('public', { 'docs/a.md': '# A\n\n[out](../../external.md#outside)\n' });
    const out = temp('amr-export-');
    writeFileSync(resolve(out, '../external.md'), '# Outside\n');
    temps.push(resolve(out, '../external.md'));
    const result = run(fx.root, '--out', out);
    expect(verdicts(result.stdout).link).toBe('FAIL');
    expect(result.stdout).toContain('escapes the tree');
  });
});

describe('history mode', () => {
  it('passes a clean history', () => {
    const fx = fixture('public', { 'docs/a.md': '# A\n' });
    fx.commit('one');
    fx.write('docs/a.md', '# A\n\nmore\n');
    fx.commit('two');
    const result = run(fx.root, '--history');
    expect(result.status, result.stdout).toBe(0);
    expect(verdicts(result.stdout)['history-path']).toBe('PASS');
    expect(verdicts(result.stdout)['history-string']).toBe('PASS');
  });

  it('finds a hidden path that a commit added and a later commit deleted, unicode name included', () => {
    const fx = fixture('public');
    fx.commit('one');
    fx.write('specs/café.md', 'oops\n');
    const offending = fx.commit('two');
    rmSync(join(fx.root, 'specs'), { recursive: true });
    fx.commit('three');
    const result = run(fx.root, '--history');
    expect(verdicts(result.stdout)['hidden-path']).toBe('PASS');
    expect(verdicts(result.stdout)['history-path']).toBe('FAIL');
    expect(result.stdout).toContain(`${offending} specs/café.md`);
  });

  it('finds a credential and a personal path a commit carried and a later commit removed, attributed to the commit', () => {
    const fx = fixture('public');
    fx.commit('one');
    fx.write('docs/a.md', '# A\n\nkey AKIA0123456789ABCDEF\n');
    fx.write('docs/b.md', '# B\n\nat /Users/alice/x\n');
    const offending = fx.commit('two');
    fx.write('docs/a.md', '# A\n\nclean\n');
    fx.write('docs/b.md', '# B\n\nclean\n');
    fx.commit('three');
    const result = run(fx.root, '--history');
    expect(verdicts(result.stdout).credential).toBe('PASS');
    expect(verdicts(result.stdout)['history-string']).toBe('FAIL');
    expect(result.stdout).toContain(`${offending} docs/a.md:3  credential:`);
    expect(result.stdout).toContain(`${offending} docs/b.md:3  personal-path:`);
    expect(result.stdout).not.toContain('AKIA0123456789ABCDEF');
  });

  it('is not fooled by a -diff attribute, a line beginning ++, or an exempt file changed in the same commit', () => {
    const fx = fixture('public', { '.gitattributes': 'key.txt -diff\n' });
    fx.commit('one');
    fx.write('key.txt', 'sk-ant-BINARYATTR\n');
    fx.write('docs/a.md', '# A\n\n++ ghp_abcdefghijklmnopqrstuvwxyz0123\n');
    fx.write('scripts/lib/public-tree.mjs', '// spells sk-ant- on purpose\n');
    fx.write('zürich.txt', 'AKIA0123456789ABCDEF\n');
    fx.commit('two');
    rmSync(join(fx.root, 'key.txt'));
    rmSync(join(fx.root, 'zürich.txt'));
    fx.write('docs/a.md', '# A\n');
    fx.commit('three');
    const result = run(fx.root, '--history');
    expect(verdicts(result.stdout)['history-string']).toBe('FAIL');
    expect(result.stdout).toContain('key.txt');
    expect(result.stdout).toContain('docs/a.md');
    expect(result.stdout).toContain('zürich.txt');
    expect(result.stdout).not.toContain('scripts/lib/public-tree.mjs');
  });

  it('refuses a shallow clone rather than reporting its truncated history as clean', () => {
    const fx = fixture('public');
    fx.commit('one');
    fx.write('specs/private.md', 'oops\n');
    fx.commit('two');
    rmSync(join(fx.root, 'specs'), { recursive: true });
    fx.commit('three');
    const shallow = temp('amr-shallow-');
    git(shallow, 'clone', '-q', '--depth', '1', `file://${fx.root}`, 'clone');
    const result = run(join(shallow, 'clone'), '--history');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('shallow');
    expect(result.stdout).not.toContain('PASS history');
  });
});

describe('what it cannot evaluate', () => {
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable file is an error, and nothing is reported as passed',
    () => {
      const fx = fixture('public', { 'docs/a.md': '# A\n' });
      chmodSync(join(fx.root, 'docs/a.md'), 0o000);
      const result = run(fx.root);
      chmodSync(join(fx.root, 'docs/a.md'), 0o644);
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain('PASS');
    },
  );

  it('a config with an unknown field, or a pattern that is not a string, is refused before any file is read', () => {
    const fx = fixture('public');
    fx.config({ extra: 1 });
    const unknown = run(fx.root);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('extra');
    fx.config({
      forbidden: realConfig.forbidden.map((r) =>
        r.name === 'credential' ? { ...r, pattern: 42 } : r,
      ),
    });
    fx.write('docs/a.md', '# A\n\nsk-ant-SHOULDFAIL\n');
    const numeric = run(fx.root);
    expect(numeric.status).toBe(2);
    expect(numeric.stderr).toContain('pattern');
  });

  it('an unknown or repeated argument is an error, not a weaker run', () => {
    const fx = fixture('public');
    fx.commit();
    const typo = run(fx.root, '--histroy');
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain('--histroy');
    expect(typo.stdout).not.toContain('PASS');
    const twice = run(fx.root, '--history', '--history');
    expect(twice.status).toBe(2);
  });
});
