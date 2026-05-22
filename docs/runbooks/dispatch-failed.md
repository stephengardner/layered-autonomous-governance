# Dispatch failed

Sub-actor dispatch failed during the dispatch-stage of a planning pipeline. The plan is stuck in `plan_state=executing`, no `pr-observation` atom was seeded, and the operator's intent has no downstream PR. Three common failure modes: drafter refusal, worktree-acquire error, code-author budget exceeded.

## Symptoms

- Plan atom shows `plan_state=executing` with no follow-up `pr-observation` atom referencing the plan.
- `agent-session` atom for the dispatched sub-actor shows `terminal_state=failed` (not `success` or `timeout`).
- A `dispatch-failed` observation atom or `drafter-refusal` finding atom references the plan id.
- The Console Pipelines view shows the pipeline halted at the dispatch stage with no PR card.
- For drafter-refusal specifically: `pipeline-audit-finding` atoms with `category=dispatch-drafter-refusal` (severity critical) reference the silent-skip no-op observation.

## Atom kinds that fire

- `agent-session` with `terminal_state=failed` and `meta.failure_reason` carrying the underlying error.
- Observation atom with `meta.kind=dispatch-failed` capturing the dispatch attempt and its failure mode.
- For drafter refusals: `code-author-invoked` atom whose executor terminated as a silent-skip no-op, followed by a `pipeline-audit-finding` with `category=dispatch-drafter-refusal` that names the drafter notes prefix.
- For budget-exceeded: the `code-author-invoked` atom's metadata carries the budget-cap signal; the cap is per `pol-code-author-effort-cap` (canon directive `dev-code-author-llm-spend-cap-per-pr`).

## Recovery steps

The recovery branches on the failure reason atom.

1. Identify the failure: locate the `dispatch-failed` observation or `agent-session` with `terminal_state=failed`. Read `meta.failure_reason` (or `meta.kind`) to classify.
2. Check whether `reprompt_target` is set on any downstream `pipeline-audit-finding`: the Phase 2 cross-stage reprompt loop (task #293, `src/runtime/planning-pipeline/cross-stage-reprompt-config.ts`) addresses `dispatch-drafter-refusal` findings autonomously. If `reprompt_target` is populated, the runner will re-enter the targeted stage on the next pipeline tick; no manual action needed beyond letting the loop run.
3. **Drafter refusal (no reprompt_target, or repeat refusal)**: inspect the drafter notes prefix in the audit finding. Common causes:
   - Plan target_paths are empty or invalid: re-plan with explicit target_paths per `dev-code-author-empty-diff-rejection`.
   - Drafter context is missing canon citations the plan requires: re-prompt the spec-stage to ground the citations per `dev-citation-fence-plan-spec-review`.
4. **Worktree-acquire error**: the substrate failed to create or attach an isolated worktree for the dispatched sub-actor. Run `node scripts/sub-agent-stall-watch.mjs` to see if leftover worktrees are blocking; see also `worktree-cleanup-failed.md` for the cleanup playbook.
5. **Code-author budget exceeded**: the per-PR effort cap (`pol-code-author-effort-cap`) tripped. Decide: is the plan oversized (re-plan into smaller PRs), or is the cap too tight for the workload (canon edit the policy). Bumping the cap without RCA is the failure mode `feedback_rca_vs_masking_discipline` warns against.
6. For non-recoverable failures (drafter refused three times with the same notes, budget exceeded on a plan already at minimum scope): surface to operator via `Notifier` with an `escalation` actor-message atom. Cite the failure atom ids; the operator decides whether to widen policy or abandon the intent.
7. Operator-action atom: file an `operator-action` recording the dispatch-failure handling so the audit chain shows the recovery path taken.

## Prevention follow-up

- Substrate gap: code-author dispatch was missing the `pr-observation` seed until PR #346 (`fix(planning-pipeline): seed pr-observation atom on code-author dispatch`). Verify the fix is present by checking `src/runtime/planning-pipeline/runner.ts` writes a `pr-observation` atom on dispatch-success regardless of the executor kind.
- Drafter discipline: the citation-fence canon (`dev-citation-fence-plan-spec-review` plus `dev-drafter-cited-paths-fence`) catches missing/invented citations BEFORE the drafter is invoked. Pre-dispatch validation that runs the citation-fence over the plan is the upstream prevention.
- Auditor-feedback loop coverage: task #293 added the cross-stage reprompt for drafter-refusal; extending coverage to budget-exceeded and worktree-acquire-error would let the loop self-recover on all three failure modes per `dev-no-hacky-workarounds`.

## Related

- Code: `src/runtime/actor-message/plan-dispatch.ts`, `examples/planning-stages/dispatch/index.ts`, `src/runtime/planning-pipeline/auditor-feedback-reprompt.ts`
- Canon: `dev-code-author-llm-spend-cap-per-pr`, `dev-citation-fence-plan-spec-review`, `dev-drafter-cited-paths-fence`, `dev-no-hacky-workarounds`
- Memory: `feedback_rca_vs_masking_discipline`, `project_substrate_gap8_code_author_dispatch_no_pr_observation_seed`
- Self-audit finding P3: `docs/audit/2026-05-22-perpetual-self-audit-v0.md`
