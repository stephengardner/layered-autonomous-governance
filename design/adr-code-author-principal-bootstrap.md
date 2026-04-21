# ADR: code-author principal bootstrap (shape only, not yet seeded)

**Status:** PROPOSED. Seeds no principal on merge; proposes the exact shape a future bootstrap script will materialize.
**Companion ADR:** `design/adr-code-author-blast-radius-fence.md` (graduation criterion #1 of that ADR is "principal `code-author` exists in `.lag/principals/`"; this ADR unblocks that criterion).
**Authored:** 2026-04-21.

## Why this ADR, why now

The blast-radius fence ADR freezes four `pol-code-author-*` atom shapes and explicitly defers seeding them: "Do NOT seed atoms or write fence code until the code-author principal's bootstrap ADR lands." This is that ADR. It does not seed the principal either, for the same reason the fence ADR does not seed fence atoms: an unshipped `bootstrap-code-author-canon.mjs` is canon drift waiting to happen.

So: ratify the principal's shape here. The bootstrap script can then be written as a mechanical follow-up once the other three graduation criteria are in sight. This PR is ADR-only so the authority grant is visible in isolation.

## The principal shape (frozen)

Matches the pattern `scripts/bootstrap-pr-landing-canon.mjs` uses for `pr-landing-agent`, with tighter scopes to reflect the blast-radius fence's posture.

```ts
{
  id: 'code-author',
  name: 'Code Author',
  role: 'agent',
  signed_by: 'claude-agent',       // depth 3 from operator root:
                                   //   operator -> claude-agent -> code-author
  permitted_scopes: {
    read:  ['project'],            // project canon + plans; no session/user/global
    write: ['project'],            // writes only into the shared project store
  },
  permitted_layers: {
    read:  ['L0', 'L1', 'L2', 'L3'],  // read all (needs canon to judge its plan)
    write: ['L0', 'L1'],               // write L0 (observations, drafts) and L1
                                       // (extracted claims, code-author-revoked);
                                       // NO L3 writes. L3 canon is a human-gated
                                       // surface per inv-l3-requires-human.
  },
  goals: [],                       // goals land as plan atoms, not on the principal
  constraints: [],                 // constraints live in pol-code-author-* atoms,
                                   // NOT embedded on the principal (substrate-not-
                                   // prescription: the principal is a capability
                                   // holder; its authority scope is canon-driven)
  active: true,                    // will become true only when the bootstrap
                                   // script actually ships; the ADR-frozen shape
                                   // is the *intended* state, not the live state
  compromised_at: null,            // reset surface for operator use if the key
                                   // is ever exposed
  created_at: '<bootstrap time>',  // ISO timestamp at seeding
}
```

## Authority chain

```
operator (root principal, role=user)
  -> claude-agent (role=agent, signed_by=operator)
    -> code-author (role=agent, signed_by=claude-agent)
```

Depth 3 matches the `cto-actor` and `pr-landing-agent` depth. Arbitration's source-rank tiebreaker uses principal-hierarchy depth, so a code-author write does NOT outrank a CTO-authored plan; it is peer-depth and loses on the confidence tiebreaker when contested.

## What the bootstrap script will do (when it ships)

`scripts/bootstrap-code-author-canon.mjs` (not in this PR) will:

1. Ensure parent principals (`operator`, `claude-agent`) exist; re-assert if missing, matching the pattern of `bootstrap-pr-landing-canon.mjs`.
2. Seed the `code-author` principal with the shape above if missing; skip if an identical record exists (drift check on `signed_by`, `permitted_scopes`, `permitted_layers` fails loud per the `diffAtom` pattern already in `bootstrap-decisions-canon.mjs`).
3. Seed the four `pol-code-author-*` policy atoms from `adr-code-author-blast-radius-fence.md` - but ONLY if the other graduation criteria in that ADR are met. If any are outstanding, the script exits non-zero with a list of missing prerequisites, so the operator sees the gap.

That conditional-seed branch is the mechanism that enforces the fence ADR's "do NOT seed atoms whose principal has no bootstrap script" rule: atoms and principal always ship together.

## Graduation criteria for the bootstrap script

The script lands only when ALL of the following hold:

1. **This ADR is merged.** Sets the shape in stone; prevents drift between proposed and seeded.
2. **D13 medium-tier kill switch is shipped.** Per the fence ADR's `pol-code-author-write-revocation-on-stop`, revocation on STOP has to mean more than "stop reading the sentinel"; a runtime-revocation mechanism has to exist. The soft STOP of today does not qualify for a principal that can push commits.
3. **`test/arbitration/conflict-fuzz.ts` passes on the Postgres Host.** A code-author racing against an unfuzzed arbitration layer would be a source-of-truth risk the HIL cannot see.
4. **`pol-judgment-fallback-ladder` is live in canon** (already shipped; this is a no-op check, but the bootstrap asserts it defensively).

## What explicitly NOT to do in this PR

- **Do NOT ship `scripts/bootstrap-code-author-canon.mjs`**. The script's conditional-seed branch depends on D13 and conflict-fuzz, neither of which is in.
- **Do NOT create `src/actors/code-author/`**. Per the fence ADR.
- **Do NOT seed the principal** in any existing bootstrap script's principal chain (e.g., `bootstrap-pr-landing-canon.mjs` creates the operator + claude-agent chain as a side effect; resist the urge to piggyback). The principal is gated on its own bootstrap.

## Alternatives considered

1. **Bootstrap the principal now, defer the fence atoms.** Rejected. If the principal exists but no `pol-code-author-*` atoms do, the principal's default-authority-in-the-absence-of-policy is the null policy, which under the current `checkToolPolicy` resolves to "deny nothing specific, allow by default for the principal's layer/scope". That is the exact inverse of the fence's intent. Principal and fence atoms ship in the same PR as a unit.
2. **Combine this ADR and the fence ADR into one file.** Rejected. The fence ADR explicitly scopes itself to the four atoms and explicitly calls out the principal bootstrap as a separate ADR. Keeping them separate preserves the one-concern-per-review-surface property.
3. **Skip the ADR and wait until a bootstrap script is ready.** Rejected. The shape has to be ratified somewhere before the script writes atoms under it. Without a frozen shape, reviewers are left to derive the authority contract from code diffs, and drift slips in at implementation time.

## Rollback path

An approved but un-shipped ADR is zero-cost to retract: delete the file. No atoms, principals, or code exist to unwind. If the shape turns out wrong during the bootstrap-script review, the ADR updates there (and the decision record table below extends).

## Provenance

- `design/adr-code-author-blast-radius-fence.md` - the companion that reserves the fence slots.
- `plan-harden-three-substrate-layers-before-aut-cto-actor-20260420171042` - source self-audit plan from the CTO.
- `arch-principal-hierarchy-signed-by` - the authority-chain invariant this shape satisfies.
- `inv-l3-requires-human` - the reason `permitted_layers.write` caps at L1 (no autonomous L3 promotion).
- `dev-substrate-not-prescription` - the reason constraints live in policy atoms, not on the principal.
- `dev-forward-thinking-no-regrets` - frozen shape means graduation is a canon edit, not a re-design.

## Decision record

| Date | Actor | Action |
|---|---|---|
| 2026-04-20 | cto-actor (self-audit) | Proposed the fence ADR (companion). |
| 2026-04-21 | operator + claude-agent | Opened this ADR as graduation criterion #1 of the fence. ADR-only; no atoms, no principal, no code. |
| (pending) | reviewer | Approve the shape or request edits. |
| (pending) | future bootstrap author | Ship `bootstrap-code-author-canon.mjs` once D13 + conflict-fuzz are in. |
