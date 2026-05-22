// Shared policy-spec factory for bootstrap-self-audit-cadence-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the runtime reader (loadSelfAuditCadence in
// src/substrate/policy/self-audit-cadence.ts) without spawning Node.
//
// The bootstrap script at scripts/bootstrap-self-audit-cadence-canon.mjs
// imports buildPolicies + policyAtom from here; the script remains the
// CLI entry point and owns env/host side effects. Mirrors the convention
// established by scripts/lib/loop-pass-claim-reaper-canon-policies.mjs.
//
// The single policy atom seeded here gates the LoopRunner's
// self-audit pass cadence (PR-10 of the perpetual-self-audit-v1
// backlog). Default enabled=false per the default-off posture; a
// deployment that wants the audit to fire on every cadence tick
// lands a higher-priority pol-self-audit-cadence atom with
// enabled=true via a deliberate canon edit, not a global toggle.

const BOOTSTRAP_TIME = '2026-05-22T00:00:00.000Z';

/**
 * Build the self-audit cadence POLICIES spec list. Parameterized on
 * the operator principal id (signs the seed atom) but otherwise pure.
 *
 * Currently a single-atom set: `pol-self-audit-cadence`. The atom id
 * carries no `-default` suffix because the subject discriminator is
 * the unique key the reader scans for; a deployment that wants a
 * scope-specific override lands a higher-priority
 * pol-self-audit-cadence-<scope> atom with the same subject, and
 * arbitration's source-rank formula resolves the higher-priority
 * atom first.
 *
 * Default matches the reader's hardcoded fallback so an existing
 * deployment that runs this seed for the first time observes
 * IDENTICAL behavior to its pre-canon-policy run. Flipping the dial
 * to `enabled: true` is a deliberate canon edit; a follow-up PR can
 * add a `pol-self-audit-cadence-org-ceiling` atom that the substrate
 * documents as the recommended higher-priority shape for orgs that
 * want continuous-audit posture.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-self-audit-cadence',
      subject: 'self-audit-cadence',
      reason:
        'Whether the autonomous loop runs the self-audit pass on every tick '
        + 'and the cadence at which the audit-driver closure actually fires. '
        + 'The pass invokes a caller-supplied closure (the framework holds no '
        + 'subprocess seam) when enabled=true AND the configured intervalMs '
        + 'has elapsed since the last fire. Default enabled=false per the '
        + 'default-off posture: a deployment running a long-running daemon '
        + 'does not surprise-pay a substrate-deep pipeline run at midnight '
        + 'on the first tick after upgrading. A deployment that wants the '
        + 'audit to fire on every cadence tick lands a higher-priority '
        + 'pol-self-audit-cadence-<scope> atom with enabled=true (or sets '
        + 'the CLI option / env var) so the audit driver fires on the '
        + 'configured cadence. Default intervalMs=3600000 (1 hour) matches '
        + 'the cadence an operator-cron would reasonably choose; tune to '
        + 'shorter for tight-audit deployments or longer for cost-sensitive '
        + 'ones via a higher-priority atom.',
      fields: {
        // Default-off. The CLI option / env override gates whether the
        // pass runs at all; this field gates whether the closure fires
        // when the pass runs. Flipping to true on a deployment that
        // wants the audit on every cadence tick is a one-line edit to
        // a higher-priority atom, not a framework release.
        enabled: false,
        // 1-hour cadence. Matches the reader's hardcoded fallback so
        // an existing deployment running this seed for the first time
        // observes the same default.
        intervalMs: 60 * 60 * 1000,
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/loop-pass-claim-reaper-canon-policies.mjs
 * so the file-host round-trip and drift-check are identical across
 * the canon bootstraps.
 */
export function policyAtom(spec, operatorId) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.reason,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-self-audit-cadence', agent_id: 'bootstrap' },
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
