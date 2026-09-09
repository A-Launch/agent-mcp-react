// What the public tree is, produced and checked from one description.
//
// `scripts/public-tree.json` says which tracked paths never leave the private companion, which
// companion files are exported under a public name, and which strings must not appear in anything
// published. This module is the only code that reads it, and it serves two callers with one
// behaviour: `scripts/verify-public.mjs` (the gate command, in BOTH repositories) and the companion's
// sync. A second reader of that file would be a second opinion about what is public (IMMUNE-N).
//
// Invariants, each of which a review found a draft of this file breaking:
//
//   - The input is the TRACKED path set (`git ls-files`), never the filesystem, and no copy ever
//     passes through a symbolic link — not the file, not a directory above it, not a mapped source.
//     An ignored `.env` is neither exported nor scanned, and a link cannot smuggle one in.
//   - The export writes only into an EMPTY directory that is disjoint from the tree, and only at
//     relative destinations inside it. A stale output directory would keep a hidden file while every
//     rule printed PASS; an output inside the tree would overwrite the source.
//   - In the public repository the export is an IDENTITY THAT REPORTS: a hidden path found there is a
//     finding, never removed. Sanitising before checking would pass a forbidden path that a
//     contributor's pull request had just added.
//   - Every exported file is scanned. There is no "binary" exemption, no directory the walk skips,
//     and every excerpt is redacted of anything credential-shaped before it is printed — a finding
//     under one rule must not echo what another rule exists to keep out.
//   - History is checked from BLOBS, not diffs: every commit reachable from the ref, every path in
//     its tree, every distinct blob's content. Git's diff presentation (quoted names, `-diff`
//     attributes, lines that begin with `++`) cannot hide anything from a scan that never reads a
//     diff. A shallow clone is refused, because its history is not the history.
//
// Every failure names the rule, the path, the line and the reason, because the person who has just
// tripped a rule they never read needs the reason more than the rule (the precedent is
// `tests/unit/module-seams.spec.ts`). Anything this module cannot evaluate is thrown, never reported
// as a pass (IMMUNE-U).

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

/** Which repository a checkout is. The export rewrites the config from the first to the second. */
export const TREE = Object.freeze({ companion: 'companion', public: 'public' });

/**
 * The rules, in report order. The five pattern rules are configured; the others take no pattern and
 * are always on. `history-*` rules run only under `--history`.
 */
export const RULES = Object.freeze([
  'hidden-path',
  'mapped',
  'symlink',
  'personal-path',
  'credential',
  'citation',
  'vocabulary',
  'copyright-owner',
  'link',
  'history-path',
  'history-string',
]);

const PATTERN_RULES = Object.freeze([
  'personal-path',
  'credential',
  'citation',
  'vocabulary',
  'copyright-owner',
]);
const HISTORY_RULES = Object.freeze(['personal-path', 'credential']);

const WHY = Object.freeze({
  'hidden-path':
    'a path of the private workflow is in a public checkout; nothing removes it, and it must not be merged',
  mapped:
    'the companion exports a private source under a public name; the public tree must hold the destination and never the source',
  symlink:
    'nothing here follows a symbolic link; a path that passes through one is not copied and not trusted',
  link: 'a relative link or anchor points at nothing in the published tree',
  'history-path':
    'a commit reachable from the public branch carries a path of the private workflow',
  'history-string':
    'a commit reachable from the public branch carries a file with a personal path or a credential',
});

const CONFIG_PATH = 'scripts/public-tree.json';
const TOP_LEVEL_FIELDS = new Set([
  '$comment',
  'tree',
  'hidden',
  'mapped',
  'selfExempt',
  'placeholders',
  'forbidden',
]);
const RULE_FIELDS = new Set(['name', 'pattern', 'flags', 'exempt', 'allow', 'why']);

function fail(message) {
  throw new Error(`${CONFIG_PATH}: ${message}`);
}

/**
 * A repository-relative path with `/` separators and no way out: no leading `/`, no drive letter,
 * no backslash, no `.` or `..` segment, no empty segment except a trailing `/` where `prefix` allows
 * one. Everything in the config that names a path goes through here, so a destination like
 * `../escaped.md` is refused at load rather than written somewhere at export.
 */
function validateRelativePath(value, field, { prefix = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value))
    fail(`${field} must be a relative path with / separators: ${value}`);
  const segments = value.split('/');
  if (prefix && segments.length > 1 && segments[segments.length - 1] === '') segments.pop();
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..')
      fail(`${field} must not contain an empty, "." or ".." segment: ${value}`);
  }
}

function stringArray(value, field) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    fail(`"${field}" must be an array of strings`);
}

/**
 * Reads and validates `scripts/public-tree.json` under `root`. Throws naming the field on anything
 * unknown or malformed, before any file is read — a config that half-loads would half-check.
 */
export function loadConfig(root) {
  const path = resolve(root, CONFIG_PATH);
  if (!existsSync(path)) throw new Error(`${CONFIG_PATH} not found under ${root}`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('must be an object');

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) fail(`unknown field "${key}"`);
  }
  if (!Object.values(TREE).includes(raw.tree))
    fail(`"tree" must be one of ${Object.values(TREE).join(', ')}`);
  for (const field of ['hidden', 'selfExempt', 'placeholders']) stringArray(raw[field], field);
  for (const entry of raw.hidden) validateRelativePath(entry, 'hidden entry', { prefix: true });
  for (const entry of raw.selfExempt) validateRelativePath(entry, 'selfExempt entry');
  if (raw.placeholders.some((p) => p.length === 0)) fail('a placeholder must not be empty');

  if (raw.mapped === null || typeof raw.mapped !== 'object' || Array.isArray(raw.mapped))
    fail('"mapped" must be an object of source → destination');
  const destinations = new Set();
  for (const [source, destination] of Object.entries(raw.mapped)) {
    validateRelativePath(source, 'mapped source');
    validateRelativePath(destination, `mapped destination for ${source}`);
    if (!isUnder(source, raw.hidden)) fail(`mapped source ${source} is not under a hidden prefix`);
    if (isUnder(destination, raw.hidden))
      fail(`mapped destination ${destination} is under a hidden prefix`);
    if (destinations.has(destination)) fail(`two mapped sources share ${destination}`);
    destinations.add(destination);
  }

  if (!Array.isArray(raw.forbidden)) fail('"forbidden" must be an array of rules');
  const forbidden = raw.forbidden.map((rule, index) => {
    const at = `forbidden[${index}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule))
      fail(`${at} must be an object`);
    for (const key of Object.keys(rule)) {
      if (!RULE_FIELDS.has(key)) fail(`${at} has unknown field "${key}"`);
    }
    if (!PATTERN_RULES.includes(rule.name))
      fail(`${at}.name must be one of ${PATTERN_RULES.join(', ')}`);
    if (typeof rule.pattern !== 'string' || rule.pattern.length === 0)
      fail(`${at}.pattern must be a non-empty string`);
    if (rule.flags !== undefined && typeof rule.flags !== 'string')
      fail(`${at}.flags must be a string`);
    if (/[gy]/.test(rule.flags ?? '')) fail(`${at}.flags must not include g or y`);
    stringArray(rule.exempt, `${at}.exempt`);
    for (const entry of rule.exempt)
      validateRelativePath(entry, `${at}.exempt entry`, { prefix: true });
    stringArray(rule.allow, `${at}.allow`);
    if (rule.allow.some((a) => a.length === 0))
      fail(`${at}.allow must not contain an empty string`);
    if (typeof rule.why !== 'string' || rule.why.length === 0)
      fail(`${at}.why must be a non-empty string`);
    let regex;
    let global;
    try {
      regex = new RegExp(rule.pattern, rule.flags ?? '');
      global = new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
    } catch (cause) {
      fail(`${at}.pattern does not compile: ${cause.message}`);
    }
    return { ...rule, regex, global };
  });
  for (const name of PATTERN_RULES) {
    if (forbidden.filter((r) => r.name === name).length !== 1)
      fail(`rule "${name}" must appear exactly once`);
  }

  return { ...raw, forbidden };
}

/** True when `path` equals a prefix entry or lies under it. Segment boundaries only, never substring. */
export function isUnder(path, prefixes) {
  return prefixes.some((prefix) =>
    prefix.endsWith('/')
      ? path === prefix.slice(0, -1) || path.startsWith(prefix)
      : path === prefix || path.startsWith(`${prefix}/`),
  );
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
}

/**
 * The paths git would commit: tracked files plus untracked files that are not ignored, relative to
 * `root` with `/` separators, sorted. Throws outside a work tree.
 */
export function trackedPaths(root) {
  return git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => p.split(sep).join('/'))
    .sort();
}

/** The first path component of `path` under `root` that is a symbolic link, or undefined. */
function symlinkComponent(root, path) {
  const segments = path.split('/');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current) && !isLink(current)) return undefined; // missing is reported elsewhere
    if (isLink(current)) return relative(root, current).split(sep).join('/');
  }
  return undefined;
}

function isLink(full) {
  try {
    return lstatSync(full).isSymbolicLink();
  } catch {
    return false;
  }
}

function finding(rule, path, extra = {}) {
  return { rule, path, why: WHY[rule], ...extra };
}

function copyInto(root, path, outDir, destination = path) {
  const target = resolve(outDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(root, path), target);
}

/**
 * Refuses an output directory that is not empty, or that contains or is contained by the tree. A
 * stale directory keeps whatever it held and the report says PASS; a directory inside the tree
 * overwrites the source with its own export.
 */
function prepareOutDir(root, outDir) {
  mkdirSync(outDir, { recursive: true });
  const rootReal = realpathSync(root);
  const outReal = realpathSync(outDir);
  if (
    outReal === rootReal ||
    outReal.startsWith(rootReal + sep) ||
    rootReal.startsWith(outReal + sep)
  )
    throw new Error(`output directory ${outDir} must be disjoint from the tree ${root}`);
  if (readdirSync(outReal).length > 0) throw new Error(`output directory ${outDir} must be empty`);
  return outReal;
}

/**
 * Produces the tree that WOULD be public from the tracked paths of `root`, into `outDir`, which must
 * be empty and disjoint from `root`.
 *
 * Companion: hidden paths are omitted, each mapped source is written at its destination REPLACING the
 * companion's own file there, and the config's `tree` field is rewritten to `public` — the one
 * content change, done on that one JSON member so nothing else in the file moves. A missing mapped
 * source, or one reached through a symbolic link, throws: a public file would otherwise vanish or be
 * something else.
 *
 * Public: an identity. Every tracked path is copied unchanged; a hidden path or a present mapped
 * source is RETURNED as a finding, and a missing mapped destination too. Nothing is removed.
 *
 * A path that passes through a symbolic link is a finding in both modes and is never copied.
 */
export function exportTree(root, outDir, config) {
  const out = prepareOutDir(root, outDir);
  const paths = trackedPaths(root);
  const hidden = [];
  const mapped = [];
  const findings = [];
  const sources = Object.keys(config.mapped);
  const destinations = new Set(Object.values(config.mapped));

  for (const path of paths) {
    const link = symlinkComponent(root, path);
    if (link !== undefined) {
      findings.push(finding('symlink', path, { excerpt: `through symbolic link ${link}` }));
      continue;
    }
    if (config.tree === TREE.companion) {
      if (isUnder(path, config.hidden)) {
        hidden.push(path);
        continue;
      }
      if (destinations.has(path)) continue; // replaced by its mapped source below
      copyInto(root, path, out);
      continue;
    }
    if (isUnder(path, config.hidden)) findings.push(finding('hidden-path', path));
    if (sources.includes(path))
      findings.push(finding('mapped', path, { excerpt: 'mapped source present in a public tree' }));
    copyInto(root, path, out);
  }

  if (config.tree === TREE.companion) {
    for (const [source, destination] of Object.entries(config.mapped)) {
      if (!paths.includes(source)) throw new Error(`mapped source is missing: ${source}`);
      const link = symlinkComponent(root, source);
      if (link !== undefined)
        throw new Error(`mapped source ${source} passes through symbolic link ${link}`);
      copyInto(root, source, out, destination);
      mapped.push({ from: source, to: destination });
    }
    const configOut = resolve(out, CONFIG_PATH);
    const text = readFileSync(configOut, 'utf8');
    const member = new RegExp(`("tree"\\s*:\\s*)"${TREE.companion}"`, 'g');
    const matches = text.match(member) ?? [];
    if (matches.length !== 1)
      throw new Error(`${CONFIG_PATH}: expected exactly one "tree" member to rewrite`);
    writeFileSync(configOut, text.replace(member, `$1"${TREE.public}"`));
  } else {
    for (const destination of destinations) {
      if (!paths.includes(destination))
        findings.push(
          finding('mapped', destination, { excerpt: 'mapped destination missing from the tree' }),
        );
    }
  }

  return { hidden, mapped, findings };
}

/** Every file under `dir`, relative with `/` separators, sorted. Nothing is skipped. */
function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else found.push(relative(base, full).split(sep).join('/'));
  }
  return found.sort();
}

function stripAllowed(line, rule, config) {
  let out = line;
  for (const allowed of rule.allow) out = out.split(allowed).join('');
  if (rule.name === 'credential') {
    for (const placeholder of config.placeholders) out = out.split(placeholder).join('');
  }
  return out;
}

/** Every credential-shaped run in `text` replaced by its length, so no excerpt echoes one. */
export function redact(text, config) {
  const credential = config.forbidden.find((r) => r.name === 'credential');
  let out = text;
  for (const placeholder of config.placeholders) out = out.split(placeholder).join('<placeholder>');
  return out.replace(credential.global, (m) => `<${m.length} characters>`);
}

function excerptFor(line, config) {
  return redact(line.trim().slice(0, 120), config);
}

/**
 * Which lines of `lines` are inside a fenced code block, including the fence lines themselves. A
 * fence closes only on the same character with at least the opening length, so a tilde fence that
 * contains a backtick fence stays open, and a four-backtick block can show a three-backtick one.
 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (open === undefined) {
      if (m !== null) {
        open = { char: m[1][0], length: m[1].length };
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (m !== null && m[1][0] === open.char && m[1].length >= open.length && m[2].trim() === '')
      open = undefined;
  }
  return mask;
}

function headingText(raw) {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * The heading anchors GitHub would generate: ATX and setext headings outside fences; lower-cased,
 * punctuation removed, EACH space to a hyphen (two spaces are two hyphens), and a collision with any
 * anchor already emitted — including a generated one — suffixed with `-1`, `-2`, … until free.
 */
export function headingSlugs(markdown) {
  const lines = markdown.split('\n');
  const mask = fenceMask(lines);
  const slugs = new Set();
  const add = (text) => {
    const base = headingText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    let candidate = base;
    for (let n = 1; slugs.has(candidate); n += 1) candidate = `${base}-${n}`;
    slugs.add(candidate);
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (mask[i]) continue;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(lines[i]);
    if (atx !== null) {
      add(atx[2] ?? '');
      continue;
    }
    const next = lines[i + 1];
    if (
      next !== undefined &&
      !mask[i + 1] &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(next) &&
      lines[i].trim() !== '' &&
      !/^ {0,3}([-*+]|\d+[.)])\s/.test(lines[i]) &&
      !/^ {0,3}(=+|-+)[ \t]*$/.test(lines[i])
    ) {
      add(lines[i]);
      i += 1;
    }
  }
  return slugs;
}

const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+("[^"]*"|'[^']*'))?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;

/**
 * Every link target GitHub would render as a link in `text`, with its line: inline links and
 * reference definitions, outside fenced code and outside inline code spans. A reference that has no
 * definition renders as text and is not a link.
 */
function linkTargets(text) {
  const lines = text.split('\n');
  const mask = fenceMask(lines);
  const targets = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (mask[i]) continue;
    const line = lines[i].replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length));
    const definition = DEFINITION.exec(line);
    if (definition !== null) {
      targets.push({ line: i + 1, target: definition[1] });
      continue;
    }
    for (const m of line.matchAll(INLINE_LINK)) targets.push({ line: i + 1, target: m[1] });
  }
  return targets;
}

function checkLinks(treeReal, path, text, findings, config) {
  for (const { line, target } of linkTargets(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const hash = target.indexOf('#');
    const rawPath = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? undefined : target.slice(hash + 1);
    const report = (what) =>
      findings.push(
        finding('link', path, { line, excerpt: redact(`${target} → ${what}`, config) }),
      );
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      report('not a decodable path');
      continue;
    }
    const targetPath =
      decoded.length === 0
        ? path
        : decoded.startsWith('/')
          ? posix.normalize(decoded.slice(1))
          : posix.normalize(posix.join(posix.dirname(path), decoded));
    const full = resolve(treeReal, targetPath);
    if (full !== treeReal && !full.startsWith(treeReal + sep)) {
      report('escapes the tree');
      continue;
    }
    if (!existsSync(full)) {
      report('no such path');
      continue;
    }
    if (anchor !== undefined && anchor.length > 0) {
      if (statSync(full).isDirectory() || !/\.md$/i.test(targetPath)) {
        report('anchor on a non-page');
        continue;
      }
      let wanted;
      try {
        wanted = decodeURIComponent(anchor);
      } catch {
        report('not a decodable anchor');
        continue;
      }
      if (!headingSlugs(readFileSync(full, 'utf8')).has(wanted)) report('no such heading');
    }
  }
}

function scanLines(lines, path, rules, config, onFinding) {
  if (isUnder(path, config.selfExempt)) return;
  for (const rule of rules) {
    if (isUnder(path, rule.exempt)) continue;
    for (let i = 0; i < lines.length; i += 1) {
      if (rule.regex.test(stripAllowed(lines[i], rule, config)))
        onFinding(rule, i + 1, excerptFor(lines[i], config));
    }
  }
}

/**
 * Applies the four string rules to one piece of text that is not a file.
 *
 * The tree rules read file CONTENT, which leaves anything published alongside the files unchecked — a
 * commit message, most of all, since the outward sync carries the companion's subject and body onto
 * the public repository. `path` is what a finding is attributed to and takes part in the exemption
 * check, so a caller naming a real path gets that path's exemptions and a caller naming something
 * else ("the commit message") gets none.
 */
export function scanText(text, path, config, onFinding) {
  scanLines(text.split('\n'), path, config.forbidden, config, onFinding);
}

/**
 * Applies the four string rules to every file under `tree`, and the link rule to every Markdown
 * file. Returns findings. Throws on a file it cannot read: an unreadable file is not a pass. No file
 * is skipped for being binary and no directory is skipped by name — what is exported is what is
 * checked. `selfExempt` paths skip every string rule because they must spell the patterns; each
 * rule's `exempt` prefixes skip that rule only.
 */
export function checkTree(tree, config) {
  const treeReal = realpathSync(tree);
  const findings = [];
  for (const path of walk(treeReal)) {
    const text = readFileSync(resolve(treeReal, path), 'utf8');
    const lines = text.split('\n');
    scanLines(lines, path, config.forbidden, config, (rule, line, excerpt) =>
      findings.push({ rule: rule.name, path, line, excerpt, why: rule.why }),
    );
    if (/\.md$/i.test(path)) checkLinks(treeReal, path, text, findings, config);
  }
  return findings;
}

/** `git cat-file --batch` over `shas`: a map from blob SHA to its content as UTF-8 text. */
function blobContents(repo, shas) {
  const contents = new Map();
  if (shas.length === 0) return contents;
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repo,
    input: `${shas.join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  let offset = 0;
  while (offset < out.length) {
    const eol = out.indexOf(0x0a, offset);
    if (eol === -1) break;
    const header = out.subarray(offset, eol).toString('utf8').split(' ');
    const [sha, type, sizeText] = header;
    if (type === 'missing' || sizeText === undefined)
      throw new Error(`git cat-file could not read blob ${sha}`);
    const size = Number(sizeText);
    contents.set(sha, out.subarray(eol + 1, eol + 1 + size).toString('utf8'));
    offset = eol + 1 + size + 1;
  }
  return contents;
}

/**
 * Walks every commit reachable from `ref`. For each commit, every path in its tree is checked
 * against the hidden set and the mapped sources, and every blob's CONTENT is scanned with the
 * personal-path and credential rules (once per distinct blob and path, attributed to the first
 * commit that carries it). Nothing reads a diff, so nothing git can do to a diff's presentation
 * matters. A shallow repository is refused: its reachable history is not the history. Public tree
 * only: the companion's history is not the subject, and this throws there.
 */
export function checkHistory(repo, ref, config) {
  if (config.tree !== TREE.public)
    throw new Error(
      'history is checked in the public repository only; this checkout is the companion',
    );
  if (git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true')
    throw new Error(
      'this is a shallow clone; fetch the full history (git fetch --unshallow) first',
    );

  const findings = [];
  const sources = Object.keys(config.mapped);
  const rules = config.forbidden.filter((r) => HISTORY_RULES.includes(r.name));
  const commits = git(repo, ['rev-list', '--reverse', ref])
    .split('\n')
    .filter((c) => c.length > 0);
  const seen = new Set(); // `${sha} ${path}` already scanned
  const toScan = []; // { sha, path, commit }

  for (const commit of commits) {
    const short = commit.slice(0, 12);
    const entries = git(repo, ['ls-tree', '-r', '-z', commit])
      .split('\0')
      .filter((e) => e.length > 0);
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      const [mode, type, sha] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      if (isUnder(path, config.hidden) || sources.includes(path))
        findings.push(finding('history-path', path, { commit: short }));
      if (type !== 'blob' || mode === '120000') continue; // a symlink's target is not content
      const key = `${sha} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      toScan.push({ sha, path, commit: short });
    }
  }

  const contents = blobContents(repo, [...new Set(toScan.map((s) => s.sha))]);
  for (const { sha, path, commit } of toScan) {
    const text = contents.get(sha);
    if (text === undefined) throw new Error(`blob ${sha} for ${path} was not returned by git`);
    scanLines(text.split('\n'), path, rules, config, (rule, line, excerpt) =>
      findings.push(
        finding('history-string', path, { commit, line, excerpt: `${rule.name}: ${excerpt}` }),
      ),
    );
  }
  return findings;
}
