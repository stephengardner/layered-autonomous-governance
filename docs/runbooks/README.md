# Runbooks

3am incident playbooks for the LAG operator. Each runbook follows a fixed shape:

1. **Symptoms** the operator observes on Console / Pulse / Telegram.
2. **Atom kinds that fire** when the incident is in progress (or whose absence signals it).
3. **Recovery steps** the operator runs.
4. **Prevention follow-up** that closes the loop substrate-side.
5. **Related** code, canon, and audit references.

Per `docs/audit/2026-05-22-perpetual-self-audit-v0.md` finding P1: the substrate emits atoms; the runbooks turn those atom emissions into "what to do" playbooks. Without them the operator pattern-matches from the Console, which does not scale to an on-call rotation.

## Current runbooks

| Incident | Severity | Runbook |
|---|---|---|
| Bot token expired mid-PR | High | [bot-token-expired.md](bot-token-expired.md) |
| Claim-reaper not running | High | [reaper-not-running.md](reaper-not-running.md) |
| CodeRabbit silent-skip | Medium | [cr-silent-skip.md](cr-silent-skip.md) |
| Dispatch failed (drafter refusal, budget, worktree) | High | [dispatch-failed.md](dispatch-failed.md) |
| Pipeline stage timeout | Medium | [pipeline-stage-timeout.md](pipeline-stage-timeout.md) |
| Sub-agent stalled | Medium | [sub-agent-stalled.md](sub-agent-stalled.md) |
| Worktree cleanup failed (Windows EACCES) | Low | [worktree-cleanup-failed.md](worktree-cleanup-failed.md) |

## Coverage gap

The audit named 8-10 most-common 3am incidents. With this expansion the count is 7. The remaining 1-3 (atom-store ENOSPC, tunnel disconnected, PR-landing actor stuck) are queued for follow-up PRs.

## Discipline

- **Atom kinds first**: every runbook names the atom kinds that fire so the operator can verify the incident state from the AtomStore without trusting the runbook's prose.
- **Recovery is mechanical**: the steps are concrete commands; if a step requires judgment, the runbook says so and escalates.
- **Substrate-side prevention**: every runbook ends with a "prevention follow-up" that proposes the substrate change which would auto-detect or auto-recover. The runbook is the bridge; the substrate fix is the destination.
- **No emdashes** anywhere (CI gate).

## Related

- [Self-audit V0 artifact](../audit/2026-05-22-perpetual-self-audit-v0.md) (finding P1 motivates these runbooks)
- [Architecture](../architecture.md)
- [Bot identities](../bot-identities.md)
