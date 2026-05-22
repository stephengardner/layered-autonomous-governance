## Symptoms

- PRs reported open by the watcher but no progress in the last hour.
- Stalled plans accumulating in `.lag/atoms/` past their TTL (look for `plan_state=proposed` atoms older than `pol-reaper-ttls.warn_ms`).
- Console Pulse page shows the loop-tick-heartbeat aging past 5 minutes without advancing.
- Sub-agents that dispatched but never closed reach the claim-reaper deadline; without the reaper they sit in `claim_state=pending` indefinitely.

## Atom kinds that fire

The reaper itself does not fire on failure; its ABSENCE is what surfaces. Look for what is NOT happening:

- `reaper-tick` atoms with recent `nowMs` (should fire on every loop tick when the pass is enabled).
- `pipeline-reaper-tick` atoms (separate reaper, same loop).
- `claim-reaper-tick` atoms.

If none of those exist in the last hour, the reaper is not running.

## Recovery steps

1. Confirm the LoopRunner process is alive: `ps -ef | grep run-loop` (or Windows equivalent). If the process is dead, restart with `node scripts/run-loop.ts --reap-stale-plans --reconcile-pr-orphans` (or the operator's usual flags).
2. If the process IS alive but no reaper-tick atoms fire, check whether the LoopRunner was started WITH `--reap-stale-plans`. Without that flag, the reaper passes are off by design (indie-floor default).
3. Out-of-band one-shot: `node scripts/reap-stale-pipelines.mjs --dry-run` previews what the reaper WOULD clean; drop `--dry-run` to live-run.
4. Re-enable reaper after restart: the canon policy atoms (`pol-loop-pass-claim-reaper-default` etc.) persist; the LoopRunner just needs to re-read them at startup.
5. Operator-action atom: file an `operator-action` recording the manual reaper invocation so the audit chain shows the recovery.

## Prevention follow-up

- Substrate gap: there is no atom kind that fires when the reaper SKIPS due to error. A reaper that throws inside the pass logs to stderr but produces no atom; the absence-of-tick is the only signal. Queued task #364 (operator-readiness dashboard + bot-identity health) covers a "system health" aggregator that would surface this. Until then, the absence-detection is manual.
- Canon hardening: `pol-loop-pass-claim-reaper-default` ships at `enabled: false` by indie-floor design. An org-ceiling deployment should override to `enabled: true` and document the override in their bootstrap script.

## Related

- Spec: [`dev-zero-failure-sub-agent`](../../CLAUDE.md#L3-canon) (the canon directive the reaper substrate satisfies)
- Code: `src/runtime/loop/claim-reaper.ts`, `src/runtime/loop/pipeline-reaper-ttls.ts`
- Self-audit finding P1: `docs/audit/2026-05-22-perpetual-self-audit-v0.md`
