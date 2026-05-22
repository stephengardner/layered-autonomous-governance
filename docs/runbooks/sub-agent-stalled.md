# Sub-agent stalled

A dispatched sub-agent (Agent-tool spawn, or a parent-side `run-*-actor.mjs` invocation) has stopped progressing. The stall watcher (PR #434) classifies the worktree as `stalled` after the deadline elapses without a commit, file edit, or status atom from the sub-agent.

## Symptoms

- `node scripts/sub-agent-stall-watch.mjs` exits 2 with one or more lines reading `kind=stalled`.
- The sub-agent's worktree at `.worktrees/<slug>/` shows no `git log` advance in the last 30 minutes and no working-tree edits (`git status --porcelain` empty or unchanged).
- The Pulse page shows the sub-agent's last activity timestamp aging past `DEFAULT_STALL_DEADLINE_MS` (30 min).
- The parent loop or operator has no terminal report from the sub-agent; the Agent tool is still considered in-flight.

## Atom kinds that fire

Per the V0 design in `scripts/lib/sub-agent-stall-detect.mjs`, the watcher itself writes NO atoms; the watcher is observability-only. The follow-up LoopRunner pass (queued) writes:

- `stall-watch` atoms with `kind=no-recent-commit` (worktree had a prior commit but none in deadline window).
- `stall-watch` atoms with `kind=stale-branch` (branch HEAD older than deadline, no working-tree edits).
- `stall-watch` atoms with `kind=detached-head` (worktree in detached-HEAD state, typically a rebase or bisect interrupted).

Until the LoopRunner pass ships, the absence-of-progress is the only signal; check via the watch CLI on each loop tick.

## Recovery steps

1. Run `node scripts/sub-agent-stall-watch.mjs --json` to capture the full classification across all worktrees in one shot.
2. Identify the stalled sub-agent: match the worktree slug to the Agent task via the parent's TaskGet (or operator session log).
3. Inspect the sub-agent task with TaskGet (the parent agent has the task id) to see the last assistant turn. Two failure modes:
   - **Mid-turn hang**: the sub-agent typed once, then the LLM stopped streaming. The worktree has uncommitted edits visible in `git status`. Recovery: re-dispatch with the SAME prompt to resume context; the sub-agent's prior work is in the worktree so it picks up where it left off.
   - **No progress at all**: working tree clean, no commits, no edits. Recovery: fresh-spawn with a NEW context. The sub-agent never made it past the loading phase; resuming would inherit the failed context.
4. If re-dispatch: invoke the SAME `scripts/run-*-actor.mjs` (or Agent task) with the same prompt. The sub-agent resumes with the working tree intact.
5. If fresh-spawn: kill the prior Agent task (TaskStop), clean the worktree via `node scripts/lib/cleanup-merged-worktrees.mjs` (keep-conservatively for unmerged branches), and re-dispatch from scratch.
6. Operator-action atom: file an `operator-action` recording the takeover so the audit chain shows the recovery.

## Prevention follow-up

- Substrate gap: the watcher is read-only in V0. The LoopRunner pass that auto-dispatches takeover sub-agents on `kind=stalled` is queued behind enough operator-observed stall cases to validate the 30-minute deadline default.
- Sub-agent discipline: per `dev-sub-agent-pr-driver-responsibility`, every sub-agent must terminate with an explicit status (DONE, HANDOFF, BLOCKED). A silent termination is the failure mode this runbook addresses; the canon directive is the long-term prevention.
- Deadline tuning: deployments running tight SLAs override `DEFAULT_STALL_DEADLINE_MS` via canon policy when the LoopRunner pass ships; the watcher already accepts the deadline as a per-call input.

## Related

- Code: `scripts/sub-agent-stall-watch.mjs`, `scripts/lib/sub-agent-stall-detect.mjs`, `scripts/lib/scan-worktrees.mjs`
- Canon: `dev-sub-agent-pr-driver-responsibility`
- Self-audit V0 finding P3 (operator-readiness dashboard; audit artifact pending publication)
