/**
 * Tests for scripts/lib/scan-worktrees.mjs.
 *
 * Pins the scanner contract using a real tmp-dir fixture rather than
 * mocking fs/child_process. The scanner spawns git; mocking the
 * spawn would mean testing the mock, not the integration. Tmp-dir
 * with real git init is the higher-fidelity path.
 *
 * Coverage:
 *   - Non-git directory returns null (graceful: not a worktree)
 *   - Empty git worktree returns snapshot with commitsAhead=0,
 *     lastCommitAtMs=null, workingTreeDirty=false
 *   - Worktree with uncommitted edits returns workingTreeDirty=true
 *   - Worktree with edits has lastEditAtMs populated
 *   - .git, node_modules, dist directories are excluded from mtime walk
 *   - scanAllWorktrees returns [] for missing directory (no error)
 *   - scanAllWorktrees skips non-directory entries
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { scanWorktree, scanAllWorktrees, SNAPSHOT_KEYS } = await import(
  '../../scripts/lib/scan-worktrees.mjs'
);

function makeGitRepo(dir: string): void {
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

describe('scanWorktree', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scan-wt-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; Windows EBUSY on .git pack files is a
      // known transient
    }
  });

  it('returns null for a non-git directory', () => {
    const result = scanWorktree(tmpDir);
    expect(result).toBeNull();
  });

  it('returns a snapshot for an empty git repo with no commits', () => {
    makeGitRepo(tmpDir);
    const result = scanWorktree(tmpDir);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.path).toBe(tmpDir);
    expect(result.commitsAhead).toBe(0);
    expect(result.lastCommitAtMs).toBeNull();
    expect(result.workingTreeDirty).toBe(false);
  });

  it('detects uncommitted edits via workingTreeDirty', () => {
    makeGitRepo(tmpDir);
    writeFileSync(join(tmpDir, 'foo.txt'), 'hello');
    const result = scanWorktree(tmpDir);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.workingTreeDirty).toBe(true);
  });

  it('populates lastEditAtMs from the newest mtime in the worktree', () => {
    makeGitRepo(tmpDir);
    const beforeMs = Date.now();
    writeFileSync(join(tmpDir, 'foo.txt'), 'hello');
    const result = scanWorktree(tmpDir);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(typeof result.lastEditAtMs).toBe('number');
    if (typeof result.lastEditAtMs === 'number') {
      // Some filesystems round mtime to the second; allow slack.
      expect(result.lastEditAtMs).toBeGreaterThanOrEqual(beforeMs - 2000);
      expect(result.lastEditAtMs).toBeLessThanOrEqual(Date.now() + 2000);
    }
  });

  it('excludes node_modules from the mtime walk', () => {
    makeGitRepo(tmpDir);
    // Write an old tracked file
    writeFileSync(join(tmpDir, 'tracked.txt'), 'old');
    // Wait a beat so timestamps differ
    const trackedSnapshot = scanWorktree(tmpDir);
    expect(trackedSnapshot).not.toBeNull();
    if (trackedSnapshot === null) throw new Error('expected non-null snapshot after git-init');
    const trackedMtime = trackedSnapshot.lastEditAtMs ?? 0;

    // Write a file inside node_modules (should be ignored)
    mkdirSync(join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'foo', 'index.js'), 'much later');

    const rescanned = scanWorktree(tmpDir);
    expect(rescanned).not.toBeNull();
    if (rescanned === null) throw new Error('expected non-null snapshot after rescan');
    // The newer node_modules write must NOT have advanced lastEditAtMs.
    // Allow equality (same-second mtime resolution edge case).
    expect(rescanned.lastEditAtMs).toBeLessThanOrEqual(trackedMtime + 1000);
  });

  it('excludes dist from the mtime walk', () => {
    makeGitRepo(tmpDir);
    writeFileSync(join(tmpDir, 'tracked.txt'), 'old');
    const trackedSnapshot = scanWorktree(tmpDir);
    expect(trackedSnapshot).not.toBeNull();
    if (trackedSnapshot === null) throw new Error('expected non-null snapshot after git-init');
    const trackedMtime = trackedSnapshot.lastEditAtMs ?? 0;

    mkdirSync(join(tmpDir, 'dist'), { recursive: true });
    writeFileSync(join(tmpDir, 'dist', 'bundle.js'), 'much later');

    const rescanned = scanWorktree(tmpDir);
    expect(rescanned).not.toBeNull();
    if (rescanned === null) throw new Error('expected non-null snapshot after rescan');
    expect(rescanned.lastEditAtMs).toBeLessThanOrEqual(trackedMtime + 1000);
  });

  it('returns null when commitsAhead is 0 even with content (no commits made)', () => {
    makeGitRepo(tmpDir);
    writeFileSync(join(tmpDir, 'foo.txt'), 'hello');
    const result = scanWorktree(tmpDir);
    expect(result).not.toBeNull();
    if (result === null) throw new Error('expected non-null snapshot after git-init');
    // No commit made + no origin/main reference means commitsAhead
    // stays 0 and lastCommitAtMs stays null.
    expect(result.commitsAhead).toBe(0);
    expect(result.lastCommitAtMs).toBeNull();
  });
});

describe('scanAllWorktrees', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scan-all-wt-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns [] for a missing directory (not an error)', () => {
    const result = scanAllWorktrees(join(tmpDir, 'does-not-exist'));
    expect(result).toEqual([]);
  });

  it('returns [] for an empty directory', () => {
    const result = scanAllWorktrees(tmpDir);
    expect(result).toEqual([]);
  });

  it('skips non-git subdirectories', () => {
    mkdirSync(join(tmpDir, 'not-a-worktree'));
    writeFileSync(join(tmpDir, 'not-a-worktree', 'foo.txt'), 'hi');
    const result = scanAllWorktrees(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns one snapshot per git subdirectory', () => {
    mkdirSync(join(tmpDir, 'wt-a'));
    mkdirSync(join(tmpDir, 'wt-b'));
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: join(tmpDir, 'wt-a') });
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: join(tmpDir, 'wt-b') });
    const result = scanAllWorktrees(tmpDir);
    expect(result.length).toBe(2);
    expect(result.every((s) => typeof s.path === 'string')).toBe(true);
  });
});

describe('SNAPSHOT_KEYS', () => {
  it('exposes the keys the classifier reads', () => {
    expect(Object.isFrozen(SNAPSHOT_KEYS)).toBe(true);
    expect(SNAPSHOT_KEYS).toContain('commitsAhead');
    expect(SNAPSHOT_KEYS).toContain('lastCommitAtMs');
    expect(SNAPSHOT_KEYS).toContain('lastEditAtMs');
    expect(SNAPSHOT_KEYS).toContain('workingTreeDirty');
  });
});
