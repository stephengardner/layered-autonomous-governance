# Medium-tier kill switch tripped

The `MediumTierKillSwitch` substrate seam (shipped in PR #455 / D13) terminates armed subprocesses when the actor loop halts on a kill condition: STOP-sentinel write, parent-signal abort, or deadline exceeded. When the operator wires a `MediumTierKillSwitch` implementation (the reference being `ProcessSupervisor` at `examples/kill-switches/process-supervisor/`), every armed PID is signaled at trip time. This runbook covers the high-severity case where a trip just fired and the operator needs to decide whether to re-arm, audit, or escalate.

## Symptoms

- A `kill-switch-tripped` atom appears in the AtomStore with `metadata.kind=kill-switch-tripped`. The atom carries the actor name, principal id, trigger (`stop-sentinel | parent-signal | deadline`), and phase (`observe | classify | propose | apply | between-iterations | halt-reconciliation`).
- The actor's apply-loop unwinds with `haltReason='kill-switch'`. Any in-flight `runActor` invocation returns at the top of its next iteration.
- Subprocesses the operator armed via `killSwitch.arm(pid)` are gone. Probe with `process.kill(pid, 0)`; ESRCH confirms the kill landed.
- Console System Health (PR #453) shows the substrate probes; if the trip was triggered by a `STOP` sentinel write the operator should also see the sentinel file at `.lag/STOP`.

## Atom kinds that fire

- `kill-switch-tripped` (the canonical trip record, written by `runActor` at halt time via `mkKillSwitchTrippedAtom` in `src/substrate/kill-switch/tripped-atom.ts`). Includes the trip's exact runtime state (iteration, phase, in-flight tool) so auditors can reconstruct what was interrupted without joining against the audit log.
- An optional `medium-tier-supervisor-error` atom may accompany the trip when `tripAll()` itself failed (the contract specifies trip is best-effort signaling, so this is rare but possible).

## Recovery steps

1. **Verify what tripped.** Read the most recent `kill-switch-tripped` atom from the AtomStore. The `metadata.tripped_by` field names the trigger; the `metadata.phase` field names where the loop was halted; the `metadata.iteration` field names which apply tick was interrupted.
2. **Inspect the Console System Health page.** The page surfaces the bot-identity, substrate-probe, and adapter-health rows. If a probe is red, that is the primary blocker. If everything is green, the trip was clean (operator-initiated STOP, or a deadline the operator set deliberately).
3. **Walk the trip atom's `derived_from` chain.** The atom's provenance lists the upstream events that led to the halt. A `stop-sentinel` trip typically chains from the operator-written `.lag/STOP` file; a `deadline` trip chains from a scheduler atom that named the timeout; a `parent-signal` trip chains from the parent actor's escalation atom.
4. **Decide the recovery posture.** Three branches:
   - **Re-arm and resume**: the trip was deliberate, the operator's state is intact, the apply-loop can pick up where it left off. Remove `.lag/STOP` (if present), and re-invoke the relevant `scripts/run-*-actor.mjs`. The actor restores the per-actor canon policy and re-enters its apply-loop.
   - **Audit before resume**: the trip surfaced a structural concern (an unsafe phase, an in-flight tool that should not have been running). Read the `kill-switch-tripped` atom's `metadata.in_flight_tool` field plus the surrounding atom-store entries. Resolve the structural concern via a separate PR, then re-arm and resume.
   - **Escalate**: a trip fired during a phase the operator did not expect (mid-`apply`, mid-merge, mid-deploy). The blast radius needs a wider audit before re-arming. Write an `operator-action` atom recording the escalation and pause the loop until the audit lands.
5. **Confirm the substrate is clean.** Run the existing conformance suite at `test/conformance/kill-switch.test.ts` (PR #458) against the deployed `MediumTierKillSwitch` impl. The four contract clauses (arm idempotency, disarm idempotency, tripAll terminates, trip-set empties) validate the substrate is in a good state for re-arming.

## Prevention follow-up

- **Substrate gap (closed by PR #455 / D13)**: the medium-tier seam itself; before PR #455 a `STOP` write could only halt the actor loop at iteration boundaries, not terminate in-flight subprocesses. This runbook documents the post-D13 incident class.
- **Conformance harness (closed by PR #458)**: the `runMediumTierKillSwitchContract` runner at `test/conformance/shared/kill-switch-spec.ts` codifies what every BYO `MediumTierKillSwitch` impl must satisfy. A trip that fires unexpectedly should always be reproducible via the conformance suite; if it is not, the impl has drifted from the contract.
- **Future canon refresh**: per audit-v2 PR-7 (queued), a `dev-medium-tier-kill-switch-opt-in` canon directive will codify the post-D13 posture so future agents inherit the opt-in semantics without re-reading the four legacy gate atoms (`inv-kill-switch-first`, `dec-kill-switch-design-first`, `pol-cto-no-merge`, `pol-pr-landing-no-auto-merge`).
- **Conformance dashboard (queued, audit-v2 PR-6)**: an adapter-conformance row on the Console System Health page will surface conformance-suite pass/fail per deployed `MediumTierKillSwitch` impl, making trip-readiness observable in real time.

## Related

- Code: `src/substrate/kill-switch/index.ts` (the seam), `src/substrate/kill-switch/tripped-atom.ts` (the atom builder), `src/runtime/actors/run-actor.ts` (the halt-reconciliation logic), `examples/kill-switches/process-supervisor/` (the reference impl).
- Conformance: `test/conformance/shared/kill-switch-spec.ts`, `test/conformance/kill-switch.test.ts`.
- Canon: `inv-kill-switch-first`, `dev-medium-tier-kill-switch-loosening-requires-d13`, `dev-required-checks-must-cover-all-meaningful-ci`.
- Audit: `docs/audit/2026-05-22-perpetual-self-audit-v2.md` (PR-4 is this runbook; PR-7 the canon refresh).
