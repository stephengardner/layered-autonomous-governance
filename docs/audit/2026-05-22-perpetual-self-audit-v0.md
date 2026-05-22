# Perpetual Self-Audit V0 (Post-Hoc Projection)

Date: 2026-05-22. Author: v0 perpetual self-audit projection (post-hoc, written 2026-05-22 after v1 landing).

## Context

V0 of the perpetual self-audit was originally the *output* of `scripts/self-audit-tick.mjs` (shipped via PR #435, the self-audit driver), not a checked-in markdown. Each tick of that driver fires the substrate-deep pipeline against a meta-prompt that asks "what is missing for indie + org users, what to test, what to improve" and produces ONE PR shipping ONE substrate gap. Between 2026-05-21 and 2026-05-22 the driver produced a 7-PR backlog that landed; the v1 doc (`docs/audit/2026-05-22-perpetual-self-audit-v1.md`) then picked up from that landed state and identified the next 10 gaps.

This v0 file is a POST-HOC projection over the already-merged PRs. The original v0 atom set has aged out of the loop driver's runtime cache, so the source of truth for what shipped is the merge commits themselves (#434, #436, #438 from the same cluster window plus the 7-PR named backlog #437, #439, #440, #441, #442, #443, #444). The reason for the projection is that the runbook README and three named runbooks reference `docs/audit/2026-05-22-perpetual-self-audit-v0.md` as their motivating audit doc, and those five citations were stranded when the v0 markdown never landed:

- [docs/runbooks/README.md:11](../runbooks/README.md) (finding P1 motivates the runbook directory)
- [docs/runbooks/README.md:38](../runbooks/README.md) (related section, finding P1 backlink)
- [docs/runbooks/reaper-not-running.md:39](../runbooks/reaper-not-running.md) (finding P1)
- [docs/runbooks/bot-token-expired.md:46](../runbooks/bot-token-expired.md) (finding P2)
- [docs/runbooks/cr-silent-skip.md:44](../runbooks/cr-silent-skip.md) (finding G1)

This doc resolves those references and establishes the v0 backlog form alongside v1's. Future audits supersede; the v1 doc is the canonical forward-looking queue.

## Note on derivation

Every entry below cites the merge commit + PR number that shipped it. Acceptance language is drawn from the PR body and the canonical files the PR touched. No new requirements are introduced; this is documentation of what already shipped, not a fresh plan.

## V0 Backlog (as-shipped)

### PR-1 (I1): Onboarding signpost for `--stub` planning loop

**Scope:** S
**Audit dimension:** indie-floor (primary) + operator-readiness (secondary)
**What:** docs/getting-started.md did not signpost the `--stub` path as the next-step after the quickstart example. A new contributor finishes quickstart, then hits a wall because the next thing the docs described (lag-run-loop, daemons) all assume an authenticated claude CLI session. The `--stub` flag has existed since phase 55b but the operator-facing docs never named it as the zero-API-key onramp.
**Why:** First-run friction is the indie-floor north-star. A solo developer reaching for LAG without claude CLI access should still get a 5-minute path to a real planning loop.
**Acceptance:** docs/getting-started.md gains a new H2 between Install/bootstrap and Daemons sections that names the exact invocation, explains what stub mode swaps, and points the operator toward the claude CLI install when they want a real plan. Single-file documentation patch; zero code change.
**Shipped as:** PR #437 (commit `afb97931`, "docs(getting-started): signpost --stub path for 5-min CTO loop").

### PR-2 (P1): Runbook directory foundation

**Scope:** M
**Audit dimension:** operator-readiness (primary) + governance-enforcement (secondary)
**What:** docs/runbooks/ did not exist. The substrate emits atoms; without runbooks, the operator pattern-matches from the Console which does not scale to an on-call rotation. Ship V0 with 3 of the 8-10 most-common 3am incidents (reaper-not-running, bot-token-expired, cr-silent-skip) plus the README.md index documenting the runbook shape contract (symptoms, atom kinds, recovery, prevention follow-up, related).
**Why:** Atom kinds are not self-documenting; an operator paged at 3am needs a deterministic recovery sequence. The runbook directory is the bridge between substrate emissions and operator action.
**Acceptance:** docs/runbooks/ exists with README.md, reaper-not-running.md, bot-token-expired.md, cr-silent-skip.md. Each runbook follows the shape contract. Index documents the coverage gap (5-7 more runbooks to ship). No em-dashes anywhere (CI gate). Every runbook names the atom kinds that fire so the operator can verify incident state from the AtomStore without trusting the runbook prose.
**Shipped as:** PR #439 (commit `39bba6e8`, "docs(runbooks): foundation with 3 most-common 3am incidents").

### PR-3 (PR-C): `expectedRevision` CAS on `AtomStore.update()`

**Scope:** L
**Audit dimension:** governance-enforcement (primary) + future-proofing (secondary)
**What:** Add an optional `revision` counter on `Atom` and an optional `expectedRevision` on `AtomPatch` so callers can opt into compare-and-swap on update. `revision` starts unset on `put` (treated as 0 for back-compat with atoms written before the field existed), increments by exactly 1 on every successful update, and a non-matching `expectedRevision` rejects with the same `ConflictError` shape that put-on-duplicate raises. Memory and file adapters both implement the guard; bridge passes through. Conformance spec pins the contract so any future adapter inherits the substrate guarantee.
**Why:** Lost-update is the canonical race at the 50-actor org-ceiling. The substrate had no primitive to express "I read this atom at revision N; write back only if it is still N." Without CAS, every read-modify-write call site in `src/runtime/` was best-effort within a single process and racing across replicas. This PR ships the primitive; v1 PR-1 plumbs it through 14 production callers.
**Acceptance:** `AtomStore.update(patch)` accepts an optional `expectedRevision`; the memory and file adapters both reject with `ConflictError` when the stored revision diverges from the supplied one. `batchUpdate` rejects `expectedRevision` at the boundary because CAS is undefined over a batch (one expectedRevision value cannot meaningfully gate N writes). Conformance spec gains regression cases.
**Shipped as:** PR #440 (commit `6d40561e`, "feat(substrate): expectedRevision CAS on AtomStore.update()").

### PR-4 (P1 cont.): 4 more named-incident runbooks

**Scope:** M
**Audit dimension:** operator-readiness (primary)
**What:** Extend the runbook foundation (PR #439) with 4 additional 3am incident playbooks: sub-agent-stalled (consumes the PR #434 + #436 detector + watcher), worktree-cleanup-failed (consumes the PR #438 planner), pipeline-stage-timeout, and dispatch-failed. Each follows the established shape: Symptoms, Atom kinds that fire, Recovery steps, Prevention follow-up, Related.
**Why:** PR #439 left 5-7 runbooks queued as a coverage gap; this PR closes 4 of them. Coverage delta: 3 to 7 runbooks. Remaining 1-3 gap (atom-store ENOSPC, tunnel disconnected, PR-landing actor stuck) queued for follow-up (now picked up by v1 PR-7).
**Acceptance:** docs/runbooks/{sub-agent-stalled,worktree-cleanup-failed,pipeline-stage-timeout,dispatch-failed}.md ship. README index updated; coverage gap section reflects the new count. No em-dashes. Inline note replaces the (then-broken) reference to v0 audit doc.
**Shipped as:** PR #441 (commit `0144293a`, "docs(runbooks): 4 more named incidents").

### PR-5 (PR-C cont.): SQLite `AtomStore` reference adapter (strict cross-process CAS)

**Scope:** L
**Audit dimension:** org-ceiling (primary) + future-proofing (secondary)
**What:** Reference adapter at `examples/atom-stores/sqlite/` that implements the AtomStore interface against `better-sqlite3`. Picks SQLite's IMMEDIATE transactions plus a single-statement UPDATE-with-revision guard to give STRICT cross-process compare-and-swap, closing the TOCTOU gap the file adapter documents as best-effort.
**Why:** The file adapter is correct within a process and best-effort across processes; a deployment running multiple LoopRunner replicas (or any cross-process consumer) needs a stronger guarantee. SQLite is the smallest dependency that gives serializable transactions with cooperative wait-then-succeed semantics. Closes the strict-CAS hole the file adapter explicitly documents.
**Acceptance:** `SqliteAtomStore` implements `AtomStore` against `better-sqlite3`. Schema is one row per atom with the full Atom serialized in a `data` JSON column and filter-load-bearing fields extracted into typed columns + indexes. WAL mode + `synchronous=NORMAL` + `busy_timeout` give cooperative writers wait-then-succeed semantics instead of immediate SQLITE_BUSY. Conformance tests pass against the same 27+ case contract memory + file pass. Concurrent-CAS regression test pins the strict guarantee.
**Shipped as:** PR #442 (commit `e87ca3fd`, "feat(examples): SQLite AtomStore adapter").

### PR-6 (P2 + P3): Bot-identity health endpoint + Console System Health page

**Scope:** M
**Audit dimension:** operator-readiness (primary) + indie-floor (secondary)
**What:** Add `POST /api/system-health.bot-identities` returning per-role GitHub App credential health. For each of lag-ceo, lag-cto, lag-pr-landing, lag-actors, mint a one-shot installation token to verify the credentials still authenticate; surface fresh / stale / network-error / not-provisioned status with token expiry age. Console page at `/system-health` renders the result as a row-per-bot table with status pill, login, installation id, and time-until-token-expiry. Mobile-first layout; skeleton loading state; 30s auto-refetch plus manual Refresh button. Sidebar entry under operator-readiness cluster.
**Why:** Bot-token expiry is the failure mode the operator has the least visibility into; the App token rotates every hour, the PAT every 90 days, and an expired credential surfaces as "PR opened but no comment" or "merge silently rejected." Surfacing the health proactively turns a silent break into a visible row.
**Acceptance:** the endpoint mints one-shot tokens per provisioned role and returns health status. Console page renders desktop + mobile cleanly; the minted token never leaks into the DOM (defense-in-depth e2e check). 15 unit tests cover the server probe across fresh / stale on 4xx / network-error on 5xx / not-provisioned / parser failures / loader exceptions.
**Shipped as:** PR #443 (commit `76f8c9ed`, "feat(console): bot-identity health endpoint + system health page").

### PR-7 (hygiene): Bump System Health test RSA key to 2048-bit

**Scope:** S
**Audit dimension:** governance-enforcement (primary)
**What:** CodeQL `js/insufficient-key-size` flagged the 1024-bit `generateKeyPairSync` call landed in PR #443. The key is ephemeral and never authenticates against a live endpoint (stubbed fetch captures the request before it leaves the process), so this is a hygiene fix rather than a security one. 2048-bit costs ~50ms per file load.
**Why:** Required status checks block merge on CodeQL findings even when the operator-side risk is zero. Cheap insurance against the rule failing CI again.
**Acceptance:** the test key generates at 2048-bit; CodeQL passes.
**Shipped as:** PR #444 (commit `1cafb098`, "fix(console): bump system-health test RSA key to 2048-bit").

## Adjacent ships from the same cluster window

These three PRs landed in the same self-audit-cluster window but are separate work (not part of the named v0 backlog). They consume or pair with the v0 backlog entries:

- **PR #434** (commit `a57dc6d6`, "feat(substrate): sub-agent worktree stall detector"): pure classifier the parent loop calls once per tick on each in-flight sub-agent worktree to decide whether to intervene. Pure mechanism, no I/O. Consumed by PR #436 watcher and referenced by the sub-agent-stalled runbook (PR #441).
- **PR #436** (commit `b352bd81`, "feat(substrate): sub-agent stall watcher"): the I/O-bearing scanner + driver script consuming the PR #434 detector. Walks `.worktrees/`, spawns git per worktree, returns a deterministic verdict.
- **PR #438** (commit `2e810a14`, "feat(substrate): pure planner for worktree cleanup decisions"): sibling to PR #436's scanner; classifies each worktree as 'remove' or 'keep' with rules biased toward keep so a false-positive never deletes operator work. Referenced by the worktree-cleanup-failed runbook (PR #441).

## Driver itself

- **PR #435** (commit `87f18da6`, "feat(substrate): perpetual self-audit tick driver"): the driver this entire v0 backlog is named for. Ships `scripts/self-audit-tick.mjs` + `scripts/lib/self-audit-prompt.mjs` plus the 9-test prompt contract. Activation is operator-wired cron in v0; v1 PR-10 picks up wiring it into LoopRunner as a substrate rhythm.

## Closing note

This is a projection, not the original v0 atom set. The runtime cache of audit-tick outputs has aged out so the exact prompt the driver fired and the atoms it produced are no longer recoverable. What IS recoverable is the merged code in main: every PR cited above is in `git log` and the canonical commit hash + PR title + body documents what shipped. If a future audit needs the original v0 atom shape, the recovery path is to re-fire `scripts/self-audit-tick.mjs` against the current main and observe what the prompt-builder produces; the v1 doc plus this v0 projection together describe what the resulting backlog would look like.

The five broken runbook references that motivated this doc are now resolved (this file exists). Future audits supersede; v1 (`docs/audit/2026-05-22-perpetual-self-audit-v1.md`) is the live forward-looking queue.

## References

- v1 audit doc (forward-looking queue): `docs/audit/2026-05-22-perpetual-self-audit-v1.md`
- Self-audit driver: PR #435 (`scripts/self-audit-tick.mjs`, `scripts/lib/self-audit-prompt.mjs`)
- v0 backlog ships: PRs #437, #439, #440, #441, #442, #443, #444
- Adjacent cluster ships: PRs #434, #436, #438
- Canon: `CLAUDE.md` (and the runtime canon via `node scripts/apply-canon.mjs`)
- Runbook directory: `docs/runbooks/`
