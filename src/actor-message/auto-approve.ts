/**
 * Auto-approve low-stakes proposed plans.
 *
 * Scans `plan` atoms in state `proposed` and transitions qualifying
 * ones to `approved` in-place, so the plan-dispatch loop (PR E) can
 * pick them up. The qualifying filter is read from a policy atom
 * (pol-plan-auto-approve-low-stakes) so tuning is a canon edit,
 * never a framework release.
 *
 * Default qualification rules:
 * - Plan's metadata.planning_actor_version is present (sanity: only
 *   plans produced by a recognized planner are auto-approved).
 * - Plan's metadata.delegation.sub_actor_principal_id is in the
 *   allowlist (default: ['auditor-actor']; read-only actors only).
 * - Plan's confidence >= min_confidence (default 0.55).
 * - Plan is not tainted, not superseded.
 *
 * Fails closed: if the policy atom is missing, tainted, or
 * superseded, NO auto-approvals happen. Everything stays in
 * 'proposed' awaiting manual operator approval. Same discipline as
 * the other policy reads in this module.
 */

import type { Host } from '../interface.js';
import type { Atom, Time } from '../types.js';

export interface AutoApprovePolicyConfig {
  /**
   * Sub-actor principal ids allowed to auto-approve when the plan's
   * delegation targets them. The v0 default is 'auditor-actor' only
   * (read-only, no mutation). Other read-only actors can be added
   * via canon edit.
   */
  readonly allowed_sub_actors: ReadonlyArray<string>;
  /** Minimum plan confidence for auto-approval. */
  readonly min_confidence: number;
}

/**
 * Fail-closed default: empty allowlist + high confidence threshold.
 * Deployments that do not seed pol-plan-auto-approve-low-stakes get
 * zero auto-approvals by default; every plan waits for manual
 * operator approval.
 */
export const FALLBACK_AUTO_APPROVE: AutoApprovePolicyConfig = Object.freeze({
  allowed_sub_actors: [],
  min_confidence: 0.55,
});

export interface AutoApproveTickResult {
  readonly scanned: number;
  readonly approved: number;
}

/**
 * One sweep over proposed plans. Each plan that passes the filter
 * is transitioned to 'approved'. Returns counts for observability.
 *
 * Not idempotent on a per-plan basis (a plan already 'approved'
 * doesn't re-approve), but idempotent on re-run (the filter drops
 * non-proposed plans).
 */
export async function runAutoApprovePass(
  host: Host,
  options: { readonly now?: () => number } = {},
): Promise<AutoApproveTickResult> {
  const policy = await readAutoApprovePolicy(host);
  // Fail-closed short-circuit: if no sub-actors are allowed, no plan
  // can qualify. Skip the scan.
  if (policy.allowed_sub_actors.length === 0) {
    return { scanned: 0, approved: 0 };
  }

  const now = options.now ?? (() => Date.now());
  const page = await host.atoms.query({ type: ['plan'] }, 500);
  const candidates = page.atoms.filter((atom) => {
    if (atom.taint !== 'clean') return false;
    if (atom.superseded_by.length > 0) return false;
    if (atom.plan_state !== 'proposed') return false;
    if (atom.confidence < policy.min_confidence) return false;
    const version = (atom.metadata as Record<string, unknown>)?.planning_actor_version;
    if (typeof version !== 'string' || version.length === 0) return false;
    const delegation = (atom.metadata as Record<string, unknown>)?.delegation as
      | Record<string, unknown>
      | undefined;
    if (!delegation) return false;
    const targetRaw = delegation.sub_actor_principal_id;
    if (typeof targetRaw !== 'string') return false;
    return policy.allowed_sub_actors.includes(targetRaw);
  });

  for (const plan of candidates) {
    await host.atoms.update(plan.id, {
      plan_state: 'approved',
      metadata: {
        auto_approved: {
          at: new Date(now()).toISOString() as Time,
          via: 'pol-plan-auto-approve-low-stakes',
        },
      },
    });
  }

  return { scanned: candidates.length, approved: candidates.length };
}

async function readAutoApprovePolicy(host: Host): Promise<AutoApprovePolicyConfig> {
  const page = await host.atoms.query({ type: ['directive'], layer: ['L3'] }, 200);
  for (const atom of page.atoms) {
    if (atom.taint !== 'clean') continue;
    if (atom.superseded_by.length > 0) continue;
    const policy = (atom.metadata as Record<string, unknown>)?.policy as
      | Record<string, unknown>
      | undefined;
    if (policy?.subject !== 'plan-auto-approve-low-stakes') continue;

    const allowedRaw = policy.allowed_sub_actors;
    const minConfRaw = Number(policy.min_confidence);
    const allowed = Array.isArray(allowedRaw)
      ? allowedRaw.filter((v): v is string => typeof v === 'string')
      : [];
    const minConfidence = Number.isFinite(minConfRaw) && minConfRaw >= 0 && minConfRaw <= 1
      ? minConfRaw
      : FALLBACK_AUTO_APPROVE.min_confidence;

    return {
      allowed_sub_actors: allowed,
      min_confidence: minConfidence,
    };
  }
  return FALLBACK_AUTO_APPROVE;
}
