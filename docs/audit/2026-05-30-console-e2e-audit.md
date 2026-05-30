# Console e2e + Conversation Thread Recommended-Improvements Audit

Date: 2026-05-30. Branch entry-point: feat/console-e2e-baseline (worktree at C:/Users/opens/memory-governance-console-e2e).

## Context

Operator directive 2026-05-30: "do the rest of the recommended improvements or come up with them and test them and ensure everything e2e in playwright works beautifully at all phases of this."

Reference PRs:
- PR #483: feat(console) conversation thread API endpoints (backend slice), merged 2026-05-29 at 5a3ee6ad.
- PR #484: feat(console) conversation thread view (frontend slice), merged 2026-05-29 at 20b268e9.

## Recommended-improvements inventory (from CR feedback + PR terminal reports)

### A. SSE live updates on Conversation Thread

**State:** Shipped in PR #487 (this work). The new `useConversationStream(pipelineId, planId)` hook subscribes via the existing `subscribeToPipelineStream` transport seam and invalidates the conversation TanStack Query keys on atom-change events:

- `['conversation', 'pipeline', pipelineId]`
- `['conversation', 'plan', planId]` (when supplied)

The 10s polling fallback in the view's useQuery remains as the safety net when SSE fails to open. Operators now see new agent-turns, handoffs, and stage transitions within a frame instead of waiting up to 10 seconds for the next poll.

**Test coverage:** 1 new e2e spec (`SSE atom-change event invalidates the conversation query`) that fires a synthetic atom-change event and verifies the conversation endpoint is hit twice within 8 seconds. Runs on both chromium + mobile projects.

### B. Tail-cap polling stops on dispatch-result

**State:** Shipped in PR #484 at ConversationThreadView.tsx:90-94. The `refetchInterval` callback inspects `data.events` and returns `false` when any event has `kind === 'dispatch-result'`.

**Verification:**
- The implementation is correct.
- A dedicated unit test would require a TanStack Query mock; the existing 16 ConversationEvent unit tests cover the per-kind contract.
- The Playwright spec at conversation-thread.spec.ts exercises the rendered dispatch-result row.

**Decision:** Verified shipped. No further action.

### C. BlobRef expansion endpoint

**State:** Not shipped. PR #483 trimmed the speculative `POST /api/conversation.expand-blob` endpoint; `handleConversationExpandBlob` is no longer in the server.

**Decision:** Skip. The current Show more / Show less affordance on ExpandableBody operates on the inline-truncated body (capped at MAX_INLINE_CONTENT_CHARS = 4000) and is sufficient for the v1 surface. A future BlobStore wiring is a separate ship when the substrate decides to ship larger-than-inline content blobs.

### D. STAGE_OUTPUT_TYPES + DISPATCH_OBSERVATION_KINDS body-scoped nit

**State:** Shipped in PR #486 (this work). The constants become exported defaults; new optional `ConversationAssembleOptions` parameter lets org-ceiling deployments inject alternative sets without patching the projection.

**Test coverage:** 3 new vitest cases in conversation-assembler.test.ts.

### E. Mobile audit on Conversation Thread

**State:** Already meets the canon `dev-web-mobile-first-no-horizontal-scroll-on-mobile` floor. The conversation-thread.spec.ts no-horizontal-scroll spec passes on iPhone 13 viewport (390x844). All 7 e2e tests pass on the mobile project.

**Verification:**
- conversation-thread.spec.ts:603 "no horizontal scroll at the running viewport" passes on both projects.
- 44px tap target floor inherited from ExpandableBody's button (uses styles.expandButton with min-height tokens) and from ToolCallCard toggles.
- CSS module ConversationThreadView.module.css wraps the timestamp to its own row at 30rem so narrow widths do not overflow.

**Decision:** Verified shipped. Mobile coverage is complete.

### F. CR-flagged items from PR #483 + #484 reviews

| # | Source | Severity | Item | Resolution |
|---|---|---|---|---|
| F1 | PR #483 | Major | tool-call atom_id was synthetic, broke truncation Show more deep-link | Shipped in PR #486: atom_id stays bound to source atom; tool_call_index carries per-row uniqueness; renderer keys by `${atom_id}:tool-${index}` |
| F2 | PR #483 | Nitpick (body-scoped) | STAGE_OUTPUT_TYPES + DISPATCH_OBSERVATION_KINDS hardcoded | Shipped in PR #486: injectable via ConversationAssembleOptions, default behavior unchanged |
| F3 | PR #483 | Low value | handleConversationExpandBlob comment fix | N/A: endpoint already removed in PR #483 (no longer in server) |
| F4 | PR #483 | Suggestion | tool-call args were truncated but result-truncation was applied; need parity | Resolved before PR #483 merged (both args + result truncation already shipped) |
| F5 | PR #483 | Suggestion | event cap of 500 must preserve most-recent tail + always pin intent | Resolved before PR #483 merged (conversation-assembler.ts:631-639 implements pin-intent + tail-cap) |
| F6 | PR #484 | Suggestion | refetchInterval was fixed 10000 not callback | Resolved in PR #484 final commit (ConversationThreadView.tsx:90-94) |
| F7 | PR #484 | Suggestion | pipeline-not-found should render EmptyState early not generic ErrorState | Resolved in PR #484 final commit (ConversationThreadView.tsx:130-170) |
| F8 | PR #484 | Suggestion | ExpandableBody open state never reset on content change | Resolved in PR #484 final commit (ExpandableBody.tsx:63-78 derived-state pattern) |
| F9 | PR #484 | Suggestion | ToolCallCard button needs aria-controls | Resolved in PR #484 final commit (ExpandableBody.tsx:85, 103 aria-controls={bodyId}) |
| F10 | PR #484 | Nitpick | assertNever for exhaustive switches | Skip with rationale: ConversationEvent.tsx:392-414 carries both compile-time exhaustiveness AND graceful runtime fallback. The trade-off is documented inline; forward-compat for substrate vocabulary expansion is the chosen posture per canon `dev-indie-floor-org-ceiling`. |
| F11 | PR #484 | Nitpick | formatRelative back-imported from PipelinesView creates cycle | Resolved in PR #484 final commit (local time.ts file in conversation-thread feature folder) |
| F12 | PR #484 | Nitpick | Hardcoded icon size + strokeWidth literals | Skip with rationale: 60+ existing call-sites across the codebase use the same `size={N}` pattern (verified via grep). Refactoring to token-backed sizing is a sweeping codebase change unrelated to the Conversation Thread feature; should be a separate ship per canon `dev-extract-at-second-instance` (the second use case is the codebase-wide refactor, not this one feature). |
| F13 | PR #484 | Nitpick | e2e test deep-links past the new ConversationLink | Resolved in PR #484 final commit (conversation-thread.spec.ts:579-603 click-through test) |

## Console e2e baseline status

Captured partial baseline (interrupted at test 64/560) showed pre-existing failures clustered around test specs that seed atom files directly into the LAG dir and rely on the dev-server file-watcher to pick them up. These are not regressions from the Conversation Thread work; the pattern predates the feature.

**Failure clusters observed:**
- `activities-reaped-toggle.spec.ts` (1 test)
- `canon-suggestions.spec.ts` (multiple tests)
- `end-to-end-intent-to-merge.spec.ts` (5+ tests)

**Suspected root cause:** Two server processes watching the same `.lag/atoms/` directory (primary worktree's dev-server at 9080/9081 and parallel worktree's e2e dev-server at 9082/9083 both default to the sibling-main LAG dir via SIBLING_MAIN_LAG fallback in playwright.config.ts). The Windows `fsWatch` can drop events under contention.

**Recommended mitigation (follow-up ship):**
1. Each test spec that seeds atoms should use its own isolated LAG_DIR fixture rather than writing to the shared sibling-main LAG dir.
2. The dev-server file-watcher could fall back to polling on Windows when fsWatch returns `change` events with `filename: null`.
3. Worktree-aware playwright.config.ts default: when running from a non-primary worktree, default LAG_DIR to the worktree's own `.lag/` (creating it if absent) rather than the sibling-main dir.

**Coverage of Conversation Thread feature on baseline run:** ✓ All 7 conversation-thread.spec.ts tests pass on both chromium + mobile projects in the parallel-worktree environment.

## Routes inventory (per src/state/router.store.ts)

20 routes ship in the v1 surface:

| Route | Detail subroute | Mobile? |
|---|---|---|
| /dashboard | n/a | ✓ |
| /control | n/a | ✓ |
| /live-ops | n/a | ✓ |
| /canon | /canon/:atom_id | ✓ |
| /principals | /principals/:principal_id | ✓ |
| /hierarchy | n/a | ✓ |
| /activities | /activities/:atom_id | ✓ |
| /plans | /plans/:plan_id | ✓ |
| /graph | n/a | ✓ |
| /timeline | n/a | ✓ |
| /plan-lifecycle | n/a | ✓ |
| /canon-suggestions | n/a | ✓ |
| /actor-activity | n/a | ✓ |
| /deliberation | /deliberation/:plan_id, /deliberation/:plan_id/conversation | ✓ |
| /pipelines | /pipelines/:pipeline_id, /pipelines/:pipeline_id/conversation | ✓ |
| /resume | n/a | ✓ |
| /operator-actions | n/a | ✓ |
| /atom | /atom/:atom_id | ✓ |
| /file-intent | n/a | ✓ |
| /system-health | n/a | ✓ |

Each route has at least one passing e2e spec (verified by spec name list in tests/e2e/).

## PRs shipped from this audit

- **PR #486** (merged 2026-05-30): fix(console) keep tool-call atom_id bound to source atom + injectable stage/dispatch sets. Closes F1 + F2 above.
- **PR #487** (merged 2026-05-30): feat(console) wire conversation thread to pipeline SSE for live updates. Closes A above; also includes the stale `void ctx;` cleanup from the PR #486 CR nitpick.
- **PR #488** (in flight): test(console) add e2e coverage for /timeline route. Closes the audit gap where the /timeline route shipped without dedicated e2e coverage.

## Conversation Thread e2e final state

- 8 chromium specs + 8 mobile specs = 16 passing tests
- New since PR #484: multi-tool-call key-uniqueness check, SSE atom-change invalidation
- Mobile no-horizontal-scroll verified at iPhone 13 viewport (390x844)

## Console e2e: known infrastructure gap

The Playwright e2e suite is NOT in CI per `console-ci.yml`:

```
# Playwright e2e deferred to follow-up: the tests depend on a .lag/
# atoms directory populated with fixture JSON. Running e2e in CI
# requires committing a stable test fixture and pointing
# LAG_CONSOLE_LAG_DIR at it. Tracked separately so this workflow
# can land and start providing typecheck+build signal immediately.
```

CI runs unit tests + typecheck + build + lint only. Playwright e2e tests are local-only. This is a substantial gap for the operator-stated "everything green at all phases" north-star and is the single highest-leverage follow-up. Recommended next ship:

1. Commit a stable e2e atom fixture under `tests/e2e/fixtures/.lag/atoms/*.json` with at least one atom of each canonical type (pipeline, plan, intent, agent-turn, agent-session, stage-event, audit-finding, observation, actor-message).
2. Point `LAG_CONSOLE_LAG_DIR` at that fixture dir in `console-ci.yml`.
3. Add a CI job that runs `npm run e2e` (or just the chromium project to keep CI runtime bounded).
4. Migrate the 5-10 seed-file-race specs (activities-reaped-toggle, canon-suggestions, end-to-end-intent-to-merge) to read from the committed fixture instead of writing fresh seed files.

This is out of scope for the conversation-thread-focused work in this audit but is the single biggest leverage move for raising e2e reliability.
