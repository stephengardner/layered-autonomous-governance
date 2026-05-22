// Pure detector for "is this sub-agent worktree stalled?"
//
// Parent agents that dispatch sub-agents (via the Agent tool or a
// scripts/run-*-actor.mjs wrapper) need a deterministic way to decide
// whether an in-flight sub-agent is making progress or has gone
// silent. The 2026-05-21 session lost ~2 hours when a PR3 sub-agent
// ran 110+ minutes producing 662 LOC of uncommitted work; the parent
// had no signal except heuristic "no commit yet" guesses.
//
// This helper closes that gap: given a worktree's git state and the
// configured deadline, classify the sub-agent's progress as one of
// three discriminated kinds: 'fresh' (commit or working-tree edit
// within deadline), 'silent-but-working' (file mtimes within
// deadline AND uncommitted work present), or 'stalled' (no commit
// AND no recent edits AND deadline passed). Callers act on the kind
// rather than ad-hoc time arithmetic.
//
// Design choices:
// - The detector is PURE: takes a state struct, returns a classification.
//   No fs reads, no git invocations, no clock calls. The caller does
//   the I/O and passes the inputs. Makes the substrate testable
//   without spawning git or stubbing fs.
// - Three kinds, not two. 'silent-but-working' is a real and benign
//   state: a sub-agent typing fast in the worktree with no commit yet
//   but the file mtimes are advancing. The parent should NOT treat
//   that as stalled; commit-or-status discipline says the sub-agent
//   should write a status atom at long intervals, but per-second
//   file edits ARE progress.
// - Deadline is per-call, not global. The substrate's canon policy
//   resolves the deadline; this helper accepts the resolved value so
//   org-ceiling deployments with tighter SLAs and indie deployments
//   with looser ones share one code path.
//
// Consumed by: a parent-side watcher (separate PR) that wakes on
// every loop tick and decides whether to intervene. The watcher
// records a sub-agent-stalled atom and dispatches a takeover when
// the kind is 'stalled'.

/**
 * Default stall deadline: 30 minutes.
 *
 * Why 30 min: the observed failure mode is sub-agents running 60+ min
 * without progress. The deadline must be long enough to absorb normal
 * exploration (npm install, tsc -b, file edits) but short enough to
 * catch true stalls before they burn an operator hour. 30 min is the
 * floor; org-ceiling deployments running tighter SLAs dial down via
 * canon policy.
 */
export const DEFAULT_STALL_DEADLINE_MS = 30 * 60 * 1000;

/**
 * Classify a sub-agent worktree's progress against the deadline.
 *
 * Input shape: a struct the caller assembles from fs + git observations
 * for one worktree:
 *
 *   - `commitsAhead`: number of commits on the worktree branch that
 *     are not on origin/main. > 0 means committed work exists.
 *   - `lastCommitAtMs`: epoch-ms of the most recent commit on the
 *     branch (or null when commitsAhead === 0).
 *   - `lastEditAtMs`: epoch-ms of the most recent modification to any
 *     tracked or untracked file in the worktree (excluding
 *     node_modules / dist / .git). The caller computes this via the
 *     newest mtime over a recursive walk.
 *   - `workingTreeDirty`: true when `git status --short` lists any
 *     entry. Even untracked test artifacts count; the sub-agent is
 *     touching the worktree.
 *   - `nowMs`: epoch-ms when the classifier runs. Injected for tests.
 *
 * Returns one of:
 *
 *   - `{kind: 'fresh', reason}`: the sub-agent has recent forward
 *     motion. The parent should NOT intervene. `reason` describes
 *     which signal anchored the classification ('recent-commit' or
 *     'working-tree-edit-within-deadline').
 *   - `{kind: 'silent-but-working', ageMs}`: no commit AND no edits
 *     within the deadline, but the worktree IS dirty. This is the
 *     ambiguous case: the sub-agent typed something, then stopped.
 *     Caller may treat as stalled or extend deadline based on its own
 *     judgment. `ageMs` is the time since the last edit.
 *   - `{kind: 'stalled', ageMs, reason}`: no commit AND deadline
 *     passed since last edit AND working tree is clean (or has only
 *     stale uncommitted edits older than deadline). `reason` is
 *     'no-progress' (no commits ever) or 'stale-after-last-commit'
 *     (some commits but nothing since deadline).
 *
 * Decision precedence:
 *   1. lastCommitAtMs within deadline -> 'fresh' (commits are the
 *      strongest progress signal)
 *   2. lastEditAtMs within deadline -> 'fresh' (typing IS progress)
 *   3. workingTreeDirty -> 'silent-but-working' (typed once, paused)
 *   4. otherwise -> 'stalled'
 */
export function classifySubAgentProgress(state) {
  const deadlineMs = state.deadlineMs ?? DEFAULT_STALL_DEADLINE_MS;
  const nowMs = state.nowMs;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error('classifySubAgentProgress: nowMs must be a finite number');
  }
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('classifySubAgentProgress: deadlineMs must be a positive finite number');
  }

  // Rule 1: a commit within the deadline is the strongest progress
  // signal. Even if the working tree is now clean, recent committed
  // work indicates the sub-agent is functioning.
  if (typeof state.lastCommitAtMs === 'number' && Number.isFinite(state.lastCommitAtMs)) {
    const commitAge = nowMs - state.lastCommitAtMs;
    if (commitAge >= 0 && commitAge <= deadlineMs) {
      return { kind: 'fresh', reason: 'recent-commit', ageMs: commitAge };
    }
  }

  // Rule 2: file-system edits within the deadline are progress, even
  // without a commit. A sub-agent assembling a multi-file diff before
  // its first commit is the normal pattern; per-second mtime updates
  // mean it is still typing.
  if (typeof state.lastEditAtMs === 'number' && Number.isFinite(state.lastEditAtMs)) {
    const editAge = nowMs - state.lastEditAtMs;
    if (editAge >= 0 && editAge <= deadlineMs) {
      return { kind: 'fresh', reason: 'working-tree-edit-within-deadline', ageMs: editAge };
    }
  }

  // Rule 3: working tree is dirty but no edits within deadline. The
  // sub-agent typed something, then paused. Ambiguous: could be
  // mid-thought, could be hung. Surface as a distinct kind so the
  // caller can decide.
  if (state.workingTreeDirty === true) {
    const ageMs =
      typeof state.lastEditAtMs === 'number' && Number.isFinite(state.lastEditAtMs)
        ? nowMs - state.lastEditAtMs
        : null;
    return { kind: 'silent-but-working', ageMs };
  }

  // Rule 4: nothing recent, working tree clean. Stalled.
  const reason =
    typeof state.commitsAhead === 'number' && state.commitsAhead > 0
      ? 'stale-after-last-commit'
      : 'no-progress';
  const ageMs =
    typeof state.lastEditAtMs === 'number' && Number.isFinite(state.lastEditAtMs)
      ? nowMs - state.lastEditAtMs
      : typeof state.lastCommitAtMs === 'number' && Number.isFinite(state.lastCommitAtMs)
        ? nowMs - state.lastCommitAtMs
        : null;
  return { kind: 'stalled', ageMs, reason };
}
