# Perpetual Self-Audit V1

Date: 2026-05-22. Author: lag-ceo perpetual self-audit agent v1.

## Context

V0 of the perpetual self-audit (the agent driver shipped by PR #435 with `scripts/self-audit-tick.mjs` + `scripts/lib/self-audit-prompt.mjs`) produced a 6-PR backlog over the prior 8 hours. All of it landed:

- PR #437: `--stub` onboarding signpost in getting-started.md
- PR #439: foundational runbook directory + 3 most-common 3am incidents
- PR #440: `expectedRevision` CAS on `AtomStore.update()` (substrate guarantee)
- PR #441: 4 more named-incident runbooks (sub-agent-stalled, worktree-cleanup, pipeline-timeout, dispatch-failed)
- PR #442: SQLite `AtomStore` reference adapter with strict cross-process CAS
- PR #443: Console System Health page + bot-identity health endpoint
- PR #444: regression bump on the System Health test RSA key

Adjacent ships from the same self-audit-cluster window: PR #434 (sub-agent stall detector), PR #436 (sub-agent stall watcher consuming #434), and PR #438 (worktree-cleanup planner). PR #435 itself shipped the self-audit driver this V1 sits downstream of.

V1 picks up where V0's backlog ended. Same 6 audit dimensions, same shape, but the gaps below only became visible after V0's hardening landed (because V0 reordered the constraint set) OR were missed because V0 prioritized differently. None of the entries below re-discover a V0 finding; each cites the artifact V0 produced and articulates the next-leverage move.

## Note on the v0 markdown reference

PRs #439, #440, #441, and #443 cite `docs/audit/2026-05-22-perpetual-self-audit-v0.md` as their motivating audit doc but that file does not exist in the repo. V0 was the OUTPUT of the self-audit driver (a 6-PR backlog), not a checked-in markdown. The runbook README ([docs/runbooks/README.md:11](../runbooks/README.md), [docs/runbooks/README.md:38](../runbooks/README.md)) and the worktree-cleanup-failed runbook ([docs/runbooks/worktree-cleanup-failed.md:43](../runbooks/worktree-cleanup-failed.md)) carry broken-on-disk references. This is itself a finding: runbook citations to a sibling audit doc must resolve, or the operator pattern-matching from runbook to audit to code breaks. PR-1 below establishes the audit-doc convention; v1 lives at the correct path; v0's projection can be back-filled from the PR metadata that already references it.

## V1 Backlog (prioritized)

### PR-1: Plumb `expectedRevision` CAS through runtime read-modify-write call sites

**Scope:** L  
**Audit dimension:** governance-enforcement (primary) + future-proofing (secondary)  
**What:** PR #440 added the `expectedRevision` field to `AtomPatch` and implemented the CAS guard in the memory + file adapters, with the SQLite adapter (PR #442) giving strict cross-process CAS. Today ZERO production callers under `src/runtime/` use the field. Threading `expectedRevision` through every read-modify-write path that mutates `plan_state` / `question_state` / `pipeline_state` / `taint` / `signals` / `confidence` closes the lost-update window the substrate now provides a primitive for.  
**Why:** V0 stopped at "substrate provides the guarantee." That leaves the 14 call sites in `src/runtime/plans/`, `src/runtime/questions/`, `src/runtime/loop/`, `src/runtime/planning-pipeline/`, and `src/runtime/actors/` racing each other at 50-actor org-ceiling load. The pipeline-reaper has a documented TOCTOU re-fetch at `src/runtime/plans/pipeline-reaper.ts:624` but it is best-effort within a single process; a second LoopRunner replica observing the same atom will both pass the re-fetch and race the rename. CAS is the substrate fix; threading it is the substrate adoption.  
**Acceptance:** every `host.atoms.update(...)` call site under `src/runtime/` either (a) passes `expectedRevision` derived from the atom the caller read, with a documented retry-on-`ConflictError` policy, or (b) carries a JSDoc comment explaining why CAS is intentionally skipped (e.g. confidence-decay sweep where lost-update is acceptable noise). Regression test: a vitest case for each plan-state transition that races two writers and asserts exactly one succeeds + the loser observes `ConflictError`.  
**Call sites:** `src/runtime/questions/index.ts:211`, `src/runtime/questions/index.ts:261`, `src/runtime/plans/pipeline-reaper.ts:316`, `src/runtime/plans/pipeline-reaper.ts:382`, `src/runtime/plans/state.ts:77`, `src/runtime/plans/pr-orphan-reconcile.ts:459`, `src/runtime/plans/pr-orphan-reconcile.ts:469`, `src/runtime/planning-pipeline/auto-approve.ts:681`, `src/runtime/loop/claim-reaper.ts:348`, `src/runtime/loop/claim-reaper.ts:615`, `src/runtime/loop/claim-reaper.ts:683`, `src/runtime/loop/claim-reaper.ts:819`, `src/runtime/loop/runner.ts:1011`, `src/runtime/loop/runner.ts:1055`.

### PR-2: Close the adapter-supplied commitSha verification gap

**Scope:** S  
**Audit dimension:** governance-enforcement (primary) + indie-floor (secondary)  
**What:** `AgenticCodeAuthorExecutor` reads `agentResult.artifacts.commitSha` and proceeds directly to `createPrViaGhClient` without verifying the commit exists in the workspace. The JSDoc at `src/runtime/actor-message/agentic-code-author-executor.ts:40-43` honestly admits "a misbehaving adapter could fabricate a SHA. This seam currently ships without a verification step; a future hardening pass enforces commit-existence verification before PR creation." Three audits in a row (the production-readiness audit at `docs/audits/2026-04-26-production-readiness-audit.md` finding #2, the V0 implicit context, and this V1) have flagged this. Ship the verification.  
**Why:** V0's backlog did not pick this up because V0 focused on substrate primitives (CAS, runbooks, health) rather than threat-model gaps. This is the canonical "promise documented, not yet kept" case. An external operator wiring a third-party `AgentLoopAdapter` (the indie-floor onboarding path the `--stub` signpost from PR #437 leads them toward) hits this gap first.  
**Acceptance:** after `agentResult.kind === 'completed'`, the executor runs `git -C <workspaceRoot> cat-file -e <commitSha>` (or equivalent through a new `WorkspaceProvider.verifyCommitExists` seam) and refuses with `agentic/sha-verification-failed` if absent. Regression test: stub adapter returns a fabricated SHA and the executor short-circuits before any `GhClient.createPr` call.

### PR-3: Substrate-side `dev-pr-fix-resolve-outdated-threads-after-fix-push` enforcement

**Scope:** M  
**Audit dimension:** governance-enforcement (primary) + operator-readiness (secondary)  
**What:** Canon directive `dev-pr-fix-resolve-outdated-threads-after-fix-push` says "PR-authoring agents (pr-fix-actor, code-author, run-pr-fix.mjs, run-pr-landing.mjs, and any direct agent fix-push flow) MUST run `node scripts/resolve-outdated-threads.mjs <pr>` after each fix-push." Today this is a per-flow agent discipline, not a substrate enforcement. PR-authoring actors in `src/runtime/actors/pr-fix/` and the dispatch paths in `src/runtime/actor-message/agentic-code-author-executor.ts` and `code-author-executor-default.ts` do not call the resolution script. Wire it into the executor's post-PR-creation chain so the discipline becomes a mechanism, not a memory check.  
**Why:** V0 added runbooks for incidents; it did not turn agent disciplines into substrate enforcement. The canon says "this should never happen again" (operator quote 2026-04-27 per the atom) but the mechanism is missing. Two PRs in the last 90 days stalled BLOCKED purely on outdated review threads; the script exists but no actor invokes it.  
**Acceptance:** every PR-authoring actor's post-PR or post-fix-push flow ends with a call to a new `resolveOutdatedThreadsAfterPush(prNumber)` helper that wraps `scripts/resolve-outdated-threads.mjs`. The helper writes an `operator-action` atom recording how many threads were resolved (or "none" when there were no outdated threads). E2E regression: a test exercises a fix-push that touches lines an existing thread is anchored to, then asserts the thread is in `RESOLVED` state at end-of-test.

### PR-4: Indie-to-SQLite migration tool

**Scope:** M  
**Audit dimension:** org-ceiling (primary) + indie-floor (secondary)  
**What:** The SQLite `AtomStore` adapter (PR #442) ships, but a solo developer who outgrew the file adapter (the org-ceiling threshold cited in the README: "atom count grows past the file adapter's comfortable range") has no migration path. Ship `examples/atom-stores/sqlite/scripts/import-from-file.mjs` that reads `<rootDir>/atoms/*.json` and bulk-puts into a SQLite `.db` while preserving revision counters, with a `--dry-run` preview + `--verify` post-import equality check.  
**Why:** V0 shipped the destination but not the journey. The canon directive `dev-indie-floor-org-ceiling` says both ends are first-class; without a migration tool, the SQLite adapter is only useful to a fresh deployment, not a graduating one. The two-end constraint demands the bridge.  
**Acceptance:** running the migration tool on a real `.lag/atoms/` snapshot produces a SQLite DB where every atom round-trips through `SqliteAtomStore.get()` with the exact same JSON shape (modulo the new revision field). The `--verify` flag asserts every source-file atom is present + content-equal in the destination. Regression test: 100 atoms (one of every type) round-trip via import to 100 atoms readable + signals/metadata preserved.

### PR-5: Substrate `commitSha` verification seam on `WorkspaceProvider`

**Scope:** S  
**Audit dimension:** future-proofing (primary) + governance-enforcement (secondary)  
**What:** Companion to PR-2: rather than embed `git cat-file` directly in the agentic-code-author executor, add `verifyCommitExists(commitSha): Promise<boolean>` to the `WorkspaceProvider` substrate interface so non-git workspace providers (a future Sandstorm/Codespaces/IDE-as-adapter) implement the check in their native semantics. The executor (PR-2) calls this seam; the git-worktree provider in `examples/workspace-providers/` provides the canonical implementation.  
**Why:** PR-2 closes the hole; this PR keeps the substrate boundary clean per the canon directive `dev-framework-code-mechanism-only`. Embedding `git cat-file` in executor code is fine for indie-floor but the org-ceiling consumer wiring a different workspace primitive has to either fork the executor or accept the git dependency. The seam puts the choice in the caller's hands. Splitting this from PR-2 makes the seam land first (mechanism), then the executor adopts it (consumer).  
**Acceptance:** `WorkspaceProvider` declares `verifyCommitExists(commitSha): Promise<boolean>` (optional for back-compat); a git-worktree adapter under `examples/workspace-providers/` implements it via `git cat-file -e`; an in-memory test provider implements it via a Set; PR-2 uses the seam through the host interface.

### PR-6: Provisioning module coverage floor (currently 1-30% range)

**Scope:** L  
**Audit dimension:** test-coverage (primary) + indie-floor (secondary)  
**What:** The `src/actors/provisioning/` module (the operator-facing GitHub-App-bootstrap path a new operator hits at first-run) has `provisioner.ts` at 1.12% lines, `risk-assessor.ts` at 30%, `role-loader.ts` at 8%, `credentials-store.ts` at 4.68%, `manifest-url.ts` at 4.76%, `callback-server.ts` and `slack-server.ts` < 5%. There are zero tests under `test/actors/provisioning/`. The `--stub` onboarding signpost (PR #437) directs first-time operators THROUGH this code path; the path is essentially untested.  
**Why:** V0 prioritized substrate primitives over actor coverage. The production-readiness audit named this as a critical finding 27 days ago and the gap is unchanged. A regression here breaks first-run for every new operator and the regression test does not exist to catch it.  
**Acceptance:** every file under `src/actors/provisioning/` reaches >= 60% line coverage. Test approach: stub the GitHub API + the filesystem at the `gh.app.*` and `node:fs/promises` seams; exercise success + 401 + 403 + 5xx + timeout paths for each `provisioner.ts` step. Regression test for the cred-store should round-trip a freshly-provisioned App through `credentials-store.put()` and observe a subsequent `gh-as.mjs <role>` token mint.

### PR-7: Console System Health expansion: claim-reaper + tunnel + atom-store free space

**Scope:** M  
**Audit dimension:** operator-readiness (primary) + indie-floor (secondary)  
**What:** PR #443 shipped the Console System Health page with ONE probe family (bot-identity health). The page is named broadly ("future health probes ... claim-reaper cadence, atom-store free space, tunnel reachability ... will land as additional rows or sections") at `apps/console/src/features/system-health/SystemHealthView.tsx:22-25`. The 3 named-but-not-shipped probes correspond directly to 3 named runbooks (reaper-not-running, atom-store ENOSPC, tunnel disconnected) where the operator currently has to read tea leaves out of activity-feed silence. Ship the missing 3 probes.  
**Why:** V0 built the housing; V1 fills the rooms. The runbook README's "Coverage gap" section ([docs/runbooks/README.md:25-27](../runbooks/README.md)) names atom-store ENOSPC and tunnel disconnected as the remaining 1-3 gaps; the system-health page is the operator-visible counterpart. Ship together so the runbook page-fault has an immediate observable.  
**Acceptance:** the System Health page renders three new probe rows alongside bot-identity: (1) `claim-reaper-cadence` becomes green when at least one `claim-reaper-sweep-completed` atom appears in the last 2x configured tick interval, yellow when between 2x and 5x, red beyond; (2) `tunnel-reachability` becomes green when `curl http://127.0.0.1:<metrics-port>/quicktunnel` resolves a hostname, yellow on network-error, red on no-tunnel; (3) `atom-store-free-space` becomes green when `<root>/atoms/` partition has >5% free, yellow at 1-5%, red <1%. Each probe runs server-side (Console backend), and each row has a deep-link to the corresponding runbook.

### PR-8: Cross-process CAS guarantee documented in the substrate interface contract

**Scope:** S  
**Audit dimension:** future-proofing (primary) + org-ceiling (secondary)  
**What:** The `AtomStore` interface at `src/substrate/interface.ts` declares `update()` and `batchUpdate()` but says NOTHING about cross-process CAS semantics. The file adapter documents its best-effort posture inline at `src/adapters/file/atom-store.ts:120-126`; the SQLite adapter README claims strict guarantee. An adapter author writing a new backend (Postgres, Redis, DynamoDB) has no contract to satisfy. Add a contract line: "Adapters MAY implement strict cross-process CAS on `update(expectedRevision)`; consumers MUST NOT assume strict CAS unless the adapter's documentation declares it." Plus add `AtomStore.capabilities?.hasStrictCrossProcessCas: boolean` so callers can detect at runtime.  
**Why:** V0 shipped two adapters with different CAS guarantees and no surfaced contract distinction. PR-1 wants to thread `expectedRevision` through runtime; without a contract on what the guarantee is, runtime callers have to lookup the specific adapter, which is a substrate boundary violation. Capability-bit makes the choice explicit.  
**Acceptance:** the interface declares the optional capability; memory + file adapters declare `hasStrictCrossProcessCas: false`; SQLite declares `true`; conformance spec (`test/conformance/shared/atoms-spec.ts`) gains a case that respects the bit. PR-1's runtime threading reads the bit to decide whether to escalate on `ConflictError` (strict adapters: retry once; best-effort: warn-and-proceed).

### PR-9: Medium-tier kill-switch (canon D13 reservation)

**Scope:** L  
**Audit dimension:** governance-enforcement (primary) + future-proofing (secondary)  
**What:** The kill-switch at `src/substrate/kill-switch/index.ts` ships SOFT tier only (filesystem sentinel + parent AbortSignal). Canon directives `inv-kill-switch-first`, `dec-kill-switch-design-first`, `pol-cto-no-merge`, and `pol-pr-landing-no-auto-merge` all REFERENCE the medium tier ("medium-tier kill switch ships (D13)") as an unfulfilled gate. Today every auto-merge / auto-decision policy is held back behind a tier that doesn't exist. Ship the medium tier: an out-of-process kill-switch daemon that can interrupt an in-flight subprocess (the soft tier can't because the AbortSignal is in-process).  
**Why:** V0 was scoped to one-PR-per-tick and the medium tier is too big for one tick. V1 puts it on the backlog explicitly so the four canon directives blocked on D13 have a tracked unblock path. Until medium-tier exists, the operator-gate on every code-author merge stays mandatory and the "indie developer goes home for the night" promise of LAG's autonomy story is bottlenecked.  
**Acceptance:** a new `src/substrate/kill-switch/medium-tier.ts` declares the `MediumTierKillSwitch` interface (`arm(pid)`, `disarm(pid)`, `tripAll()`); a reference implementation under `examples/kill-switches/process-supervisor/` uses a POSIX process group / Windows job-object to kill children. The runActor loop in `src/runtime/actors/run-actor.ts` opt-in arms its child subprocess against the medium-tier when configured. Four canon directives ship companion atoms loosening their gate-language from "until D13 ships" to "medium-tier opt-in available."

### PR-10: Self-audit cadence wiring into LoopRunner

**Scope:** S  
**Audit dimension:** future-proofing (primary) + operator-readiness (secondary)  
**What:** `scripts/self-audit-tick.mjs` (PR #435) is a one-shot driver; the JSDoc says "operators wire to manual cron / LoopRunner pass extension follow-up" but the follow-up is not built. Add a LoopRunner pass `runSelfAuditTick` that fires the self-audit on a canon-policy-configured cadence with default OFF (per the indie-floor canon: a solo developer should not surprise-spend at midnight). Org-ceiling deployments flip the canon atom `pol-self-audit-cadence` to enable the tick on the loop.  
**Why:** V0 made the audit a *capability*, not a *rhythm*. The dev-self-audit-perpetual-cto-rhythm canon ("Self-audit is a regular CTO-driven rhythm, not a one-off") demands the rhythm. Without the LoopRunner pass, the rhythm is operator-discipline (a cron line on the operator's box), which is not a substrate guarantee.  
**Acceptance:** `src/runtime/loop/runner.ts` gains `runSelfAuditPass` keyed off a new `runSelfAuditPass: boolean` LoopOption + a `pol-self-audit-cadence` policy atom carrying `intervalMs` + `enabled`. Default off; canon-edit on. Regression test: a vitest case spins a LoopRunner with `runSelfAuditPass: true` + cadence policy = 100ms + a mocked self-audit-tick adapter, and asserts the tick fires on the expected schedule.

## Discipline notes

- **One PR per tick is V1 too**: the self-audit driver's prompt enforces "one PR per self-audit tick. The next tick picks up the next gap." This V1 backlog is the *ordered queue*; the next driver tick picks PR-1 (highest leverage = governance + future-proofing + the substrate primitive shipped two PRs ago has no consumer yet).
- **Cross-cutting concerns surfaced but not promoted to standalone PRs**:
  - The medium-tier kill-switch (PR-9) unblocks 4 canon atoms; if a future ticktrap pushes for more aggressive autonomy, this PR's priority bumps automatically.
  - Coverage floors below the 60% line for `src/actors/provisioning/`, `src/cli/`, `src/daemon/invoke-claude.ts` are all valid gaps; PR-6 picks the provisioning subset because it sits on the first-run path. The `src/cli/` + `src/daemon/` work is queued for a follow-up coverage-only V2 backlog.
  - Tunnel reachability and atom-store free-space probes (PR-7) are operator-readiness gaps; building them inside the System Health page is the right home (rather than a new view) per the page's stated forward-looking design.
- **What V1 deliberately does NOT pick up**:
  - LangGraph integration (mentioned in operator memory `project_console_app_focus`) is still next-workstream territory per operator, not a substrate gap.
  - Apex-tunable trade-off dials (`dev-future-tunable-dials`) are forbidden as speculative dial infrastructure per canon; build them only at the second use case.
  - Metrics/observability beyond `metric()` primitive (no Prometheus, OTLP) is out of indie-floor scope and the canon directive `dev-simple-surface-deep-architecture` resists adding surface for monitoring most indie operators won't need.

## Summary

**Top 3 priorities (next driver-tick picks PR-1):**

1. **PR-1 (L, governance + future-proofing)**: Thread `expectedRevision` CAS through ~14 production read-modify-write sites in `src/runtime/`. V0 shipped the primitive (PR #440); ZERO production callers consume it. Highest leverage by far because every other org-ceiling concurrency story rides on this.
2. **PR-2 (S, governance + indie-floor)**: Close the adapter-supplied `commitSha` verification gap in `AgenticCodeAuthorExecutor`. JSDoc already admits "future hardening pass" but the seam ships open. Three audits in a row have flagged it.
3. **PR-3 (M, governance + operator-readiness)**: Substrate-side enforcement of `dev-pr-fix-resolve-outdated-threads-after-fix-push`. Canon says "this should never happen again"; the script exists but no actor invokes it.

**Estimated total scope:** 10 PRs = 4 S + 3 M + 3 L.

**Next audit cadence trigger:** after PR-1 + PR-2 + PR-3 ship (the governance-enforcement leg). The medium-tier kill-switch (PR-9, L) is the natural V2 trigger because it unblocks 4 dormant canon directives and is too large for a single self-audit tick. The remaining 6 PRs (PR-4 through PR-8, PR-10) can land in any order; V1 backlog stays open as the queue until V2 reorders.

## References

- V0 driver itself (NOT an adjacent ship; this is the driver V0 is named for): PR #435 (`scripts/self-audit-tick.mjs` + `scripts/lib/self-audit-prompt.mjs`)
- V0 backlog ships (the 6-PR queue the driver produced): PRs #437, #439, #440, #441, #442, #443, #444
- Adjacent V0-cluster ships (same window, separate work): PRs #434 (sub-agent stall detector), #436 (sub-agent stall watcher consuming #434), and #438 (worktree-cleanup planner)
- Prior audit (production-readiness): `docs/audits/2026-04-26-production-readiness-audit.md`
- Canon: `CLAUDE.md` (and the runtime canon via `node scripts/apply-canon.mjs`)
