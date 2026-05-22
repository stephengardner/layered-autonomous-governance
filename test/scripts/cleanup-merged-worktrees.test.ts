/**
 * Tests for scripts/lib/cleanup-merged-worktrees.mjs.
 *
 * Pins the keep-conservatively contract: every signal that says
 * "active work in flight" must anchor a `keep`. Only the all-clear
 * shape produces `remove`. Per dev-no-hacky-workarounds the substrate
 * refuses to remove a worktree on incomplete signals.
 */

import { describe, expect, it } from 'vitest';

const { planWorktreeRemoval, planWorktreeBatch, summarizeBatch } = await import(
  '../../scripts/lib/cleanup-merged-worktrees.mjs'
);

const BASE: Parameters<typeof planWorktreeRemoval>[0] = {
  worktreePath: '/tmp/wt-fresh',
  branch: 'feat/clean-merged',
  mergedToMain: true,
  commitsAhead: 0,
  workingTreeDirty: false,
};

describe('planWorktreeRemoval', () => {
  it('removes when branch is merged, clean, and no commits ahead', () => {
    const result = planWorktreeRemoval(BASE);
    expect(result.kind).toBe('remove');
    if (result.kind === 'remove') {
      expect(result.reason).toBe('merged-clean-no-commits-ahead');
      expect(result.worktreePath).toBe('/tmp/wt-fresh');
    }
  });

  it('keeps when working tree is dirty (rule 1)', () => {
    const result = planWorktreeRemoval({ ...BASE, workingTreeDirty: true });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('dirty-working-tree');
    }
  });

  it('keeps on detached HEAD (branch=null)', () => {
    const result = planWorktreeRemoval({ ...BASE, branch: null });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('detached-head-or-unknown');
    }
  });

  it('keeps on literal "HEAD" branch', () => {
    const result = planWorktreeRemoval({ ...BASE, branch: 'HEAD' });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('detached-head-or-unknown');
    }
  });

  it('keeps when mergedToMain is unknown (null)', () => {
    const result = planWorktreeRemoval({ ...BASE, mergedToMain: null });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('merge-state-unknown');
    }
  });

  it('keeps when branch is NOT merged to main', () => {
    const result = planWorktreeRemoval({ ...BASE, mergedToMain: false });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('not-merged-to-main');
    }
  });

  it('keeps when commitsAhead > 0 (even if mergedToMain=true)', () => {
    // Edge case: branch merged but local has additional commits.
    // Conservative path keeps; operator decides if they want to drop
    // the local commits manually.
    const result = planWorktreeRemoval({ ...BASE, commitsAhead: 1 });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('commits-ahead-of-main');
    }
  });

  it('dirty-working-tree wins over later signals (precedence rule 1 first)', () => {
    // Set every keep-anchor signal; the precedence order picks the
    // first one (dirty). Documents that the message names the most
    // specific signal so the operator sees the highest-priority
    // reason in the report.
    const result = planWorktreeRemoval({
      worktreePath: '/tmp/wt-all-bad',
      branch: 'HEAD',
      mergedToMain: false,
      commitsAhead: 5,
      workingTreeDirty: true,
    });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('dirty-working-tree');
    }
  });

  it('keeps when commitsAhead is undefined (per CR PR #438 keep-wins gap fix)', () => {
    // Without this guard, an undefined commitsAhead fell through to
    // `remove` because the `typeof === 'number'` check returned
    // false and there was no explicit catch. Now it triggers a
    // keep with reason='commits-ahead-unknown', matching the same
    // conservative posture as the merge-state-unknown branch above.
    const result = planWorktreeRemoval({
      ...BASE,
      commitsAhead: undefined as never,
    });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('commits-ahead-unknown');
    }
  });

  it('keeps when commitsAhead is null', () => {
    const result = planWorktreeRemoval({
      ...BASE,
      commitsAhead: null as never,
    });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('commits-ahead-unknown');
    }
  });

  it('keeps when commitsAhead is NaN', () => {
    const result = planWorktreeRemoval({
      ...BASE,
      commitsAhead: Number.NaN,
    });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('commits-ahead-unknown');
    }
  });

  it('keeps when commitsAhead is Infinity (non-finite)', () => {
    const result = planWorktreeRemoval({
      ...BASE,
      commitsAhead: Number.POSITIVE_INFINITY,
    });
    expect(result.kind).toBe('keep');
    if (result.kind === 'keep') {
      expect(result.reason).toBe('commits-ahead-unknown');
    }
  });

  it('throws on missing worktreePath', () => {
    expect(() =>
      planWorktreeRemoval({
        ...BASE,
        worktreePath: '',
      }),
    ).toThrow(/worktreePath/);
  });

  it('throws on non-object input', () => {
    expect(() => planWorktreeRemoval(null as never)).toThrow();
    expect(() => planWorktreeRemoval(undefined as never)).toThrow();
  });
});

describe('planWorktreeBatch', () => {
  it('maps each input through the planner', () => {
    const inputs = [
      BASE,
      { ...BASE, worktreePath: '/tmp/wt-dirty', workingTreeDirty: true },
      { ...BASE, worktreePath: '/tmp/wt-unmerged', mergedToMain: false },
    ];
    const results = planWorktreeBatch(inputs);
    expect(results).toHaveLength(3);
    expect(results[0]!.kind).toBe('remove');
    expect(results[1]!.kind).toBe('keep');
    expect(results[2]!.kind).toBe('keep');
  });

  it('returns [] for empty input', () => {
    expect(planWorktreeBatch([])).toEqual([]);
  });

  it('throws on non-array input', () => {
    expect(() => planWorktreeBatch(null as never)).toThrow();
  });
});

describe('summarizeBatch', () => {
  it('partitions results into remove + keep buckets', () => {
    const results = planWorktreeBatch([
      BASE,
      { ...BASE, worktreePath: '/tmp/wt-dirty', workingTreeDirty: true },
      { ...BASE, worktreePath: '/tmp/wt-ahead', commitsAhead: 2 },
    ]);
    const summary = summarizeBatch(results);
    expect(summary.toRemove).toHaveLength(1);
    expect(summary.toKeep).toHaveLength(2);
    expect(summary.totalScanned).toBe(3);
  });

  it('handles all-keep and all-remove cases', () => {
    const allKeep = summarizeBatch([{ kind: 'keep', worktreePath: '/tmp/x', reason: 'merge-state-unknown' }]);
    expect(allKeep.toRemove).toHaveLength(0);
    expect(allKeep.toKeep).toHaveLength(1);

    const allRemove = summarizeBatch([{ kind: 'remove', worktreePath: '/tmp/y', reason: 'merged-clean-no-commits-ahead' }]);
    expect(allRemove.toRemove).toHaveLength(1);
    expect(allRemove.toKeep).toHaveLength(0);
  });

  it('throws on non-array input', () => {
    expect(() => summarizeBatch(null as never)).toThrow();
  });
});
