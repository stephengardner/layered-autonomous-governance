#!/usr/bin/env node
/**
 * Sub-agent stall watcher driver.
 *
 * Walks .worktrees/, classifies each via the pure detector in
 * scripts/lib/sub-agent-stall-detect.mjs, and prints a one-line
 * status per worktree. The parent /loop calls this once per tick
 * to know whether any sub-agent has stalled.
 *
 * Usage:
 *   node scripts/sub-agent-stall-watch.mjs [--root <dir>] [--deadline-ms <N>] [--json]
 *
 * Default --root is `<repo>/.worktrees`. Default --deadline-ms is
 * the classifier's DEFAULT_STALL_DEADLINE_MS (30 min).
 *
 * Exit codes:
 *   0 = no stalls (all worktrees fresh or silent-but-working)
 *   1 = bad usage
 *   2 = >= 1 worktree classified as 'stalled' (caller acts)
 *
 * The watcher writes NO atoms in V0; it is purely an observability
 * tool. The follow-up wires the same scanner+classifier into a
 * LoopRunner pass that writes sub-agent-stalled atoms + dispatches
 * recovery sub-agents. Shipping the read-only V0 first lets
 * operators get the signal without paying for the auto-recovery
 * machinery before they have observed enough stall cases to validate
 * the deadline default.
 *
 * Indie-floor: a solo developer runs this manually when a worktree
 * "feels stuck" and gets a deterministic verdict. Org-ceiling:
 * follow-up LoopRunner pass fires this on a configured cadence
 * (canon policy) without operator presence.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scanAllWorktrees } from './lib/scan-worktrees.mjs';
import {
  classifySubAgentProgress,
  DEFAULT_STALL_DEADLINE_MS,
} from './lib/sub-agent-stall-detect.mjs';

const args = process.argv.slice(2);
let root = null;
let deadlineMs = DEFAULT_STALL_DEADLINE_MS;
let json = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') {
    console.error(
      'usage: node scripts/sub-agent-stall-watch.mjs [--root <dir>] [--deadline-ms <N>] [--json]',
    );
    process.exit(1);
  } else if (a === '--root' && i + 1 < args.length) {
    root = args[++i];
  } else if (a === '--deadline-ms' && i + 1 < args.length) {
    // Strict integer validation. parseInt accepts trailing garbage
    // ('10ms' -> 10), masking operator typos. The exact-match regex
    // is the safer parse for a CLI flag where the only correct shape
    // is digits with an optional leading sign.
    const raw = args[++i];
    if (!/^[+-]?\d+$/.test(raw)) {
      console.error(`sub-agent-stall-watch: --deadline-ms must be a strict integer; got '${raw}'`);
      process.exit(1);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) {
      console.error(`sub-agent-stall-watch: --deadline-ms must be a positive integer; got '${raw}'`);
      process.exit(1);
    }
    deadlineMs = n;
  } else if (a === '--json') {
    json = true;
  } else {
    console.error(`sub-agent-stall-watch: unknown arg '${a}'`);
    process.exit(1);
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreesDir = root ?? resolve(repoRoot, '.worktrees');

const snapshots = scanAllWorktrees(worktreesDir);
const nowMs = Date.now();

const results = snapshots.map((snapshot) => {
  const classification = classifySubAgentProgress({
    ...snapshot,
    nowMs,
    deadlineMs,
  });
  return {
    path: snapshot.path,
    branch: snapshot.branch,
    commitsAhead: snapshot.commitsAhead,
    workingTreeDirty: snapshot.workingTreeDirty,
    classification,
  };
});

if (json) {
  console.log(JSON.stringify({ deadlineMs, nowMs, results }, null, 2));
} else {
  // Human-readable table: one line per worktree with the kind + age.
  // Short-circuit when no worktrees exist so the operator sees an
  // explicit "no in-flight sub-agents" message instead of empty
  // output that looks like a hung script.
  if (results.length === 0) {
    console.log(`(no worktrees in ${worktreesDir})`);
  } else {
    for (const r of results) {
      const tag = formatTag(r.classification);
      const branch = r.branch ?? '(detached)';
      const ageHint = formatAge(r.classification);
      console.log(`${tag} ${branch} (commits=${r.commitsAhead} dirty=${r.workingTreeDirty}) ${ageHint}`);
    }
  }
}

// Exit code derived via exhaustive enumeration so a new classifier
// kind cannot silently fall into the "not stalled, exit 0" bucket.
// In --json mode formatTag never runs, so the kind===stalled string
// check is the ONLY remaining drift-detection layer for exit codes;
// if the classifier adds a 4th kind, this helper throws at the
// first tick after the change. Same discipline as formatTag above.
function isStalledKind(kind) {
  switch (kind) {
    case 'fresh':
    case 'silent-but-working':
      return false;
    case 'stalled':
      return true;
    default: {
      const exhaustive = kind;
      throw new Error(
        `sub-agent-stall-watch: unhandled classification kind '${exhaustive}' in exit-code path; `
        + 'classifier added a kind the watcher does not know whether to exit on. '
        + 'Update isStalledKind + formatTag together.',
      );
    }
  }
}

const anyStalled = results.some((r) => isStalledKind(r.classification.kind));
process.exit(anyStalled ? 2 : 0);

function formatTag(classification) {
  switch (classification.kind) {
    case 'fresh':
      return '[FRESH]';
    case 'silent-but-working':
      return '[SILENT]';
    case 'stalled':
      return '[STALLED]';
    default: {
      // Exhaustive enum check: if the classifier adds a 4th kind
      // (e.g. 'crashed', 'paused') the watcher must fail loud rather
      // than silently render '[?]' and exit 0 (which would let a new
      // stall state slip past the !=='stalled' guard below). Throwing
      // here surfaces the substrate drift at the first tick after the
      // classifier change.
      const exhaustive = classification;
      throw new Error(
        `sub-agent-stall-watch: unhandled classification kind '${exhaustive.kind}'; `
        + 'classifier added a kind the watcher does not know how to render. '
        + 'Update formatTag + the exit-code logic below.',
      );
    }
  }
}

function formatAge(classification) {
  if (classification.ageMs === null || classification.ageMs === undefined) {
    return '(age unknown)';
  }
  const minutes = Math.floor(classification.ageMs / 60000);
  if (classification.kind === 'fresh') {
    return `(activity ${minutes}m ago, reason=${classification.reason})`;
  }
  if (classification.kind === 'stalled') {
    return `(idle ${minutes}m, reason=${classification.reason})`;
  }
  return `(activity ${minutes}m ago)`;
}
