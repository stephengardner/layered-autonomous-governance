// Worktree state scanner.
//
// Walks the .worktrees/ directory and returns one StateSnapshot per
// worktree that the pure classifier in scripts/lib/sub-agent-stall-detect.mjs
// consumes. Centralizes the fs + git I/O so the classifier stays pure
// and so the watcher driver is one short orchestration call.
//
// Why a separate module from the watcher driver: the watcher CLI has
// argv parsing + atom writes + exit codes; this module is pure I/O.
// Tests for the watcher mock the scanner; tests for the scanner
// (this module) drive it against a real tmp-dir fixture. Two
// orthogonal test surfaces, one shared shape.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Directories never counted as "edits" when computing lastEditAtMs.
 * Build artifacts, vendor directories, and SCM metadata pile up
 * mtimes from automated processes (npm install, tsc -b, git update)
 * that have nothing to do with sub-agent progress. Counting them
 * would mask a real stall (sub-agent typed nothing, but npm install
 * fired and bumped node_modules mtimes).
 *
 * Conservative list: only the universally-non-author directories.
 * Workspace-specific noise (e.g. `coverage/`, `.cache/`) is left in
 * scope; deployments that need a tighter set wire a custom scanner.
 * Indie-floor: the floor matches the worktree-workflow skill's
 * default ignore set; deployments do not need to tune this to get
 * sensible results.
 */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);

/**
 * Shape the classifier in sub-agent-stall-detect.mjs consumes. The
 * names match the classifier's expected struct so the watcher can
 * pass the snapshot straight through without re-shaping.
 */
export const SNAPSHOT_KEYS = Object.freeze([
  'path',
  'branch',
  'commitsAhead',
  'lastCommitAtMs',
  'lastEditAtMs',
  'workingTreeDirty',
]);

/**
 * Scan a single worktree's git + fs state.
 *
 * Returns a StateSnapshot the classifier consumes, or null when the
 * worktree is unreadable (not a git checkout, deleted mid-scan,
 * etc.). Null is intentional: the watcher logs and continues to the
 * next worktree rather than blowing up the whole pass on one bad
 * entry.
 *
 * Pure-ish: takes a path + a now-clock injection (for tests). Calls
 * git via spawnSync and reads the file system; production I/O.
 *
 * Why spawnSync over the git2 binding or simple-git library:
 * (a) no native deps to install on indie-floor; (b) git is a
 * required runtime dependency for ANY LAG flow so spawning it costs
 * nothing more; (c) the parsing here is trivial enough that adding
 * a library is over-engineering per dev-extreme-rigor-and-research.
 */
export function scanWorktree(worktreePath, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  // Per-call timeout for every git subprocess. A hung git invocation
  // (network FS, antivirus scan, repo lock contention) would block
  // the whole watcher tick without this cap. Default 5s is generous
  // for local git on a normal repo, tight enough that a stuck call
  // surfaces within the loop's next tick window. Tunable so test
  // fixtures and slow filesystems can dial up.
  const gitTimeoutMs = opts.gitTimeoutMs ?? 5_000;
  const gitOpts = { encoding: 'utf8', timeout: gitTimeoutMs };

  if (!existsSync(join(worktreePath, '.git'))) {
    return null;
  }

  // git rev-parse the current branch; null on detached-HEAD or error.
  const branchResult = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], gitOpts);
  const branch =
    branchResult.status === 0
      ? branchResult.stdout.trim()
      : null;
  // A named branch is required to make sense of commits-ahead.
  // Detached HEAD ('HEAD' literal) or git error means we cannot
  // distinguish 'committed work past origin/main' from 'arbitrary
  // checkout pointing at some random sha'. We still scan fs state
  // so the classifier can use dirty + lastEditAtMs signals.
  const canReadCommitFreshness = branch !== null && branch !== 'HEAD';

  // Commits ahead of origin/main. Robust to origin/main not existing
  // (fresh clone, custom remote name) by returning 0.
  let commitsAhead = 0;
  let lastCommitAtMs = null;
  if (canReadCommitFreshness) {
    const aheadResult = spawnSync(
      'git',
      ['-C', worktreePath, 'rev-list', '--count', 'origin/main..HEAD'],
      gitOpts,
    );
    if (aheadResult.status === 0) {
      const parsed = Number.parseInt(aheadResult.stdout.trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        commitsAhead = parsed;
      }
    }
  }
  if (canReadCommitFreshness && commitsAhead > 0) {
    // Last commit's author-date in unix seconds. %at is the author
    // timestamp; production wants this rather than commit-date so
    // rebases / cherry-picks do not artificially refresh the
    // freshness signal.
    const logResult = spawnSync(
      'git',
      ['-C', worktreePath, 'log', '-1', '--format=%at', 'HEAD'],
      gitOpts,
    );
    if (logResult.status === 0) {
      const secs = Number.parseInt(logResult.stdout.trim(), 10);
      if (Number.isFinite(secs) && secs >= 0) {
        lastCommitAtMs = secs * 1000;
      }
    }
  }

  // Working-tree dirty flag. `git status --porcelain` is empty when
  // clean; any line means dirty.
  const statusResult = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], gitOpts);
  const workingTreeDirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0;

  // Walk the worktree for the newest mtime, skipping IGNORED_DIRS.
  const lastEditAtMs = newestMtimeMs(worktreePath);

  return {
    path: worktreePath,
    branch: branch === 'HEAD' ? null : branch,
    commitsAhead,
    lastCommitAtMs,
    lastEditAtMs,
    workingTreeDirty,
    nowMs,
  };
}

/**
 * Find the newest mtime in the worktree (excluding IGNORED_DIRS).
 * Returns null when the walk found nothing readable.
 *
 * Walk strategy: depth-first, bounded by IGNORED_DIRS. Sub-second
 * resolution; on Windows NTFS the mtime is typically rounded to the
 * second by node, which is fine for stall detection at minute-grain
 * deadlines.
 *
 * Error handling: any per-entry fs error (permission denied, race
 * with delete) is swallowed silently. The scanner returns whatever
 * it could read; the classifier handles null lastEditAtMs correctly.
 */
function newestMtimeMs(root) {
  let newest = null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(join(current, entry.name));
        continue;
      }
      try {
        const stats = statSync(join(current, entry.name));
        const ms = stats.mtimeMs;
        if (typeof ms === 'number' && Number.isFinite(ms)) {
          if (newest === null || ms > newest) {
            newest = ms;
          }
        }
      } catch {
        // skip
      }
    }
  }
  return newest;
}

/**
 * Walk the .worktrees/ directory and snapshot each subdirectory
 * that is a git checkout. Returns an array of snapshots in the
 * order returned by readdirSync (alphabetical on most platforms).
 *
 * Caller passes the absolute path to .worktrees/. Returns [] when
 * the directory does not exist (no worktrees in flight is a valid
 * state, not an error).
 */
export function scanAllWorktrees(worktreesDir, opts = {}) {
  if (!existsSync(worktreesDir)) {
    return [];
  }
  let entries;
  try {
    // Sort by name for deterministic iteration order. readdirSync's
    // raw order is filesystem-dependent (ext4 returns inode order,
    // NTFS alphabetical, tmpfs hash order); sorting locks in a
    // stable output so the watcher's printed list and the JSON shape
    // are reproducible across machines and across runs on the same
    // machine after a rebuild.
    entries = readdirSync(worktreesDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = resolve(worktreesDir, entry.name);
    const snapshot = scanWorktree(fullPath, opts);
    if (snapshot !== null) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}
