// Pure planner: decide which worktrees are safe to remove based on
// their branch's merge-status against the upstream main branch.
//
// Why a pure planner: removing a worktree is a destructive operation
// that the substrate must not perform blindly. Splitting "decide" from
// "execute" lets the driver script offer --dry-run + lets a caller
// (Console, LoopRunner pass extension follow-up) preview the plan
// before any rm. Also lets tests drive the planner with a state
// struct rather than spawning git.
//
// Pairs with scripts/lib/scan-worktrees.mjs (PR #436): that scanner
// reports lastEditAtMs + commitsAhead + workingTreeDirty per
// worktree; this planner is the "what to do with the result" layer.

/**
 * Decide whether a single worktree is safe to remove. Returns one of:
 *
 *   - `{kind: 'remove', reason}`: branch fully merged to main AND
 *     working tree is clean AND no commits ahead. Safe to drop.
 *   - `{kind: 'keep', reason}`: at least one signal says active work
 *     is in flight (dirty tree, commits ahead, branch not merged,
 *     unknown merge-state). The reason describes which signal anchored
 *     the decision so the operator can audit.
 *
 * Input shape:
 *   - `worktreePath`: absolute path (passed through to the output for
 *     the driver to act on).
 *   - `branch`: the branch name. Null/HEAD means detached; keep
 *     conservatively.
 *   - `mergedToMain`: true when `git branch --merged origin/main`
 *     lists this branch, false otherwise. Null means unknown
 *     (e.g. origin/main not yet fetched); keep conservatively.
 *   - `commitsAhead`: commits the branch has past origin/main. >0
 *     means committed-but-unmerged work; keep.
 *   - `workingTreeDirty`: true when `git status --porcelain` shows
 *     any entry. Uncommitted edits; keep.
 *
 * Decision precedence (any "keep" signal wins):
 *   1. workingTreeDirty -> keep ('dirty-working-tree')
 *   2. branch detached / null -> keep ('detached-head-or-unknown')
 *   3. mergedToMain === null (unknown) -> keep ('merge-state-unknown')
 *   4. mergedToMain === false -> keep ('not-merged-to-main')
 *   5. commitsAhead > 0 -> keep ('commits-ahead-of-main')
 *   6. otherwise -> remove ('merged-clean-no-commits-ahead')
 *
 * The rules are intentionally biased toward keep: a false-positive
 * remove deletes operator work, a false-positive keep just leaves
 * disk clutter. Per dev-no-hacky-workarounds the substrate refuses
 * to gamble on incomplete signals.
 */
export function planWorktreeRemoval(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('planWorktreeRemoval: input must be an object');
  }
  if (typeof input.worktreePath !== 'string' || input.worktreePath.length === 0) {
    throw new Error('planWorktreeRemoval: worktreePath must be a non-empty string');
  }

  const { worktreePath, branch, mergedToMain, commitsAhead, workingTreeDirty } = input;

  if (workingTreeDirty === true) {
    return { kind: 'keep', worktreePath, reason: 'dirty-working-tree' };
  }
  if (branch === null || branch === 'HEAD' || typeof branch !== 'string' || branch.length === 0) {
    return { kind: 'keep', worktreePath, reason: 'detached-head-or-unknown' };
  }
  if (mergedToMain === null || mergedToMain === undefined) {
    return { kind: 'keep', worktreePath, reason: 'merge-state-unknown' };
  }
  if (mergedToMain !== true) {
    return { kind: 'keep', worktreePath, reason: 'not-merged-to-main' };
  }
  if (typeof commitsAhead === 'number' && commitsAhead > 0) {
    return { kind: 'keep', worktreePath, reason: 'commits-ahead-of-main' };
  }
  return { kind: 'remove', worktreePath, reason: 'merged-clean-no-commits-ahead' };
}

/**
 * Plan a batch of worktrees. Takes a list of input structs (one per
 * worktree) and returns the planner output for each. Pure; no I/O.
 * Useful for the driver to render a single combined report.
 */
export function planWorktreeBatch(inputs) {
  if (!Array.isArray(inputs)) {
    throw new Error('planWorktreeBatch: inputs must be an array');
  }
  return inputs.map(planWorktreeRemoval);
}

/**
 * Discriminate the planner outputs into the two action buckets.
 * Convenience for the driver's --dry-run summary.
 */
export function summarizeBatch(results) {
  if (!Array.isArray(results)) {
    throw new Error('summarizeBatch: results must be an array');
  }
  const toRemove = results.filter((r) => r.kind === 'remove');
  const toKeep = results.filter((r) => r.kind === 'keep');
  return { toRemove, toKeep, totalScanned: results.length };
}
