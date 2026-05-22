/**
 * Tests for scripts/lib/sub-agent-stall-detect.mjs.
 *
 * Pins the substrate's stall-classification contract that a parent
 * watcher will rely on to decide intervention. The detector is pure
 * (no fs/git/clock), so every case feeds a state struct with
 * controlled values and asserts the discriminated kind.
 *
 * The cases cover all 4 decision-precedence rules from the helper
 * docstring plus boundary conditions (deadline exactly equal,
 * clock-skew negative ages) and the input-validation thrown errors.
 */

import { describe, expect, it } from 'vitest';

const { classifySubAgentProgress, DEFAULT_STALL_DEADLINE_MS } = await import(
  '../../scripts/lib/sub-agent-stall-detect.mjs'
);

const NOW_MS = Date.parse('2026-05-22T00:00:00Z');
const MINUTE_MS = 60_000;

describe('classifySubAgentProgress', () => {
  describe('rule 1: recent commit -> fresh', () => {
    it('returns fresh with reason=recent-commit when last commit < deadline', () => {
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS - 5 * MINUTE_MS,
        lastEditAtMs: null,
        workingTreeDirty: false,
        commitsAhead: 3,
      });
      expect(result.kind).toBe('fresh');
      if (result.kind === 'fresh') {
        expect(result.reason).toBe('recent-commit');
        expect(result.ageMs).toBe(5 * MINUTE_MS);
      }
    });

    it('returns fresh on a commit exactly at the deadline boundary (inclusive)', () => {
      // Commit was exactly 30 minutes ago, deadline is 30 minutes. The
      // contract is <= deadline, not <, so this should classify as
      // fresh. Boundary inclusiveness matters because cron-tick
      // cadences will land here exactly when the deadline matches the
      // wall-clock cadence.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS - DEFAULT_STALL_DEADLINE_MS,
        lastEditAtMs: null,
        workingTreeDirty: false,
        commitsAhead: 1,
      });
      expect(result.kind).toBe('fresh');
    });

    it('rejects negative commit-age (clock skew) and falls through to rule 2 or 4', () => {
      // If the worktree clock is ahead of the parent (NTP drift,
      // timestamp from a different machine), lastCommitAtMs > nowMs
      // produces a negative age. Rule 1 requires commitAge >= 0; the
      // detector falls through to rule 2 (lastEditAtMs) and then
      // rule 4 (stalled). This prevents a future-dated commit from
      // permanently masking a stall.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS + 5 * MINUTE_MS,
        lastEditAtMs: null,
        workingTreeDirty: false,
        commitsAhead: 1,
      });
      expect(result.kind).toBe('stalled');
      if (result.kind === 'stalled') {
        expect(result.reason).toBe('stale-after-last-commit');
      }
    });
  });

  describe('rule 2: recent edit -> fresh (no commit yet)', () => {
    it('returns fresh with reason=working-tree-edit-within-deadline when last edit < deadline', () => {
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: NOW_MS - 2 * MINUTE_MS,
        workingTreeDirty: true,
        commitsAhead: 0,
      });
      expect(result.kind).toBe('fresh');
      if (result.kind === 'fresh') {
        expect(result.reason).toBe('working-tree-edit-within-deadline');
        expect(result.ageMs).toBe(2 * MINUTE_MS);
      }
    });

    it('returns fresh when commit is stale but edits are recent', () => {
      // Sub-agent committed once, then continued working past the
      // deadline. Recent file edits are still progress; the parent
      // should NOT intervene.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS - 60 * MINUTE_MS,
        lastEditAtMs: NOW_MS - 3 * MINUTE_MS,
        workingTreeDirty: true,
        commitsAhead: 1,
      });
      expect(result.kind).toBe('fresh');
      if (result.kind === 'fresh') {
        expect(result.reason).toBe('working-tree-edit-within-deadline');
      }
    });
  });

  describe('rule 3: dirty worktree but no recent activity -> silent-but-working', () => {
    it('returns silent-but-working when worktree dirty but no edits within deadline', () => {
      // Sub-agent typed something, then went quiet. Edits older than
      // deadline. The parent gets the ambiguous signal so it can
      // decide whether to extend the deadline or intervene.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: NOW_MS - 45 * MINUTE_MS,
        workingTreeDirty: true,
        commitsAhead: 0,
      });
      expect(result.kind).toBe('silent-but-working');
      if (result.kind === 'silent-but-working') {
        expect(result.ageMs).toBe(45 * MINUTE_MS);
      }
    });

    it('returns silent-but-working with ageMs=null when lastEditAtMs is missing but worktree dirty', () => {
      // The worktree has uncommitted changes but we never got a
      // mtime read. Surface the kind so the caller knows to look
      // closer, but mark ageMs null since we cannot compute it.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: null,
        workingTreeDirty: true,
        commitsAhead: 0,
      });
      expect(result.kind).toBe('silent-but-working');
      if (result.kind === 'silent-but-working') {
        expect(result.ageMs).toBeNull();
      }
    });
  });

  describe('rule 4: nothing recent + clean worktree -> stalled', () => {
    it('returns stalled with reason=no-progress when no commits and no edits', () => {
      // The textbook stall: sub-agent dispatched, never touched the
      // worktree, deadline passed. The parent should escalate or
      // re-dispatch.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: null,
        workingTreeDirty: false,
        commitsAhead: 0,
      });
      expect(result.kind).toBe('stalled');
      if (result.kind === 'stalled') {
        expect(result.reason).toBe('no-progress');
        expect(result.ageMs).toBeNull();
      }
    });

    it('returns stalled with reason=stale-after-last-commit when commits exist but stale', () => {
      // Sub-agent committed, then went silent. Commit older than
      // deadline, no edits, clean worktree. This is the "exited
      // mid-PR" failure mode the substrate is meant to catch.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS - 90 * MINUTE_MS,
        lastEditAtMs: null,
        workingTreeDirty: false,
        commitsAhead: 2,
      });
      expect(result.kind).toBe('stalled');
      if (result.kind === 'stalled') {
        expect(result.reason).toBe('stale-after-last-commit');
        expect(result.ageMs).toBe(90 * MINUTE_MS);
      }
    });

    it('uses lastEditAtMs for ageMs when lastCommitAtMs absent', () => {
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: NOW_MS - 100 * MINUTE_MS,
        workingTreeDirty: false,
        commitsAhead: 0,
      });
      expect(result.kind).toBe('stalled');
      if (result.kind === 'stalled') {
        expect(result.ageMs).toBe(100 * MINUTE_MS);
        expect(result.reason).toBe('no-progress');
      }
    });
  });

  describe('clock-skew clamps ageMs to null (per CR PR #434)', () => {
    it('silent-but-working: negative lastEditAtMs age clamps ageMs to null', () => {
      // Worktree clock is ahead of parent. lastEditAtMs > nowMs would
      // produce a negative "time since last edit" -- a lie. The
      // detector clamps to null so the caller knows the age is
      // unobservable, not "very recent".
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: NOW_MS + 5 * MINUTE_MS,
        workingTreeDirty: true,
        commitsAhead: 0,
      });
      expect(result.kind).toBe('silent-but-working');
      if (result.kind === 'silent-but-working') {
        expect(result.ageMs).toBeNull();
      }
    });

    it('stalled: future-dated lastEditAtMs falls back to commit ageMs (also clamped)', () => {
      // Edit timestamp is in the future (skew). The detector falls
      // back to lastCommitAtMs. Both can be skewed independently.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS - 90 * MINUTE_MS,
        lastEditAtMs: NOW_MS + 1 * MINUTE_MS,
        workingTreeDirty: false,
        commitsAhead: 1,
      });
      expect(result.kind).toBe('stalled');
      if (result.kind === 'stalled') {
        expect(result.ageMs).toBe(90 * MINUTE_MS);
      }
    });

    it('stalled: BOTH edit AND commit in the future clamps to null', () => {
      // Both timestamps skewed forward. Caller gets null, not a lie.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: NOW_MS + 10 * MINUTE_MS,
        lastEditAtMs: NOW_MS + 5 * MINUTE_MS,
        workingTreeDirty: false,
        commitsAhead: 1,
      });
      expect(result.kind).toBe('stalled');
      if (result.kind === 'stalled') {
        expect(result.ageMs).toBeNull();
      }
    });
  });

  describe('deadline override', () => {
    it('honors a smaller deadline (org-ceiling tight SLA)', () => {
      // Edit 5 minutes ago; default deadline 30min would classify as
      // fresh; override to 3min flips to stalled.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: NOW_MS - 5 * MINUTE_MS,
        workingTreeDirty: false,
        commitsAhead: 0,
        deadlineMs: 3 * MINUTE_MS,
      });
      expect(result.kind).toBe('stalled');
    });

    it('honors a larger deadline (long-exploration tasks)', () => {
      // Edit 45 minutes ago; default deadline 30min would classify as
      // silent-but-working (dirty) or stalled (clean); override to 2h
      // flips to fresh.
      const result = classifySubAgentProgress({
        nowMs: NOW_MS,
        lastCommitAtMs: null,
        lastEditAtMs: NOW_MS - 45 * MINUTE_MS,
        workingTreeDirty: true,
        commitsAhead: 0,
        deadlineMs: 2 * 60 * MINUTE_MS,
      });
      expect(result.kind).toBe('fresh');
    });
  });

  describe('input validation', () => {
    it('throws when nowMs is missing', () => {
      expect(() =>
        classifySubAgentProgress({
          lastCommitAtMs: null,
          lastEditAtMs: null,
          workingTreeDirty: false,
          commitsAhead: 0,
        } as never),
      ).toThrow(/nowMs/);
    });

    it('throws when nowMs is NaN', () => {
      expect(() =>
        classifySubAgentProgress({
          nowMs: Number.NaN,
          lastCommitAtMs: null,
          lastEditAtMs: null,
          workingTreeDirty: false,
          commitsAhead: 0,
        }),
      ).toThrow(/nowMs/);
    });

    it('throws when deadlineMs is zero or negative', () => {
      expect(() =>
        classifySubAgentProgress({
          nowMs: NOW_MS,
          lastCommitAtMs: null,
          lastEditAtMs: null,
          workingTreeDirty: false,
          commitsAhead: 0,
          deadlineMs: 0,
        }),
      ).toThrow(/deadlineMs/);
      expect(() =>
        classifySubAgentProgress({
          nowMs: NOW_MS,
          lastCommitAtMs: null,
          lastEditAtMs: null,
          workingTreeDirty: false,
          commitsAhead: 0,
          deadlineMs: -1,
        }),
      ).toThrow(/deadlineMs/);
    });
  });

  describe('substrate contract', () => {
    it('default stall deadline is 30 minutes', () => {
      expect(DEFAULT_STALL_DEADLINE_MS).toBe(30 * 60 * 1000);
    });
  });
});
