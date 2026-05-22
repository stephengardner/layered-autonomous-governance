// Shared policy-spec factory for bootstrap-cross-stage-reprompt-canon.mjs.
//
// Extracted into a lib module (no shebang, no top-level side effects)
// so drift tests in test/scripts can import the POLICIES payload and
// assert it matches the runtime reader (readCrossStageRePromptPolicy
// in src/runtime/planning-pipeline/cross-stage-reprompt-config.ts)
// without spawning Node.
//
// The bootstrap script at
// scripts/bootstrap-cross-stage-reprompt-canon.mjs imports
// buildPolicies + policyAtom from here; the script remains the CLI
// entry point and owns env/host side effects. Mirrors the convention
// established by scripts/lib/auditor-feedback-reprompt-canon-policies.mjs
// (PR #392) and scripts/lib/pipeline-reaper-canon-policies.mjs.
//
// The single policy atom seeded here ACTIVATES the planning-pipeline
// runner's cross-stage re-prompt path. Unlike the auditor-feedback
// policy (which falls through to a hardcoded floor when missing), the
// cross-stage gate stays DORMANT when its atom is absent so existing
// deployments do not silently change behavior on upgrade. Running
// this bootstrap is the deliberate operator decision to turn the
// feature on.

const BOOTSTRAP_TIME = '2026-05-22T00:00:00.000Z';

/**
 * Build the cross-stage-reprompt POLICIES spec list. Parameterized on
 * the operator principal id (signs the seed atom) but otherwise pure.
 *
 * Currently a single-atom set:
 * `pol-cross-stage-reprompt-default`. The atom id carries the
 * `-default` suffix so an org-ceiling deployment can land a
 * higher-priority pol-cross-stage-reprompt-<scope> atom (e.g.
 * pol-cross-stage-reprompt-strict with max_attempts=1 +
 * severities=['critical']) without superseding the default;
 * arbitration's source-rank formula resolves the higher-priority atom
 * first.
 *
 * Default shape:
 *   max_attempts=2: allows up to 2 cross-stage walks per pipeline run
 *   severities_to_reprompt=['critical']: only critical findings can
 *     trigger a walk; major + minor findings stay on the existing
 *     intra-stage path
 *   allowed_targets='derive-from-pipeline-composition': the runner
 *     derives the allowed-targets set from the active composition at
 *     startup (every non-terminal stage in the composition); narrowing
 *     to a smaller surface is a deliberate canon edit via
 *     pol-cross-stage-reprompt-<scope> with explicit string[].
 *
 * Asymmetric with auditor-feedback bootstrap: seeding this atom flips
 * the gate ON. The runner's HARDCODED_DEFAULT is NOT a fallback for a
 * missing atom; cross-stage routing only activates when the atom is
 * present.
 */
export function buildPolicies(_operatorId) {
  return [
    {
      id: 'pol-cross-stage-reprompt-default',
      subject: 'cross-stage-reprompt-default',
      reason:
        "Cross-stage re-prompt config for the deep planning pipeline. "
        + "When a stage's audit() returns a finding whose reprompt_target "
        + "cites an upstream stage AND the severity is in "
        + "severities_to_reprompt, the runner walks the pipeline back to "
        + "the target stage and re-invokes it with the finding folded into "
        + "priorAuditFindings, bounded at max_attempts walks. "
        + "Default max_attempts=2, severities_to_reprompt=['critical'], "
        + "allowed_targets=derive-from-pipeline-composition: a drafter "
        + "refusal in the dispatch stage can walk back to plan-stage with "
        + "the refusal notes, giving the plan-author a chance to repair "
        + "rather than halting the pipeline. Seeding this atom flips the "
        + "gate from dormant to active; the runner ignores reprompt_target "
        + "when the atom is absent. An org-ceiling deployment that wants "
        + "a stricter cap (max_attempts=1) or a narrower target surface "
        + "lands a higher-priority pol-cross-stage-reprompt-<scope> atom "
        + "via a deliberate canon edit.",
      fields: {
        // Up to 2 cross-stage walks per pipeline run. Matches the
        // runner's HARDCODED_DEFAULT in cross-stage-reprompt-config.ts;
        // running this bootstrap is the operator decision to activate
        // the gate at the default shape.
        max_attempts: 2,
        // Only critical findings trigger a cross-stage walk by default.
        // Below-floor findings carry their reprompt_target as advisory
        // metadata but route through the existing intra-stage path.
        severities_to_reprompt: ['critical'],
        // Sentinel that tells the runner to derive the allowed-targets
        // set from the active pipeline composition at startup. Every
        // stage except terminal stages is allowed as a target; the
        // runner separately enforces the "must be upstream of the
        // auditing stage" rule at decision time. Org-ceiling
        // deployments pass an explicit string[] to narrow.
        allowed_targets: 'derive-from-pipeline-composition',
      },
    },
  ];
}

/**
 * Build the L3 directive atom that the bootstrap script writes. Shape
 * mirrors policyAtom in scripts/lib/auditor-feedback-reprompt-canon-policies.mjs
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
      source: { session_id: 'bootstrap-cross-stage-reprompt', agent_id: 'bootstrap' },
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
