#!/usr/bin/env node
/**
 * One-shot cleanup for op-action observation atoms accumulated by
 * gh-as.mjs. Each gh-as invocation pre-fix wrote one
 * `op-action-<role>-<ms>-<uuid>` atom; in a busy session that
 * accumulates thousands of write-only-then-forgotten audit atoms
 * that overwhelm the file-host and drown out load-bearing atoms in
 * timeline projections.
 *
 * Verified safe: `op-action-*` atoms have no consumers in src/ or
 * apps/ (write-only audit; the gh op itself is the load-bearing
 * artifact). Pre-merge, run with `--dry-run` to preview.
 *
 * Usage:
 *   node scripts/prune-op-action-atoms.mjs --root-dir <path>
 *                                          [--older-than-days <N>]
 *                                          [--dry-run]
 *
 *   --root-dir          required. The state dir (e.g., `.lag`).
 *   --older-than-days   optional, default 7. Atoms with
 *                       `created_at` older than N days are pruned.
 *                       Pass 0 to prune every op-action atom.
 *   --dry-run           print counts and the first 5 candidate ids,
 *                       do not delete.
 *
 * Exit codes: 0 on clean run; 2 on argument error.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, stat, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = { rootDir: null, olderThanDays: 7, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root-dir' && i + 1 < argv.length) args.rootDir = argv[++i];
    else if (a === '--older-than-days' && i + 1 < argv.length) {
      args.olderThanDays = Number(argv[++i]);
      if (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 0) {
        console.error('ERROR: --older-than-days must be a non-negative number.');
        process.exit(2);
      }
    } else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: node scripts/prune-op-action-atoms.mjs --root-dir <path>',
        '       [--older-than-days <N>] [--dry-run]',
        '',
        'Deletes op-action-* atoms older than N days from <root-dir>/atoms.',
        'Verified safe: no consumers of these atoms exist in src/ or apps/.',
      ].join('\n'));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.rootDir === null) {
    console.error('ERROR: --root-dir <path> is required.');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = resolve(args.rootDir);
  const atomsDir = join(rootDir, 'atoms');
  if (!existsSync(atomsDir)) {
    console.error(`ERROR: ${atomsDir} does not exist.`);
    process.exit(2);
  }

  const cutoffMs = args.olderThanDays === 0
    ? Infinity
    : Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000;

  const entries = await readdir(atomsDir);
  const opActionFiles = entries.filter((name) => name.startsWith('op-action-') && name.endsWith('.json'));

  let candidates = 0;
  let pruned = 0;
  let kept = 0;
  let read_errors = 0;
  const sample = [];

  for (const name of opActionFiles) {
    const path = join(atomsDir, name);
    let createdMs;
    try {
      // Trust the atom's own created_at over filesystem mtime (mtime
      // gets bumped by tooling that touches files; created_at is the
      // logical timestamp the auditor wrote).
      const json = JSON.parse(await readFile(path, 'utf8'));
      createdMs = Date.parse(json.created_at);
      if (!Number.isFinite(createdMs)) {
        // Fall back to mtime if the atom JSON is malformed.
        const s = await stat(path);
        createdMs = s.mtimeMs;
      }
    } catch {
      // Unreadable atom: skip rather than prune (operator can
      // investigate manually).
      read_errors += 1;
      continue;
    }

    const eligible = args.olderThanDays === 0 || createdMs < cutoffMs;
    if (!eligible) {
      kept += 1;
      continue;
    }
    candidates += 1;
    if (sample.length < 5) sample.push(name);

    if (!args.dryRun) {
      try {
        await unlink(path);
        pruned += 1;
      } catch (err) {
        console.warn(`[prune] failed to delete ${name}: ${err?.message ?? err}`);
      }
    }
  }

  const mode = args.dryRun ? 'dry-run' : 'pruned';
  console.log(
    `[prune-op-action] mode=${mode} root=${atomsDir} cutoff_days=${args.olderThanDays} `
    + `total_op_action=${opActionFiles.length} candidates=${candidates} ${mode}=${args.dryRun ? candidates : pruned} kept=${kept} read_errors=${read_errors}`,
  );
  if (sample.length > 0) {
    console.log('[prune-op-action] sample:');
    for (const n of sample) console.log(`  ${n}`);
  }
}

await main();
