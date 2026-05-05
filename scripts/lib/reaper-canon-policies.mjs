// Shared policy-spec factory for bootstrap-reaper-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches runtime fallbacks (DEFAULT_REAPER_TTLS in
// src/runtime/plans/reaper.ts) without spawning Node.
//
// The bootstrap script at scripts/bootstrap-reaper-canon.mjs imports
// buildPolicies + policyAtom from here; the script remains the CLI
// entry point and owns env/host side effects. Mirrors the
// scripts/lib/inbox-canon-policies.mjs convention.

const BOOTSTRAP_TIME = '2026-05-04T00:00:00.000Z';

/**
 * Build the reaper-canon POLICIES spec list. Parameterized on the
 * operator principal id (signs the seed atom) but otherwise pure.
 *
 * Currently a single-atom set: `pol-reaper-ttls-default`. The atom id
 * carries the `-default` suffix so an org-ceiling deployment can land
 * a higher-priority `pol-reaper-ttls-<scope>` atom (e.g.
 * `pol-reaper-ttls-tight` for sub-30s SLAs) without superseding the
 * default; arbitration's source-rank formula (Layer x Provenance x
 * depth x confidence) resolves the higher-priority atom first.
 *
 * Defaults match `DEFAULT_REAPER_TTLS` in
 * src/runtime/plans/reaper.ts so an existing deployment that runs
 * this script for the first time observes IDENTICAL behavior to its
 * pre-canon-policy run. The drift test at
 * test/scripts/bootstrap-reaper-canon.test.ts locks the two together.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-reaper-ttls-default',
      subject: 'reaper-ttls',
      reason:
        'Default warn / abandon TTLs for the LoopRunner stale-plan reaper, in milliseconds. '
        + 'Promotes the env-var + CLI-flag knobs (LAG_REAPER_WARN_MS, --reaper-warn-ms, etc.) '
        + 'to a canon policy atom per dev-substrate-not-prescription so an org-ceiling deployment '
        + 'can tune the cadence at scope boundaries via a higher-priority pol-reaper-ttls-<scope> '
        + 'atom rather than a framework release. Resolution order in LoopRunner.reaperPass: canon '
        + '> env > defaults; a malformed canon payload logs a stderr warning and falls through. '
        + 'Defaults (24h warn / 72h abandon) match DEFAULT_REAPER_TTLS in '
        + 'src/runtime/plans/reaper.ts so an existing deployment running this seed for the first '
        + 'time observes identical behavior. Tightening the cadence to e.g. 6h / 24h is an '
        + 'org-side canon edit that lands as a higher-priority pol-reaper-ttls-<scope> atom; '
        + 'arbitration resolves it via the existing source-rank formula.',
      fields: {
        // 24h: matches DEFAULT_REAPER_TTLS.staleWarnMs. A plan that has
        // sat in `proposed` for a day without progressing is unlikely to
        // ship without active operator engagement.
        warn_ms: 24 * 60 * 60 * 1000,
        // 72h: matches DEFAULT_REAPER_TTLS.staleAbandonMs. Three days
        // is a conservative abandon line; higher-priority canon atoms
        // tune it down for tighter SLAs.
        abandon_ms: 72 * 60 * 60 * 1000,
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/inbox-canon-policies.mjs so the
 * file-host round-trip and drift-check are identical across the two
 * bootstraps.
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
      source: { session_id: 'bootstrap-reaper', agent_id: 'bootstrap' },
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
