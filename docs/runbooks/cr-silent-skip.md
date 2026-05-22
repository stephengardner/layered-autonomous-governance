# CodeRabbit silent-skip after multi-round CHANGES_REQUESTED

CR's incremental-review engine has stopped re-reviewing a bot-authored PR after multiple CHANGES_REQUESTED rounds. The PR is `mergeStateStatus=BLOCKED` with `reviewDecision=CHANGES_REQUESTED` even though every flagged finding is addressed.

## Symptoms

- `node scripts/pr-status.mjs <pr>` shows `cr_verdict=pending` or `success` (legacy status posted) but `reviewDecision=CHANGES_REQUESTED`.
- The latest submitted review is COMMENTED or CHANGES_REQUESTED on a commit BEFORE the most recent fix-push.
- `node scripts/cr-trigger.mjs <pr>` returns the comment URL but CR does not post a fresh review within 5-10 minutes.
- All 12+ check-runs report `success`; 0 unresolved review comments.

## Atom kinds that fire

- `operator-action` atoms record each `cr-trigger.mjs` invocation; absence of a CR review after multiple triggers is the silent-skip signal.
- No specific `cr-silent-skip` atom kind exists; the substrate observes via `pr-status.mjs` polling.

## Recovery steps

Per canon `dev-cr-blocked-missing-take-action`, the loop must converge on an action; sitting in queue-buildup discipline is forbidden. The escalation playbook documented in `feedback_cr_incremental_skip_after_fix`:

1. Push an empty-commit nudge: `node scripts/git-as.mjs lag-ceo -C <worktree> commit --allow-empty -m 'chore: empty-commit to nudge CR (silent-skip recovery)' && node scripts/git-as.mjs lag-ceo -C <worktree> push origin <branch>`. This re-triggers CR's webhook.
2. If empty-commit does not work within 5 minutes, push a substantive diff. Even a small test addition or a doc comment fix that touches a file CR reviewed before will force the incremental engine to re-evaluate.
3. Try `@coderabbitai full review` (NOT `@coderabbitai review`): the `full review` command bypasses the incremental cache and forces a complete re-pass. Post via `cr-trigger.mjs` with the alternate body OR direct API call:
   ```bash
   curl -X POST \
     "https://api.github.com/repos/<owner>/<repo>/issues/<pr>/comments" \
     -H "Authorization: Bearer $LAG_OPS_PAT" \
     -d '{"body": "@coderabbitai full review"}'
   ```
4. If CR posts CHANGES_REQUESTED with the same findings already addressed: reply inline with the rationale + dismiss the stale review via `gh api -X PUT repos/<owner>/<repo>/pulls/<pr>/reviews/<review-id>/dismissals`.
5. If 3+ rounds of (1)-(4) fail: surface to operator with the `pr-status.mjs` output and the diagnostics tried. The operator may admin-merge per the PR #238 precedent (decision atom records the bypass).

## Prevention follow-up

- Front-load polish: per `feedback_cr_recurring_pattern_presubmit_checklist` and `feedback_cr_silent_skip_guards`, the 8 CR-flagged patterns (src/ vocabulary, YYYY-MM-DD convention, Z-implies-UTC, etc.) should be checked pre-push, not post-CR.
- Substrate gap: the `cr-precheck` workflow (PR #172) runs CR CLI locally on the diff before push, catching most findings before they hit CR's web pass. Operators should keep `CODERABBIT_API_KEY` configured to activate the CI backstop.
- Canon gate: `dev-cr-blocked-missing-take-action` requires action within 15 minutes; the recovery script for empty-commit nudge could be wrapped in a `scripts/cr-unstick.mjs` helper that the loop calls automatically.

## Related

- Code: `scripts/cr-trigger.mjs`, `scripts/pr-status.mjs`, `scripts/cr-precheck.mjs`
- Canon: `dev-cr-blocked-missing-take-action`, `dev-cr-triggers-via-machine-user-only`
- Memory: `feedback_cr_incremental_skip_after_fix`, `feedback_cr_silent_skip_guards`, `feedback_cr_auto_re_review_on_push`
- Self-audit finding G1: `docs/audit/2026-05-22-perpetual-self-audit-v0.md`
