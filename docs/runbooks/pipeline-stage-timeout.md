# Pipeline stage timeout

A deep-planning-pipeline stage (brainstorm, spec, plan, review, or dispatch) exceeded its per-stage timeout (`pol-stage-timeout-ms`, queued as task #290). The pipeline halts; the stage's agent-session atom carries `terminal_state=timeout` with whatever partial output the stage produced before the timer fired.

## Symptoms

- A pipeline atom shows `pipeline_state=halted` with a halting stage identified in the metadata.
- The stage's `agent-session` atom has `terminal_state=timeout` (not `success` or `failed`).
- `pipeline-audit-finding` atoms may reference the partial output if the auditor inspected the truncated stage.
- The Console Pipelines view shows the stage card in a halted/timeout tone.
- The operator's intent (the seed `operator-intent` atom) is stuck without a downstream PR.

## Atom kinds that fire

- `agent-session` atom with `terminal_state=timeout` and `meta.elapsed_ms >= pol-stage-timeout-ms.timeout_ms` for the offending stage's principal.
- `agent-turn` atoms with the partial LLM output up to the timeout boundary (the substrate writes these as the stream advances; the timeout cuts the stream mid-turn).
- `pipeline-audit-finding` atoms with `category=stage-timeout` when the auditor stage observes a halted upstream.

## Recovery steps

The recovery branches on whether the partial output is usable.

1. Read the stage's `agent-session` atom: locate via `find .lag/atoms -name "agent-session-*.json"` filtered by the pipeline id from the halted pipeline atom's metadata.
2. Inspect the last `agent-turn` atom for the stage: was the stage on a productive track (clear intent, mid-draft) or thrashing (re-reading the same files, no convergence)?
3. **Productive track**: re-prompt the stage with the auditor-feedback loop from task #293. The cross-stage reprompt config (`pol-cross-stage-reprompt`) lets the auditor inject a feedback turn that picks up from the partial output. Invoke via the same `scripts/run-cto-actor.mjs --mode=substrate-deep` with the pipeline id; the runner re-enters the stage with the partial output as resume context.
4. **Thrashing track**: escalate the intent to the operator. The stage cannot complete within the budget; the operator must either widen the timeout (canon edit on `pol-stage-timeout-ms`) or rewrite the operator-intent to narrow the scope. File an `escalation` actor-message atom via the Notifier.
5. For repeat timeouts on the same stage type (e.g., spec-stage timing out on three consecutive pipelines): the timeout is wrong for the workload. Edit `pol-stage-timeout-ms` upward via canon and document the bump rationale in a decision atom per `feedback_rca_vs_masking_discipline` (separate the structural part from the budget-bumping part).
6. Operator-action atom: file an `operator-action` recording the recovery decision (re-prompt vs escalate vs canon-edit-the-timeout).

## Prevention follow-up

- Substrate gap: the `pol-stage-timeout-ms` policy reader is referenced by task #290 but the enforcement seam in `src/runtime/planning-pipeline/runner.ts` is the binding code path. The runner must read the policy at stage-start and AbortController the LLM call when the budget elapses.
- Auditor-feedback loop integration: task #293 shipped the cross-stage reprompt config; the stage-timeout flow should route through the same config so timeout-recovery and audit-finding-recovery share one code path per the canon `dev-no-hacky-workarounds` directive (extract at N=2 per `dev-extract-at-n-two`).
- Telemetry: every timeout fires an `agent-session` atom with elapsed_ms; a Console widget aggregating timeouts-per-stage would surface workload bumps before three consecutive halts.

## Related

- Code: `src/runtime/planning-pipeline/runner.ts`, `src/runtime/planning-pipeline/auditor-feedback-reprompt.ts`, `src/runtime/planning-pipeline/cross-stage-reprompt-config.ts`
- Canon: `dev-deep-planning-pipeline`, `dev-no-hacky-workarounds`, `pol-stage-timeout-ms` (task #290)
- Memory: `feedback_rca_vs_masking_discipline`
- Self-audit V0 finding P3 (operator-readiness dashboard; audit artifact pending publication)
