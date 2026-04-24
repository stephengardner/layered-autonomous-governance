# Autonomous-intent substrate - design spec

**Status:** draft, pre-review
**Date:** 2026-04-24
**Author:** brainstorming session with operator (stephen@shopsheriff.com)
**Branch:** `feat/autonomous-intent-substrate`

## Problem

LAG has two co-existing pipelines that both move "an operator wants X" into merged code, and neither one closes the autonomous loop the canon claims:

1. **Plan-approval pipeline** (`src/runtime/actor-message/plan-approval.ts` + `runAutoApprovePass` + `runPlanApprovalTick` + `runDispatchTick` + `runPlanStateReconcileTick`): formally defined, governance-heavy, with policies for low-stakes auto-approve and multi-reviewer consensus. **Has fired end-to-end exactly once** (`plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042`, 2026-04-20). 18 other CTO-drafted plans sit at `plan_state=proposed` indefinitely.
2. **Code-author Question→Plan→PR pipeline** (`cto-seeds-question-atom` #125 + drafter `#121` + code-author-invoker): ships 20+ PRs per week. But plans produced through this path never enter the `plan_state` machinery - they're an ephemeral intermediate.

The **direct root cause** that blocks pipeline 1: the `planDraftOutput` zod schema at `src/schemas/index.ts:366-388` does NOT include a `delegation` field. `runPlanApprovalTick` at `src/runtime/actor-message/plan-approval.ts:159` short-circuits any plan without `metadata.delegation.sub_actor_principal_id`. The CTO planner has no way to emit the field, so every plan it drafts is ineligible for auto-approval from birth.

Secondary gates:
- Confidence threshold (`min_plan_confidence: 0.85`) exceeds the CTO's typical draft confidence (0.62-0.82).
- No sub-actor invoker for `code-author` is checked into `run-approval-cycle.mjs`'s `--invokers` surface, so even an approved plan has nothing to dispatch into.
- No declarative surface for "operator wants this solved autonomously" exists - the `proposed → approved` transition requires either manual `lag-respond` votes or direct policy coverage, neither of which is automatable per-request.

The operator has stated the goal explicitly: *"a flow in which I can say we want a problem solved, and the pipeline can take that, formulate a plan, deliberate if needed, pass it on, get it coded, shipped, audited, the works."* Pipeline 1 is the canonical place that flow should live. It's broken.

## Goals

1. The operator can declare autonomous-solve intent via a first-class atom with an explicit trust envelope.
2. The CTO planner produces plans that satisfy `runPlanApprovalTick`'s schema invariants (delegation + confidence + provenance chain).
3. An approved plan dispatches into a sub-actor (`code-author` for PR-producing work; `auditor-actor` for read-only observation work).
4. The sub-actor produces observable artifacts (PR, audit report).
5. `runPlanStateReconcileTick` transitions the plan to `succeeded` or `abandoned` based on the artifact's terminal state.
6. The frontend surfaces the state machine: proposed → approved → executing → succeeded|abandoned is visible in `/plans` with timestamps.
7. The substrate is extensible: a future `pol-autonomy-dial-*` canon (option C from brainstorming) layers on top without rework.
8. The substrate is safe for 50+ actor deployments: taint cascades correctly, kill-switch still halts, L3 canon still requires human approval even in autonomous mode.

## Non-goals (explicit)

- **No automation of `canon-write-l3`.** The operator authority for L3 promotion remains manual per `inv-l3-requires-human`. Intents can authorize code changes, documentation, tooling, adapter scope; they CANNOT authorize canon edits.
- **No bot-authored intents in v1.** Only operator-principal may write `operator-intent` atoms. Future extension (principal-delegation-chain) is out of scope.
- **No multi-reviewer bot deliberation in v1.** If a plan needs deliberation, it escalates. Peer-review bots are a follow-up.
- **No "retroactive intent" for existing stuck plans.** The 18 backlog plans remain untouched by this PR; they require a separate cleanup (e.g., auto-expiry per the CTO's earlier Plan 3 proposal).
- **No changes to pipeline 2** (code-author Question→PR direct path). It continues to work as-is. This spec adds pipeline 1 as a second option; it does not replace pipeline 2.
- **No changes to CR / branch protection / CI.** The autonomous pipeline respects all existing merge gates identically to a human-authored PR.

## Design

### 1. The `operator-intent` atom

New atom type. The declarative surface for "operator wants X solved autonomously."

```typescript
interface OperatorIntentAtom extends Atom {
  type: 'operator-intent';
  layer: 'L1';
  principal_id: PrincipalId;          // MUST be operator-principal (v1 gate)
  provenance: {
    kind: 'operator-seeded';
    source: { tool: 'intend-cli' | 'intend-skill' };
    derived_from: [];
  };
  confidence: 1.0;                     // operator's own intent is certain
  scope: string;                       // tenant scope, default 'project'
  content: string;                     // human-readable problem statement
  metadata: {
    kind: 'autonomous-solve';          // versioned dispatch surface; future: 'research-only', 'incident'
    request: string;                   // full request payload (copied from content for query ergonomics)
    trust_envelope: {
      max_blast_radius: 'tooling' | 'docs' | 'framework' | 'l3-canon-proposal';
      max_plans: number;               // cap on CTO drafts against this intent; default 5
      min_plan_confidence: number;     // 0..1; autonomous plans must meet this; default 0.75
      allowed_sub_actors: string[];    // subset of {code-author, auditor-actor, ...}
      require_ci_green: boolean;       // default true
      require_cr_approve: boolean;     // default true
      require_auditor_observation: boolean; // default true; auditor must observe before reconcile
    };
    expires_at: string;                // ISO-8601; default +24h from created_at
    consumed_by_plans: string[];       // plan atom ids; populated by CTO
    consumed_by_questions: string[];   // question atom ids; populated by CTO
  };
  supersedes: [];
  superseded_by: [];
  taint: 'clean';
}
```

**Design rationale, field by field:**

- `type: 'operator-intent'`: new type, distinct from `directive` (L3 canon), `observation` (passive record), `plan` (proposed action), `question` (open inquiry). Substrate cost is one enum value; the semantic clarity is worth it.
- `layer: 'L1'`: intent is an input observation, not canon. Canon gates remain at L3.
- `principal_id`: must be operator-principal. Enforced by `pol-operator-intent-creation` canon atom. Non-operator authored intent atoms are ignored by the autonomous path (treated as observations for audit but carry no authority).
- `metadata.kind` versioning: lets future modes (`research-only` for intents that should only produce reports, `incident` for time-critical escalation, `l3-canon-proposal` for proposing L3 canon edits that still require human ratification) extend without breaking v1 consumers.
- `trust_envelope.max_blast_radius`: coarse first-order gate. `tooling` = scripts/config/docs; `docs` = markdown/assets only; `framework` = src/ changes; `l3-canon-proposal` = proposes but requires human ratification to land. Plans exceeding the declared blast radius escalate.
- `trust_envelope.allowed_sub_actors`: narrower gate on top of blast_radius. Operator can say "code-author yes, deploy-actor no."
- `require_auditor_observation: true` (default): makes auditor pre-flight non-optional unless explicitly waived. The auditor observes the PR before merge and writes a pass/fail observation; reconcile-tick reads it.
- `expires_at`: 24h default safety bound. An intent that sits un-actioned for a day dies; re-declaring is a conscious operator act.
- `consumed_by_*`: observability; helps trace what the intent produced.

**Rejected alternative:** extend `question` atoms with a trust_envelope. Rejected because questions are inquisitive ("what should we do about X?"); intents are authorizing ("solve X within these bounds"). The semantic blur would corrupt both atom types for future framework users; separate types keep the policy surface clean.

### 2. Declarative CLI: `scripts/intend.mjs`

The operator's primary surface for writing intent atoms.

```bash
node scripts/intend.mjs \
  --request "fix the CTO planner so it emits delegation.sub_actor_principal_id" \
  --scope tooling \
  --blast-radius framework \
  --sub-actors code-author \
  --min-confidence 0.75 \
  --expires-in 12h \
  [--kind autonomous-solve] \
  [--dry-run]
```

Behavior:
1. Parse args; validate scope/blast-radius enums against v1 allowlist.
2. Load operator-principal id from `.env` (`LAG_OPERATOR_ID`). Fail-closed if absent.
3. Compute `expires_at = now + --expires-in` (default 24h).
4. Construct `operator-intent` atom with defaults applied for omitted envelope fields.
5. Write via `host.atoms.put`. Fail loudly on duplicate id (shouldn't happen; ids include a nonce).
6. Write accompanying `question` atom seeded from the intent; link via provenance `derived_from`.
7. Emit to Notifier: "Intent `<id>` written; question `<q-id>` seeded; CTO dispatch pending."
8. Optionally auto-trigger CTO: `--trigger` flag runs `run-cto-actor.mjs --request <text> --intent-id <id>` inline.
9. Print intent + question ids to stdout.

Safety:
- `--dry-run` prints what would be written without side effects.
- If `.lag/STOP` exists, refuse to write (kill-switch respects intent creation).
- Operator ID validation: script checks `operator-principal` is active + not taint.

### 3. CTO planner integration

The planning actor needs three changes:

**3a. `planDraftOutput` schema extension** (`src/schemas/index.ts`)

Add a required `delegation` field:

```typescript
const planDraftOutput = z.object({
  plans: z.array(z.object({
    // ...existing fields...
    delegation: z.object({
      sub_actor_principal_id: z.enum(['code-author', 'auditor-actor']),
      reason: z.string().min(1).max(300),
    }),
  })).min(1).max(5),
});
```

Values constrained to v1 allowlist. Future sub-actors (deploy-actor, security-reviewer) add to the enum via a separate PR.

**3b. PLAN_DRAFT system prompt update** (`src/schemas/index.ts`)

Add the delegation-choice instruction. New section in the prompt:

```
DELEGATION:
- You MUST choose a sub_actor_principal_id for every plan you draft. The
  sub-actor is the principal who will IMPLEMENT the plan if the operator
  (or the auto-approve policy) approves it.
- Choose 'code-author' when the plan REQUIRES code changes that result in
  a Pull Request: modifications to src/, scripts/, tests/, docs/, config
  files. This includes refactoring, new features, bug fixes, new scripts,
  new documentation files.
- Choose 'auditor-actor' when the plan is a read-only audit or review:
  inspecting existing code, generating a compliance report, surfacing
  findings without making changes. Auditor writes observation atoms; it
  does NOT produce PRs.
- If the plan naturally requires TWO or more sub-actor invocations
  (audit-then-fix), draft TWO separate plans in the plans[] array: one
  with delegation.sub_actor_principal_id='auditor-actor' first, and one
  with 'code-author' that derives_from the first.
- The reason field is a one-sentence justification for the choice; it
  must make sense in isolation (arbitration-visible).
```

**3c. Planning-actor writer** (`src/runtime/actors/planning/planning-actor.ts`)

When constructing the plan atom's metadata:

```typescript
metadata: {
  // ...existing fields...
  delegation: {
    sub_actor_principal_id: draft.delegation.sub_actor_principal_id,
    reason: draft.delegation.reason,
  },
  derived_from_intent: intentId ?? null,  // populated when invoked with --intent-id
}
```

The `derived_from_intent` link is CRITICAL: it lets `runAutoApprovePass` walk from plan → intent to find the trust envelope.

### 4. Approval tick integration: new intent-based policy

New canon policy atom `pol-plan-autonomous-intent-approve`:

```typescript
{
  id: 'pol-plan-autonomous-intent-approve',
  subject: 'plan-autonomous-intent-approve',
  layer: 'L3',
  reason:
    'Plans that derive_from a fresh (non-expired) operator-intent atom with a ' +
    'matching trust envelope auto-transition proposed -> approved without a multi-reviewer ' +
    'vote cycle. The intent IS the authorization. This policy enforces envelope match: ' +
    'plan confidence >= intent.min_plan_confidence, plan blast_radius <= intent.max_blast_radius, ' +
    'plan.delegation.sub_actor_principal_id in intent.allowed_sub_actors. Intent must be fresh ' +
    '(now < intent.expires_at) and uncompromised (taint=clean). Empty allowlist = no intent path; ' +
    'removing this policy disables autonomous-intent flow without breaking manual paths.',
  fields: {
    allowed_sub_actors: ['code-author', 'auditor-actor'],
    require_intent_fresh: true,
    require_intent_clean: true,
    require_intent_principal_allowlist: 'pol-operator-intent-creation',  // atom id reference
    // Inherits other gates from the intent's own trust_envelope.
  }
}
```

New tick `runIntentAutoApprovePass` in `src/runtime/actor-message/intent-approve.ts`:

```typescript
async function runIntentAutoApprovePass(host: Host, options?: TickOptions): Promise<Result> {
  const policy = await readIntentApprovePolicy(host);
  if (policy.allowed_sub_actors.length === 0) return { scanned: 0, approved: 0 };

  // Scan proposed plans with an intent link.
  const plans = await queryProposedPlansWithIntent(host, maxScan);
  let scanned = 0, approved = 0, rejected = 0;
  for (const plan of plans) {
    scanned++;
    const intent = await host.atoms.get(plan.metadata.derived_from_intent);
    if (!intent || intent.type !== 'operator-intent') continue;          // no intent found
    if (intent.taint !== 'clean') continue;                              // compromised intent
    if (Date.parse(intent.metadata.expires_at) < Date.now()) continue;    // expired
    if (!intentPrincipalAllowed(intent.principal_id, host)) continue;     // non-whitelisted author

    // Envelope check.
    const env = intent.metadata.trust_envelope;
    if (plan.confidence < env.min_plan_confidence) continue;
    if (!env.allowed_sub_actors.includes(plan.metadata.delegation.sub_actor_principal_id)) continue;
    // (blast_radius check: deferred to classification on the plan; see 4b below)

    // Transition plan -> approved. Re-read for claim-before-mutate.
    const latest = await host.atoms.get(plan.id);
    if (!latest || latest.plan_state !== 'proposed') continue;
    await host.atoms.update(plan.id, {
      plan_state: 'approved',
      metadata: {
        ...latest.metadata,
        approved_via: 'pol-plan-autonomous-intent-approve',
        approved_at: new Date().toISOString(),
        approved_intent_id: intent.id,
      },
    });
    await host.auditor.log({ kind: 'plan.approved-by-intent', /* ... */ });
    approved++;
  }
  return { scanned, approved, rejected, stale: 0 };
}
```

Wire `runIntentAutoApprovePass` into `run-approval-cycle.mjs` as tick 0 (before the existing auto-approve and multi-reviewer ticks), because intent approval is the most specific gate.

**4b. Blast-radius check.** For v1, the blast_radius check is *advisory*: the plan's `delegation.sub_actor_principal_id` implies a blast radius (code-author → framework; auditor-actor → none/read-only). The check is `plan.implied_blast_radius <= intent.max_blast_radius`. A future PR makes the CTO emit `plan.metadata.blast_radius` explicitly with classification; for v1, we use a lookup table in the tick.

### 5. Dispatch invoker registration

**5a. Code-author invoker module** (new): `scripts/invokers/autonomous-dispatch.mjs`

```javascript
export default async function register(host, registry) {
  // Auditor-actor is registered by run-approval-cycle.mjs already.
  // This module adds code-author (PR-producing sub-actor).
  registry.register('code-author', async (plan, ctx) => {
    const { runCodeAuthor } = await import('../../dist/actor-message/code-author-invoker.js');
    return runCodeAuthor({ host, plan, ...ctx });
  });
}
```

Wire via `run-approval-cycle.mjs --invokers scripts/invokers/autonomous-dispatch.mjs`.

**5b. Autonomous-dispatch daemon** (optional v1 mode): `scripts/daemon-autonomous.mjs`

Long-running loop that calls `run-approval-cycle.mjs --once` every N seconds. Not strictly required for v1 (the existing approval-cycle can run once-shot), but makes the loop observable.

### 6. Reconcile tick + auditor gate

**6a. Existing `runPlanStateReconcileTick`** already watches for `pr-observation` atoms with terminal `merge_state_status`. No change needed. When `code-author`'s PR lands, pr-landing actor writes `pr-observation` with `merge_state_status: 'merged'`; reconcile-tick transitions plan to `succeeded`.

**6b. Auditor pre-flight gate** (required when `intent.trust_envelope.require_auditor_observation: true`):

Before reconcile transitions `executing → succeeded`, the auditor-actor must have written an observation atom with `kind: 'auditor-plan-check'`, `derived_from: plan.id`, and a verdict field. Reconcile checks:

```typescript
if (plan.metadata.approved_intent_id) {
  const intent = await host.atoms.get(plan.metadata.approved_intent_id);
  if (intent?.metadata.trust_envelope.require_auditor_observation) {
    const auditor_verdict = await queryAuditorVerdict(host, plan.id);
    if (!auditor_verdict) continue;  // wait
    if (auditor_verdict.verdict === 'fail') {
      // Transition to abandoned, not succeeded.
      await host.atoms.update(plan.id, { plan_state: 'abandoned', metadata: { abandoned_reason: 'auditor-fail', abandoned_by: auditor_verdict.id } });
      continue;
    }
  }
}
```

Auditor-actor is invoked as part of the dispatch chain: `code-author` produces PR; `auditor-actor` is invoked (after PR opens, before merge) and writes the verdict. The dispatch chain is extended in 5a.

For v1, the auditor's logic is minimal: reads the PR's diff, checks blast-radius matches intent.max_blast_radius, writes a pass/fail atom. Deeper audits (security, cost) are follow-ups.

### 7. Deliberation model (minimal v1)

If a plan's classification is `ambiguous` or confidence < intent.min_plan_confidence, the CTO drafts a plan with `metadata.requires_deliberation: true`. The intent-approve tick skips such plans (stays `proposed`). Notifier escalates to operator.

No peer-review bots in v1. Future: add `runPeerReviewTick` that invokes designated reviewer principals for deliberation.

### 8. Canon + memory updates

**New canon atoms:**
- `pol-plan-autonomous-intent-approve` (L3) - the new approval policy.
- `pol-operator-intent-creation` (L3) - whitelist of principals allowed to author operator-intent atoms. v1: operator-principal only.
- `dev-autonomous-intent-substrate-shape` (L3 directive) - one-sentence: "Operator-authored operator-intent atoms with a trust_envelope authorize autonomous plan-approval; non-operator intent atoms are ignored by the autonomous path."

**New skill** `.claude/skills/autonomous-intent/SKILL.md`: describes the `intend` CLI + flow + what to expect. Pairs with `cto-actor` skill.

**Memory:** one feedback memory after shipping documenting the "pipeline A vs B" reconciliation finding (the substrate's two co-existing paths and when to use each).

**Update memory** `project_lag_is_governance_substrate.md`: mention that autonomous-intent is the declarative surface; trust envelopes are the per-request authorization mechanism.

### 9. Test plan

**Unit tests** (vitest, `test/runtime/actor-message/intent-approve.test.ts`):
- `runIntentAutoApprovePass` transitions plan when envelope matches.
- Refuses when intent is expired, tainted, non-operator-authored, missing, or envelope doesn't match.
- Claim-before-mutate handles concurrent approval correctly.
- Policy with empty allowlist short-circuits.

**Unit tests for schema** (`test/schemas/plan-draft.test.ts`):
- PLAN_DRAFT rejects output without delegation field.
- PLAN_DRAFT rejects invalid sub-actor values.

**Unit tests for CTO writer** (`test/runtime/actors/planning/delegation.test.ts`):
- Planner copies delegation from draft into atom metadata.
- Planner copies `derived_from_intent` when intent-id arg is provided.

**Integration test** (`test/integration/autonomous-intent-e2e.test.ts`, gated `LAG_AUTONOMOUS_E2E=1`):
- Write operator-intent atom.
- Invoke CTO with --intent-id.
- Run approval-cycle once.
- Verify plan -> approved.
- (Dispatch step uses mock invoker in test; doesn't actually open PR.)

**CLI smoke test** (`test/scripts/intend.test.ts`):
- `intend --request X --dry-run` prints correct atom without writing.
- Fail-closed if LAG_OPERATOR_ID unset.

### 10. Migration + shipping

Shipped as one cohesive PR. No migration of existing stuck plans (out of scope). Follow-up PRs:
1. Apply the CTO's prior Plan 3 (sweep stale proposed plans via auto-expiry).
2. Add deeper auditor checks (security, cost).
3. Add peer-review tick (multi-reviewer deliberation bots).
4. Ship `pol-autonomy-dial-<scope>` canon (option C).

### 11. Portability + indie-floor

- `scripts/intend.mjs` has zero imports from `dist/actor-message/*` specific paths; it uses the Host interface only, through the standard `createFileHost` import. Works for any adapter.
- Intent atom is pure data; no runtime-specific fields.
- Single-operator deployment: default config; works immediately.
- Org deployment: multiple operator principals, each can write intents; scope maps to team; trust envelopes scale.

## Risks + mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Operator writes a too-broad intent (`scope: canon`), bot ships bad L3 edit | Canon pollution, hard to recover | Intent cannot authorize `canon-write-l3` at all (policy-level block); L3 is manual-only per `inv-l3-requires-human`. |
| Compromised operator-principal writes destructive intent | Unbounded blast radius | Taint cascade propagates; medium-tier kill-switch still halts. `pol-operator-intent-creation` could require multi-signature for high-blast-radius intents (follow-up). |
| CTO drafts plan with delegation mismatch (code-author for audit-only ask) | Wrong sub-actor invoked | PLAN_DRAFT prompt is explicit; zod schema validates enum; audit trail shows the misfire. |
| Intent expires mid-flight after plan is approved but before PR lands | Plan stuck in `executing`; orphaned work | Reconcile tick ignores intent freshness at executing stage; intent is only consulted at approval time. |
| Runaway: one intent produces too many plans | Cost + complexity blowup | `intent.max_plans` caps CTO draft count per intent; CTO checks before emitting. |
| Auditor gate blocks everything, plans pile up in executing | Pipeline stall | Intent can waive auditor gate via `require_auditor_observation: false` per-request; stale plans sweep in follow-up. |

## Open questions (to resolve in review)

1. **Who invokes the CTO for an intent?** Operator runs `intend --trigger`? Or a separate `run-cto-on-open-intents.mjs` daemon scans for intents without `consumed_by_plans` and invokes CTO? Current spec: manual --trigger in v1.
2. **How does the auditor know to check a plan?** Dispatch invoker could chain auditor after code-author. Or a separate tick scans for `executing` plans with `require_auditor_observation` and no verdict. Current spec: dispatch chain (5a).
3. **What if the plan produces multiple PRs?** Multi-PR plans are rare; v1 assumes one plan = one PR. Spec flags this as a limit; multi-PR plans should be decomposed into multiple sibling plans citing the same intent.
4. **Intent version enum?** `kind: 'autonomous-solve'` is v1. `kind: 'research-only'`, `kind: 'incident'` are future. Leave room but don't over-specify.

## Acceptance criteria

The PR is mergeable when:
1. Operator can run `node scripts/intend.mjs --request "fix X" --scope tooling --blast-radius framework --sub-actors code-author` and the atom is written.
2. Operator can run `node scripts/run-cto-actor.mjs --request "fix X" --intent-id <id>` and a plan atom with `delegation` + `derived_from_intent` is written.
3. Running `node scripts/run-approval-cycle.mjs --once --root-dir . --invokers scripts/invokers/autonomous-dispatch.mjs` transitions the plan proposed → approved → executing.
4. Frontend `/plans` shows the plan progressing through states.
5. Frontend `/timeline` shows the intent + plan atoms (not drowned by observations).
6. All new unit + integration tests pass.
7. CI (ubuntu + windows) green.
8. CR approves.
9. No L3 canon changes merged via autonomous path (dogfood constraint: this PR's own canon changes go through human gate).

## Ship order + acceptance flow for THIS PR

Because of the bootstrap paradox (the fix can't ship via the autonomous path it creates), this PR lands via standard human-reviewed PR flow:
1. Draft spec (this doc).
2. Spec review loop.
3. Operator review gate.
4. Writing-plans skill → implementation plan.
5. Subagent-driven implementation.
6. PR via `gh-as lag-ceo`.
7. CR review.
8. Human merge OR bot-merge per #128/#136 pattern.
9. Post-merge: run an autonomous-intent dogfood to validate the full pipeline.

## References

- `src/runtime/actor-message/plan-approval.ts:153` - confidence gate.
- `src/runtime/actor-message/plan-approval.ts:159` - delegation gate.
- `src/schemas/index.ts:366-388` - planDraftOutput schema (missing delegation).
- `scripts/lib/inbox-canon-policies.mjs:146` - pol-plan-auto-approve-low-stakes.
- `scripts/lib/inbox-canon-policies.mjs:166` - pol-plan-multi-reviewer-approval.
- `scripts/run-approval-cycle.mjs` - the four-tick orchestrator.
- Canon `inv-l3-requires-human`, `inv-governance-before-autonomy`, `inv-kill-switch-first`.
- Canon `dev-indie-floor-org-ceiling`, `dev-canon-is-strategic-not-tactical`, `dev-forward-thinking-no-regrets`.
