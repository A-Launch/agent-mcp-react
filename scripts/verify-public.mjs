#!/usr/bin/env node
// The publish check: exports the tree that WOULD be public and checks it, in both repositories.
//
//     node scripts/verify-public.mjs [--history] [--out <dir>]
//
// It prints which tree it believes it is in first, then one line per rule — PASS, or FAIL with every
// finding as `<path>:<line>  <excerpt>` and the rule's reason once — so a CI log reads top-down. Exit
// 0 only when every rule passed; 1 on any finding; 2 on anything that could not be evaluated (a bad
// config, a missing mapped source, an unreadable file, an unknown argument, `--history` in the
// companion or in a shallow clone). An error is never a pass (IMMUNE-U), and an argument this
// script does not know is an error rather than a silently weaker run.
//
// `--out` keeps the export for inspection instead of a temporary directory; it must be empty and
// outside the tree. `--history` additionally walks every commit reachable from HEAD, which needs the
// full history (CI fetches with depth 0).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkHistory,
  checkTree,
  exportTree,
  loadConfig,
  RULES,
  TREE,
} from './lib/public-tree.mjs';

function parseArgs(argv) {
  const options = { history: false, out: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--history') {
      if (options.history) throw new Error('--history given twice');
      options.history = true;
    } else if (arg === '--out') {
      if (options.out !== undefined) throw new Error('--out given twice');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--out needs a directory');
      options.out = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg} (accepted: --history, --out <dir>)`);
    }
  }
  return options;
}

const root = process.cwd();
let outDir;
let keep;

try {
  const options = parseArgs(process.argv.slice(2));
  keep = options.out;
  const config = loadConfig(root);
  process.stdout.write(`tree: ${config.tree}\n`);
  if (options.history && config.tree !== TREE.public)
    throw new Error('--history runs in the public repository only; this checkout is the companion');

  outDir = keep ?? mkdtempSync(join(tmpdir(), 'amr-public-'));
  const exported = exportTree(root, outDir, config);
  const findings = [...exported.findings, ...checkTree(outDir, config)];
  if (options.history) findings.push(...checkHistory(root, 'HEAD', config));

  const active = RULES.filter((rule) => options.history || !rule.startsWith('history-'));
  let failed = false;
  for (const rule of active) {
    const mine = findings.filter((f) => f.rule === rule);
    if (mine.length === 0) {
      process.stdout.write(`PASS ${rule}\n`);
      continue;
    }
    failed = true;
    process.stdout.write(`FAIL ${rule} (${mine.length})\n`);
    process.stdout.write(`  why: ${mine[0].why}\n`);
    for (const f of mine) {
      const at = f.line === undefined ? '' : `:${f.line}`;
      const where = f.commit === undefined ? `${f.path}${at}` : `${f.commit} ${f.path}${at}`;
      process.stdout.write(`  ${where}  ${f.excerpt ?? ''}\n`);
    }
  }
  if (keep !== undefined) process.stdout.write(`export kept at ${keep}\n`);
  process.exitCode = failed ? 1 : 0;
} catch (cause) {
  process.stderr.write(`\nverify-public could not run: ${cause?.message ?? cause}\n`);
  process.exitCode = 2;
} finally {
  if (keep === undefined && outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
}
