// Shared policy-spec factory for bootstrap-medium-tier-kill-switch-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the policy payload and
// assert against the canon-companion atoms without spawning Node.
//
// The bootstrap script at scripts/bootstrap-medium-tier-kill-switch-canon.mjs
// imports buildPolicies + companionAtom from here; the script remains
// the CLI entry point and owns env/host side effects. Mirrors the
// convention established by scripts/lib/self-audit-cadence-canon-policies.mjs.
//
// Four companion atoms seeded here:
//
//   - dec-medium-tier-kill-switch-shipped-2026-05-22
//       Decision atom recording that the medium tier interface +
//       reference implementation landed on this date. Future canon
//       readers cite this id when explaining how the four blocked
//       directives unblock.
//
//   - dec-pol-cto-no-merge-medium-tier-available-2026-05-22
//   - dec-pol-pr-landing-no-auto-merge-medium-tier-available-2026-05-22
//   - dec-inv-kill-switch-first-medium-tier-available-2026-05-22
//
//       Three additional decision atoms, one per parent canon entry
//       that historically gated on D13. Each records that the medium
//       tier is now available as opt-in. Parents are NOT modified
//       (per dev-canon-atoms-immutable: an L3 atom that is published
//       and consumed is not edited in place; supersession or
//       companion atoms carry the delta). Arbitration reads both the
//       parent and the companion; the companion's later created_at
//       lets a downstream reader resolve the current posture without
//       reflowing the original directive text.

const BOOTSTRAP_TIME = '2026-05-22T00:00:00.000Z';

/**
 * Build the medium-tier kill-switch canon POLICIES spec list.
 *
 * Returns 4 specs in a stable order:
 *   1. The base decision atom recording the ship.
 *   2-4. Three companion atoms (one per parent canon directive that
 *      previously cited D13 as an unfulfilled gate).
 *
 * @param {string} _operatorId - Operator principal id. Currently
 *   unused (the atoms reference canon ids, not operator-scoped
 *   allowlists), but kept on the signature to match the
 *   bootstrap-*-canon-policies convention so script wiring stays
 *   uniform across canon seeds.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'dec-medium-tier-kill-switch-shipped-2026-05-22',
      subject: 'medium-tier-kill-switch-shipped',
      reason:
        'The medium-tier kill-switch (canon D13 reservation) ships with this seed. '
        + 'src/substrate/kill-switch/medium-tier.ts declares the MediumTierKillSwitch '
        + 'interface (arm/disarm/tripAll). examples/kill-switches/process-supervisor/ '
        + 'ships the reference adapter, with POSIX (SIGTERM then SIGKILL) and Windows '
        + '(taskkill /F /T) platform branches selected at construction time. '
        + 'src/runtime/actors/run-actor.ts exposes the supervisor on ActorContext '
        + 'as an opt-in option; runActor calls tripAll() automatically on a '
        + 'kill-switch halt so any still-armed subprocesses are forcibly terminated '
        + 'before the loop unwinds. This decision atom unblocks the four canon '
        + 'directives that previously cited D13 as an unfulfilled gate '
        + '(pol-cto-no-merge, pol-pr-landing-no-auto-merge, inv-kill-switch-first, '
        + 'dec-kill-switch-design-first). The medium tier is opt-in: a deployment '
        + 'that does not wire a supervisor continues to run on the soft tier alone, '
        + 'preserving the indie-floor default of zero out-of-process dependencies.',
      fields: {
        shipped_at: BOOTSTRAP_TIME,
        substrate_path: 'src/substrate/kill-switch/medium-tier.ts',
        reference_impl_path: 'examples/kill-switches/process-supervisor/',
        runner_wiring_path: 'src/runtime/actors/run-actor.ts',
        unblocks: [
          'pol-cto-no-merge',
          'pol-pr-landing-no-auto-merge',
          'inv-kill-switch-first',
          'dec-kill-switch-design-first',
        ],
      },
    },
    {
      id: 'dec-pol-cto-no-merge-medium-tier-available-2026-05-22',
      subject: 'medium-tier-companion',
      reason:
        'Companion atom to pol-cto-no-merge. The parent directive cites the '
        + 'medium-tier kill switch as an unfulfilled gate '
        + '("Loosening pol-cto-no-merge ... requires the medium-tier kill switch '
        + '(canon D13) shipped first"). With this seed, the medium tier is '
        + 'available as an opt-in substrate primitive '
        + '(dec-medium-tier-kill-switch-shipped-2026-05-22). The parent gate is '
        + 'NOT auto-loosened: an operator who wants to relax pol-cto-no-merge '
        + 'lands a separate canon edit that explicitly cites this companion atom '
        + 'as the substrate prerequisite. Parent atom is not modified per '
        + 'dev-canon-atoms-immutable; this companion atom carries the delta so '
        + 'arbitration can resolve the current posture without reflowing the '
        + 'original directive text.',
      fields: {
        companion_to: 'pol-cto-no-merge',
        prerequisite_shipped: 'dec-medium-tier-kill-switch-shipped-2026-05-22',
      },
    },
    {
      id: 'dec-pol-pr-landing-no-auto-merge-medium-tier-available-2026-05-22',
      subject: 'medium-tier-companion',
      reason:
        'Companion atom to pol-pr-landing-no-auto-merge. The parent directive '
        + 'cites the medium-tier kill switch as an unfulfilled gate '
        + '("Merging is held with the operator until medium-tier kill switch '
        + 'ships (D13)"). With this seed, the medium tier is available as an '
        + 'opt-in substrate primitive '
        + '(dec-medium-tier-kill-switch-shipped-2026-05-22). The parent gate is '
        + 'NOT auto-loosened: an operator who wants to enable auto-merge on '
        + 'pr-landing-agent lands a separate canon edit that explicitly cites '
        + 'this companion atom as the substrate prerequisite. Parent atom is '
        + 'not modified per dev-canon-atoms-immutable.',
      fields: {
        companion_to: 'pol-pr-landing-no-auto-merge',
        prerequisite_shipped: 'dec-medium-tier-kill-switch-shipped-2026-05-22',
      },
    },
    {
      id: 'dec-inv-kill-switch-first-medium-tier-available-2026-05-22',
      subject: 'medium-tier-companion',
      reason:
        'Companion atom to inv-kill-switch-first and dec-kill-switch-design-first. '
        + 'The parent invariant ("Design the kill switch before moving the autonomy '
        + 'dial. Soft tier (STOP sentinel) is required; medium and hard tiers are '
        + 'roadmap but the seams are reserved.") plus the design decision both '
        + 'reserve the medium-tier seam without filling it. With this seed, the '
        + 'medium tier is filled (interface + reference impl + runner wiring per '
        + 'dec-medium-tier-kill-switch-shipped-2026-05-22). The autonomy dial '
        + 'is NOT auto-moved: an operator who wants to widen autonomy lands a '
        + 'separate canon edit that cites this companion atom. The hard tier '
        + 'remains a reserved future seam. Parents are not modified per '
        + 'dev-canon-atoms-immutable.',
      fields: {
        companion_to: 'inv-kill-switch-first',
        also_unblocks: 'dec-kill-switch-design-first',
        prerequisite_shipped: 'dec-medium-tier-kill-switch-shipped-2026-05-22',
      },
    },
  ];
}

/**
 * Build the L3 decision atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/self-audit-cadence-canon-policies.mjs
 * so the file-host round-trip and drift-check are identical across
 * the canon bootstraps.
 *
 * Uses `type: 'decision'` (not 'directive') because these atoms record
 * facts ("the medium tier shipped") + companion bindings ("this parent
 * directive now has a substrate prerequisite available"), not new
 * imperative rules. The arbitration stack treats 'decision' and
 * 'directive' uniformly at L3.
 */
export function companionAtom(spec, operatorId) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.reason,
    type: 'decision',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-medium-tier-kill-switch', agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: operatorId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: spec.subject,
        reason: spec.reason,
        ...spec.fields,
      },
    },
  };
}
