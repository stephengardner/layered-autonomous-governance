# Perpetual Self-Audit Documents

This directory holds the forward-looking self-audit backlog series. Each document is the synthesized output of one or more `scripts/self-audit-tick.mjs` driver runs (wired into the LoopRunner via `runSelfAuditCadence`), pulled together into a prioritized ship list across six audit dimensions: test-coverage, governance-enforcement, future-proofing, operator-readiness, indie-floor, and org-ceiling.

## What a self-audit doc is

The driver scans the substrate at a moment in time, surfaces gaps the system itself revealed (failing-test traces, canon-vs-code drift, missing runbooks, untested seams, untyped capabilities), and proposes a small batch of next-leverage PRs. The doc is the human-readable digest. Each PR entry carries:

- a scope label (S / M / L)
- the primary + secondary audit dimensions it serves
- a "what" section concrete enough to scope the work
- a "why" section grounded in canon or a prior shipping artifact
- an "acceptance" section with the gate condition for the PR's merge

The doc is meant to be implementable end-to-end without further design conversation. A subsequent driver tick picks up the next gap; one PR ships per tick.

## Version-naming convention

Docs are named `YYYY-MM-DD-perpetual-self-audit-v<N>.md`. Versions are date-ordered. The latest version supersedes earlier ones as a forward queue; older versions stay checked in as the historical trail of what shipped, when, and why.

The one exception is v0. The v0 doc is a post-hoc projection back-fill, not a forward queue. It exists to resolve the broken runbook citations the v1 doc flagged as itself a finding, providing a canonical audit-doc shape for the cluster that pre-dated formal versioning. Future audits do not produce v0-style docs; they advance the v<N> sequence.

## Current series

- [2026-05-22 v0](2026-05-22-perpetual-self-audit-v0.md) is the post-hoc projection covering the cluster that closed with v1's first ship batch. Resolves five broken runbook references the v1 doc surfaced.
- [2026-05-22 v1](2026-05-22-perpetual-self-audit-v1.md) is the first formal forward queue. Ten-PR backlog across all six audit dimensions; the entire backlog landed (PRs #446 through #455).
- [2026-05-22 v2](2026-05-22-perpetual-self-audit-v2.md) is the current forward queue. Ten-PR backlog built on the substrate v1 left behind: conformance-harness placement, bootstrap-script test coverage, convergence audit, runbook expansion, agent-loop reference adapter, adapter-conformance dashboard, canon-refresh follow-ups, runActor conformance, this README, canon-md byte-equality test.

## Relationship to the runbook directory

The runbook directory at `docs/runbooks/` is the operational complement. Where this directory answers "what gaps should we close next?", the runbook directory answers "this incident is happening right now; what do I do?".

- **Audit identifies gaps**: a self-audit run might flag "no runbook for medium-tier kill-switch trip" as a finding.
- **Runbooks operationalize known incidents**: a runbook for a kill-switch trip documents symptoms, atom kinds that fire, recovery steps, prevention follow-ups.
- **Conformance specs assert the substrate contract**: `test/conformance/shared/*-spec.ts` codifies what every BYO adapter implementation must satisfy.

These three surfaces compose. Audit -> conformance spec -> reference impl -> runbook for the incident class. A v<N> doc that proposes a new substrate seam typically threads through all three.

## Versus the legacy production-readiness audit

The older `docs/audits/2026-04-26-production-readiness-audit.md` doc lives in the sibling `docs/audits/` directory (note the plural). That was a one-shot production-readiness review whose entries were closed in PRs #197 through #205. The self-audit series in `docs/audit/` (singular) is the forward-looking iterative replacement. The two directory names differ by a single character on purpose: the legacy doc is the snapshot, the v<N> series is the rhythm.

## Driver

The self-audit driver is `scripts/self-audit-tick.mjs`. The LoopRunner cadence is `runSelfAuditCadence` in `src/runtime/loop/`. The driver writes its prompt + reasoning trace as `self-audit-tick` atoms; the synthesized backlog lands here as the human-readable doc.
