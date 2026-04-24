/**
 * Plan-state writeback on PR merge.
 *
 * A plan that drove a PR stays at plan_state='executing' (or
 * 'approved' if it skipped dispatch) indefinitely because nothing
 * transitions it after the PR lands. This pass closes that loop: it
 * scans pr-observation atoms (written by PrLandingActor on observe)
 * whose merge_state_status is terminal ('merged' | 'closed'),
 * resolves the originating Plan via metadata.plan_id, and transitions
 * the Plan to 'succeeded' (merged) or 'abandoned' (closed).
 *
 * Claim-before-mutate via deterministic marker id
 * -----------------------------------------------
 * Two workers observing the same pr-observation would both read "no
 * marker" and both transition the Plan + both log. AtomStore does
 * not expose a general compare-and-swap, so the reconciler writes a
 * plan-merge-settled atom with a deterministic id computed from
 * sha256(plan_id + '|' + pr_observation_id). host.atoms.put rejects
 * duplicate ids; the first worker to write wins and subsequent
 * workers skip on the duplicate-id error. This turns the marker into
 * a mutual-exclusion claim, identical to the pattern runDispatchTick
 * uses for plan-state claims.
 *
 * Guards (in-code, per the spec's design principle on adapter-
 * dependent query predicates):
 *   - pr-observation: type === 'observation' && metadata.kind ===
 *     'pr-observation' && taint === 'clean' && superseded_by is
 *     empty && merge_state_status in TERMINAL_STATES.
 *   - Plan: taint === 'clean' && superseded_by is empty &&
 *     plan_state in {'executing', 'approved'}. 'approved' covers the
 *     rare case where dispatch was skipped and a PR was opened
 *     directly from the approved plan (operator-executed or
 *     externally-triggered merge).
 *
 * Idempotent: re-running the tick on already-settled observations is
 * a no-op (claim fails via duplicate id). Marker atom serves as the
 * historical record; callers inspecting the atom store see
 * Plan -> pr-observation -> plan-merge-settled linked via
 * provenance.derived_from for the full audit trail.
 */

import { createHash } from 'node:crypto';

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PlanState, Time } from '../../types.js';

/** Terminal PR states that trigger a Plan transition. */
const TERMINAL_MERGE_STATES: ReadonlySet<string> = new Set(['merged', 'closed']);

/**
 * Plan states the reconciler is willing to transition from. Broader
 * than runDispatchTick (which only expects 'approved') because a
 * merge observation can arrive after dispatch has already happened
 * (plan_state='executing') or before (rare: plan_state='approved').
 */
const RECONCILABLE_PLAN_STATES: ReadonlySet<PlanState> = new Set<PlanState>([
  'executing',
  'approved',
]);

export interface PlanReconcileTickResult {
  /** pr-observation atoms inspected this tick. */
  readonly scanned: number;
  /** Observations with a parseable terminal merge-state + plan_id linkage. */
  readonly matched: number;
  /** Plan atoms actually transitioned this tick (succeeded | abandoned). */
  readonly transitioned: number;
  /** Observations skipped because another worker already claimed. */
  readonly claimConflicts: number;
}

export interface PlanReconcileTickOptions {
  readonly now?: () => string | Time | number;
  /** Upper bound on pr-observation atoms scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
}

export async function runPlanStateReconcileTick(
  host: Host,
  options: PlanReconcileTickOptions = {},
): Promise<PlanReconcileTickResult> {
  const nowFn = options.now ?? (() => new Date().toISOString());
  const nowIso = toIso(nowFn());

  const MAX_SCAN = options.maxScan ?? 5_000;
  const PAGE_SIZE = 500;
  let totalSeen = 0;
  let matched = 0;
  let transitioned = 0;
  let claimConflicts = 0;
  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - totalSeen;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['observation'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const obs of page.atoms) {
      totalSeen += 1;
      // In-code guards: query predicate is advisory.
      if (obs.taint !== 'clean') continue;
      if (obs.superseded_by.length > 0) continue;
      const meta = obs.metadata as Record<string, unknown>;
      if (meta['kind'] !== 'pr-observation') continue;
      const status = meta['merge_state_status'];
      if (typeof status !== 'string') continue;
      const terminal = status.toLowerCase();
      if (!TERMINAL_MERGE_STATES.has(terminal)) continue;
      const planIdRaw = meta['plan_id'];
      if (typeof planIdRaw !== 'string' || planIdRaw.length === 0) continue;
      matched += 1;

      // Claim step. Deterministic id means a second worker observing
      // the same pr-observation gets a duplicate-id error from
      // host.atoms.put and we treat that as "another worker already
      // claimed this transition; skip".
      const planId = planIdRaw as AtomId;
      const markerId = makeMarkerId(planId, obs.id);
      const targetState: PlanState = terminal === 'merged' ? 'succeeded' : 'abandoned';

      const prInfo = (meta['pr'] ?? {}) as Record<string, unknown>;

      let claimed = false;
      try {
        await host.atoms.put({
          schema_version: 1,
          id: markerId,
          content: `plan ${String(planId)} -> ${targetState} via PR merge observation ${String(obs.id)}`,
          type: 'plan-merge-settled',
          layer: 'L1',
          provenance: {
            kind: 'agent-observed',
            source: { agent_id: String(obs.principal_id), tool: 'pr-merge-reconcile' },
            derived_from: [planId, obs.id],
          },
          confidence: 1.0,
          created_at: nowIso as Time,
          last_reinforced_at: nowIso as Time,
          expires_at: null,
          supersedes: [],
          superseded_by: [],
          scope: obs.scope,
          signals: {
            agrees_with: [],
            conflicts_with: [],
            validation_status: 'unchecked',
            last_validated_at: null,
          },
          principal_id: obs.principal_id,
          taint: 'clean',
          metadata: {
            plan_id: String(planId),
            pr_observation_id: String(obs.id),
            merge_state_status: terminal,
            target_plan_state: targetState,
            settled_at: nowIso,
            pr: prInfo,
          },
        });
        claimed = true;
      } catch {
        // Duplicate-id error (another worker claimed) OR a write
        // failure. Either way, skip. The `claimConflicts` counter
        // distinguishes only the common case; a real storage error
        // would also show up as zero transitions, which is the safe
        // outcome.
        claimConflicts += 1;
        continue;
      }
      if (!claimed) continue;

      // Load the Plan after claim succeeded. Re-validate in-code so a
      // concurrent update that moved the plan out of a reconcilable
      // state between our last read and the claim is respected.
      const plan = await host.atoms.get(planId);
      if (plan === null) continue;
      if (plan.type !== 'plan') continue;
      if (plan.taint !== 'clean') continue;
      if (plan.superseded_by.length > 0) continue;
      const currentState = plan.plan_state;
      if (currentState === undefined) continue;
      if (!RECONCILABLE_PLAN_STATES.has(currentState)) continue;

      // State-machine bridging: approved -> succeeded is a two-hop
      // (approved -> executing -> succeeded) per
      // src/runtime/plans/state.ts's ALLOWED map. Both writes happen
      // inside the claim's critical section so no other worker can
      // observe an intermediate state for this PR-merge event. A
      // plan in 'executing' goes straight to the terminal state.
      if (targetState === 'succeeded' && currentState === 'approved') {
        await host.atoms.update(planId, { plan_state: 'executing' });
      }

      await host.atoms.update(planId, {
        plan_state: targetState,
        metadata: {
          merged_pr: prInfo,
          plan_state_reason: 'pr-merge-reconcile',
          plan_state_changed_at: nowIso,
          plan_merge_settled_id: String(markerId),
        },
      });

      await host.auditor.log({
        kind: targetState === 'succeeded' ? 'plan.state-reconciled-succeeded' : 'plan.state-reconciled-abandoned',
        principal_id: plan.principal_id,
        timestamp: nowIso as Time,
        refs: { atom_ids: [planId, obs.id, markerId] },
        details: {
          plan_id: String(planId),
          pr_observation_id: String(obs.id),
          from_state: currentState,
          to_state: targetState,
        },
      });
      transitioned += 1;
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  return { scanned: totalSeen, matched, transitioned, claimConflicts };
}

/**
 * Deterministic marker id: sha256(plan_id|pr_observation_id). Hex-
 * truncated to 16 chars for readability; collision probability across
 * a realistic atom store is negligible at that width.
 */
function makeMarkerId(planId: AtomId, observationId: AtomId): AtomId {
  const digest = createHash('sha256')
    .update(String(planId))
    .update('|')
    .update(String(observationId))
    .digest('hex')
    .slice(0, 16);
  return `plan-merge-settled-${digest}` as AtomId;
}

function toIso(value: string | Time | number): string {
  if (typeof value === 'string') return value;
  return new Date(value).toISOString();
}
