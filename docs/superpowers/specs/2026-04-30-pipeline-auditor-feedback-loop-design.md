# Pipeline Auditor-Findings Feedback Loop -- Design Spec

**Status**: draft
**Date**: 2026-04-30
**Derived from**: `dev-deep-planning-pipeline` (L3, ratified 2026-04-30 via PR #246), PR #247 (`feat/brainstorm-citation-soft`)
**Successor work to**: PR #247 (severity-downgrade interim fix)

## 0. Indie-floor + org-ceiling fit

A solo developer running a typo-fix prompt should never see a feedback loop. The mode-gate stays `single-pass` by default (per `pol-planning-pipeline-default-mode`), and within a substrate-deep run the loop activates only on findings of severity `>= major` AND only when the stage opts in via an explicit `acceptsAuditFeedback: true` flag on the `PlanningStage` interface. An org running 50+ concurrent actors that wants the loop on every stage flips a higher-priority canon atom; raising the dial is a canon edit, not a code change.

## 1. Goal

When a pipeline stage's `audit()` returns findings the LLM could plausibly self-correct, give the drafter exactly one chance to re-emit a corrected payload before the runner halts the stage. Closes the gap PR #247 papers over with a severity downgrade.

Concrete: a brainstorm-stage emits a payload with a fabricated `atom:foo-bar` citation. Today (post-PR #247): finding logged at `major`, pipeline proceeds with bad data on disk. Tomorrow: finding fed back to drafter, drafter re-emits without the citation, pipeline proceeds with correct data.

## 2. Current state (post-PR #247)

```
runStage:
  output  = stage.run(input)
  findings = stage.audit(output, ctx) ?? []
  for finding in findings:
    write pipeline-audit-finding atom
  if any finding has severity === 'critical':
    write pipeline-stage-event(exit-failure)
    return { halted: true }
  else:
    write pipeline-stage-event(exit-success)
    return { halted: false, output }
```

Failure mode: a `major` finding is logged but the pipeline accepts the imperfect output. The auditor is observational, not corrective.

## 3. Proposed: re-prompt on findings

```
runStage:
  attempts = 0
  prior_findings = []
  loop:
    output = stage.run({ ...input, prior_audit_findings: prior_findings })
    findings = stage.audit(output, ctx) ?? []
    for finding in findings: write pipeline-audit-finding atom
    if findings.every(f => f.severity === 'minor'):
      write pipeline-stage-event(exit-success)
      return { halted: false, output }
    if attempts >= max_audit_retries:
      // Original critical-halts-stage / major-proceeds-with-warning behaviour
      if any finding is 'critical':
        write pipeline-stage-event(exit-failure)
        return { halted: true }
      write pipeline-stage-event(exit-success-with-findings)
      return { halted: false, output }
    if !stage.acceptsAuditFeedback:
      // Stage opted out; fall through to original behaviour
      ... (same as above)
    write pipeline-stage-event(retry-after-findings)
    prior_findings = findings
    attempts += 1
```

## 4. Substrate changes

### 4.1 `StageInput<T>` gains an optional field

```ts
interface StageInput<T> {
  ...existing fields;
  /** Audit findings from the prior attempt at this stage; empty on first attempt. */
  readonly prior_audit_findings: ReadonlyArray<AuditFinding>;
}
```

Default value: `[]`. Existing stages that don't read this field stay backwards-compatible.

### 4.2 `PlanningStage` gains an opt-in flag

```ts
interface PlanningStage<TIn, TOut> {
  ...existing fields;
  /** When true, runner re-invokes `run()` with prior_audit_findings on findings of severity >= major,
   *  up to max_audit_retries times. Default: false (preserves current behaviour). */
  readonly acceptsAuditFeedback?: boolean;
}
```

Reference adapters (`brainstorm-stage`, `spec-stage`, `plan-stage`, `review-stage`, `dispatch-stage`) flip this to `true` per stage as they become loop-aware. The runner change ships first; adapter migrations follow per stage.

### 4.3 New atom event type

`pipeline-stage-event.event_type` gains `'retry-after-findings'`. Carries `attempt_index`, `findings_summary` (count by severity), and `total_attempted` so the audit trail shows the loop activation.

### 4.4 New policy atom

```
pol-pipeline-stage-audit-retry-max
  scope: { stage_name?: string }   // omit for global default
  policy:
    max_audit_retries: number      // default: 1
    severity_floor: 'major'        // 'major' | 'critical' -- only retry on findings at/above this severity
```

Indie-floor default: `max_audit_retries=1`, `severity_floor='major'`. Org-ceiling deployments raise to 2-3 if their LLM-of-choice benefits from multi-shot self-correction.

## 5. Stage-adapter migration: brainstorm-stage as the first consumer

When `prior_audit_findings.length > 0`, the brainstorm-stage prompt prepends:

```
Your prior attempt produced these audit findings:

{for f in prior_audit_findings:}
  - [{f.severity}] {f.category}: {f.message}

Re-emit the payload addressing each finding. If a finding flags a fabricated
citation, omit the citation. If a finding flags a non-seed citation, omit it
or replace it with the corresponding verified id from data.verified_seed_atom_ids.
```

The LLM's second pass should produce a payload that satisfies the audit. If it doesn't, the loop terminates per max_audit_retries and the original halt-on-critical behaviour fires.

PR #247's severity downgrade can then be reverted (separate PR): brainstorm citation findings return to `critical`, but the runner re-prompts before halting. The audit-trail atom flow remains identical.

## 6. Threat model

**Tampered pipeline atom mid-loop**: between attempts, a malicious peer could mutate the pipeline atom's seedAtomIds. The runner already does claim-before-mutate via the optimistic-version field; we extend the claim window to cover the entire retry loop, not just one attempt. Concretely: `lastVersion` is captured at attempt 0, every attempt's pipeline-stage-event write asserts that version, the loop terminates on a version-mismatch claim-failure rather than racing.

**Prompt injection via prior_audit_findings**: a stage that emits a malicious `cited_paths: ["../../../etc/passwd"]` could inject prose into the next attempt's prompt. Mitigation: the runner sanitizes finding messages before passing them to `stage.run()`. Specifically, `cited_paths` and `cited_atom_ids` are flattened into structured fields that the prompt template consumes positionally; raw `message` strings are bounded by `MAX_FINDING_MESSAGE_LEN` (default 1024) and HTML-stripped.

**Cost overflow via retry storm**: `max_audit_retries=1` is the default, hard-capped at 5 even by canon override. Each attempt's `cost_usd` accumulates against the existing per-stage `budget_cap_usd`; a runaway re-prompt loop hits the budget cap and halts with `cause: 'budget-overflow'` (existing mechanism, no new code).

**Self-confirming bias**: feeding the auditor's findings back to the drafter risks the drafter "fixing" the citation in a way the same auditor accepts but a fresh auditor would reject. Mitigation: when `acceptsAuditFeedback === true`, the auditor's atom-resolvability check stays mechanical (host.atoms.get) -- the auditor does not take prior findings as input. The bias surface is the LLM, not the auditor.

## 7. Test plan

- Unit: `runStage` retry-loop with mock audit returning findings on attempt 0, none on attempt 1. Asserts `run()` called twice, `prior_audit_findings` populated on the second call, exit-success event written.
- Unit: `runStage` with `max_audit_retries=0` falls through to original behaviour (no retry, halt on critical).
- Unit: `runStage` with `acceptsAuditFeedback=false` skips the loop entirely.
- Unit: budget overflow during retry triggers `exit-failure(budget-overflow)`, not `exit-success-with-findings`.
- Integration (MemoryHost): full pipeline run with brainstorm-stage that emits a fabricated citation on attempt 0 and a clean payload on attempt 1; pipeline reaches spec-stage successfully.
- Conformance: claim-before-mutate version assertion holds across the entire retry window.

## 8. Migration plan

PR-A (this spec, docs only) -- committed as `docs/pipeline-feedback-loop-spec`.
PR-B -- substrate runner change: `StageInput.prior_audit_findings` field, `PlanningStage.acceptsAuditFeedback` flag, runner retry loop, new `pipeline-stage-event.retry-after-findings`, new `pol-pipeline-stage-audit-retry-max` policy parser. Reference adapters opt out (`acceptsAuditFeedback: false`) initially.
PR-C -- brainstorm-stage opt-in (`acceptsAuditFeedback: true`), prompt-template change, revert PR #247's severity downgrade.
PR-D -- spec-stage opt-in.
PR-E -- plan-stage opt-in.
PR-F -- review-stage / dispatch-stage opt-in.

Per PR-B's flag-default-false, the substrate change is non-breaking; deployments running pinned reference adapters keep current behaviour until they explicitly opt in.

## 9. What breaks if revisited in 3 months

The retry loop is a substrate-defined ENUM (per `dev-apex-tunable-trade-off-dials`): off / minor-only / major-and-up / critical-and-up. Default is major-and-up. A future deployment that wants finer control adds a higher-priority policy atom, not a code change.

The `prior_audit_findings` field is additive on `StageInput<T>`; adapters that don't read it continue to work. The `acceptsAuditFeedback` flag is opt-in; existing reference adapters preserve their post-PR #247 severity-downgrade until each is migrated.

The DAG forward-compat seam (`PlanningStage.dependsOn`) is orthogonal to retry behaviour: a stage in a parallel DAG branch retries the same way regardless of how the runner orders branches.

## 10. Out of scope (deferred)

- **Auditor-of-auditor**: a second auditor verifying the first didn't drift. Wait for the second concrete consumer per `dev-no-speculative-substrate`.
- **Cross-stage retry**: re-running stage N+1 when stage N's findings change after N+1 has already started. Today the runner walks stages strictly sequentially; cross-stage retry is a parallel-DAG concern.
- **Operator-in-the-loop interleaving**: pausing the retry on the first finding for HIL approval. The `pol-pipeline-stage-hil-<stage>` atom already gates on `pause_mode='on-critical-finding'`; HIL interleaves between stages, not within a stage's retry loop.

## 11. Implementation gating

Land PR-A (this spec) only after PR #247 (`feat/brainstorm-citation-soft`) has merged, so the severity-downgrade interim is in main as the no-loop fallback. PR-C's revert of #247 then becomes the natural cap of the migration.
