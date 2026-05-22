/**
 * Smoke test for scripts/sub-agent-stall-watch.mjs --dry-run-style invocation.
 *
 * The watcher's exit-code helper isStalledKind is intentionally
 * exhaustive: an unknown classification kind throws rather than
 * silently returning false. This test pins the contract by running
 * the script against a tmp-dir with one fresh worktree and asserting
 * exit code 0 (no stall).
 *
 * Why a smoke test (not a unit test): isStalledKind is defined
 * inside the driver script's module scope and not exported. The
 * cheapest way to lock in the contract is to invoke the script end
 * to end with a known-good worktree fixture and assert the observed
 * exit code matches the documented contract.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('sub-agent-stall-watch.mjs exit-code contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stall-watch-smoke-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; Windows EBUSY on .git pack files is a
      // known transient
    }
  });

  it('exits 0 when no worktrees present (no stall by definition)', () => {
    // Empty .worktrees/ directory means scanAllWorktrees returns
    // [] and isStalledKind is never invoked. Exit 0 is the
    // contract.
    const scriptPath = join(
      process.cwd(),
      'scripts',
      'sub-agent-stall-watch.mjs',
    );
    const result = spawnSync(process.execPath, [scriptPath, '--root', tmpDir], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
  });

  it('exits 0 when worktree has recent edits (fresh by working-tree-edit-within-deadline)', () => {
    // Create a git worktree + write a tracked file. The .git
    // directory is excluded from the mtime walk, so without an
    // explicit file write, lastEditAtMs would be null and the
    // classifier falls through to rule 4 (stalled). A non-git file
    // populates lastEditAtMs, which the classifier reads as
    // working-tree-edit-within-deadline (fresh, rule 2).
    const wt = join(tmpDir, 'fresh-wt');
    mkdirSync(wt, { recursive: true });
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: wt });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wt });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: wt });
    writeFileSync(join(wt, 'README.md'), 'recent work in progress');

    const scriptPath = join(
      process.cwd(),
      'scripts',
      'sub-agent-stall-watch.mjs',
    );
    const result = spawnSync(process.execPath, [scriptPath, '--root', tmpDir], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
  });

  it('rejects --deadline-ms with non-integer value (CR-flagged strict int parse)', () => {
    // Per CR finding on PR #436: parseInt accepted '10ms' as 10,
    // masking operator typos. The fix validates with a strict regex.
    // Pin the contract by passing a malformed value and asserting
    // non-zero exit + stderr message.
    const scriptPath = join(
      process.cwd(),
      'scripts',
      'sub-agent-stall-watch.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', tmpDir, '--deadline-ms', '10ms'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('strict integer');
  });

  it('rejects --deadline-ms with negative value', () => {
    const scriptPath = join(
      process.cwd(),
      'scripts',
      'sub-agent-stall-watch.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', tmpDir, '--deadline-ms', '-1'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).not.toBe(0);
  });

  it('--json mode emits parseable JSON', () => {
    const scriptPath = join(
      process.cwd(),
      'scripts',
      'sub-agent-stall-watch.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--root', tmpDir, '--json'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('deadlineMs');
    expect(parsed).toHaveProperty('nowMs');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});
