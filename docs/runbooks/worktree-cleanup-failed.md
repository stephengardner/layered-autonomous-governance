# Worktree cleanup failed

A `git worktree remove` (manual or via `scripts/lib/cleanup-merged-worktrees.mjs`) failed with Windows `EACCES` or `EBUSY` on a lock file inside `.worktrees/<name>/.git/`. The branch may have been deleted but the worktree directory remains on disk, and stale credentials at `.lag/apps/` leak across worktrees if not cleaned up.

## Symptoms

- `git worktree remove .worktrees/<name>` exits non-zero with `unable to delete '.worktrees/<name>/.git/index.lock'` or similar `EACCES`/`EBUSY` on Windows.
- `.worktrees/<name>/` directory is still present after the failed remove; `git worktree list` no longer shows it (the branch was unregistered but the disk artifact remains).
- A subsequent `git worktree add` to the same path fails with `'.worktrees/<name>' already exists`.
- Bot credentials at `.worktrees/<name>/.lag/apps/` are visible to any new worktree created with the same name (the leftover dir gets re-attached).

## Atom kinds that fire

- No specific `worktree-cleanup-failed` atom kind exists today; the planner in `scripts/lib/cleanup-merged-worktrees.mjs` is pure (decide-only) and never writes atoms. The operator-invoked CLI that wraps the planner prints the failure to stderr.
- `operator-action` atoms record manual cleanup attempts when the operator runs the cleanup script with `--write-audit`.

## Recovery steps

Per `feedback_no_head_tail_cat_in_bash` (the related memory) AND the worktree-cleanup planner shipped in PR #438, the root cause on Windows is a process holding a file inside the worktree (typically a `tsx watch` dev server, a Vite HMR worker, or an unkilled `node` process from a prior test run).

1. Identify what is holding the lock: on Windows, `handle64.exe '.worktrees\<name>'` (Sysinternals) or `Get-Process | Where-Object { $_.Modules | Where-Object { $_.FileName -like '*<name>*' } }` in PowerShell. On Unix, `lsof +D .worktrees/<name>/`.
2. Kill the offending process. Common offenders:
   - `tsx watch` dev server from `apps/console/server` or a stage runner.
   - A leftover `node` from a prior test run (`vitest --watch`, Playwright trace viewer).
   - Cloudflared tunnel that was launched from the worktree.
3. Wait 5 seconds for Windows to release the file handles. (Windows does not release on process-exit immediately; there is a small kernel-level delay.)
4. Retry: `git worktree remove --force .worktrees/<name>`.
5. If `--force` still fails: manually delete the directory with `Remove-Item -Recurse -Force .worktrees/<name>` (PowerShell) or `rm -rf .worktrees/<name>` (bash), then run `git worktree prune` to clean up the git metadata.
6. If credentials leaked: also delete `.worktrees/<name>/.lag/apps/` explicitly before any re-create. The substrate's `git-as.mjs` walks up the worktree tree looking for `.lag/apps/`; a leftover credential at the wrong depth shadows the canonical copy at the primary worktree.
7. Operator-action atom: file an `operator-action` recording the manual cleanup so the audit chain shows what was force-removed.

## Prevention follow-up

- Substrate handling: `scripts/lib/cleanup-merged-worktrees.mjs` already implements the keep-conservatively logic per `dev-no-hacky-workarounds`: any dirty working tree, unmerged branch, or unknown merge-state defaults to KEEP. The planner refuses to gamble on incomplete signals; the runbook only fires when the OPERATOR force-removed something the planner had marked KEEP.
- Process discipline: every `tsx watch` or Vite dev-server launched from a sub-agent worktree must be killed at sub-agent terminal report. Sub-agents that hold dev servers past their lifecycle are the upstream cause of this incident; the `dev-sub-agent-pr-driver-responsibility` canon directive covers the lifecycle obligation.
- Console gap: `dev-server-cleanup.mjs` exists in `scripts/lib/` and `scripts/` as a kill-helper; consider wiring it into the cleanup-worktrees flow so the script kills known dev-server processes before attempting the worktree remove.

## Related

- Code: `scripts/lib/cleanup-merged-worktrees.mjs`, `scripts/lib/scan-worktrees.mjs`, `scripts/lib/dev-server-cleanup.mjs`
- Memory: `feedback_no_head_tail_cat_in_bash`, `feedback_bot_creds_copy_to_new_worktrees`
- Canon: `dev-no-hacky-workarounds`, `dev-sub-agent-pr-driver-responsibility`
- Self-audit V0 finding P3 (operator-readiness dashboard; audit artifact pending publication)
