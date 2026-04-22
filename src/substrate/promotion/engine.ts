/**
 * Promotion engine.
 *
 * Two entry points:
 *   - `findCandidates(layer)`: scan the store at the source layer, group by
 *     content-hash, and build PromotionCandidate records with consensus +
 *     validation.
 *   - `promote(candidate, target)`: evaluate policy. If it passes, create a
 *     new atom at the target layer with provenance.kind='canon-promoted'
 *     and derived_from=[candidate.atom.id]; mark the original superseded;
 *     audit-log. L3 additionally requires human approval via Notifier.
 *
 * The new atom's id is a deterministic hash of (source atom id, target layer)
 * so repeated promote calls on the same candidate do not create duplicates.
 */

import { createHash } from 'node:crypto';
import type { Host } from '../interface.js';
import type {
  Atom,
  AtomId,
  AuditEvent,
  Event,
  PrincipalId,
  Time,
} from '../types.js';
import { ValidatorRegistry } from '../arbitration/validation.js';
import {
  DEFAULT_THRESHOLDS,
  sourceLayerFor,
  type PromotableLayer,
  type PromotionCandidate,
  type PromotionDecision,
  type PromotionOutcome,
  type PromotionThresholds,
} from './types.js';
import { evaluate } from './policy.js';

export interface PromotionEngineOptions {
  readonly principalId: PrincipalId;
  readonly thresholds?: PromotionThresholds;
  readonly validators?: ValidatorRegistry;
  /**
   * Escalation timeout for L3 human gate. Defaults to 250ms so the
   * L3 promotion path does not block a LoopRunner tick beyond its
   * documented tick cadence (see `LoopOptions.l3HumanGateTimeoutMs`
   * in `src/loop/types.ts`). A 60s default here stalled every tick
   * that hit an L3 candidate for 60s; callers with a longer human-
   * response SLA override this per-instance.
   */
  readonly humanGateTimeoutMs?: number;
}

const DEFAULT_GATE_TIMEOUT_MS = 250;

export class PromotionEngine {
  constructor(
    private readonly host: Host,
    private readonly options: PromotionEngineOptions,
  ) {
    // Validate humanGateTimeoutMs at construction so a bad value
    // surfaces here, not at the setInterval / awaitDisposition
    // deadline math later. NaN / Infinity / negative / non-integer
    // all produce unpredictable notifier behaviour.
    const t = options.humanGateTimeoutMs;
    if (
      t !== undefined
      && (typeof t !== 'number'
        || !Number.isFinite(t)
        || !Number.isInteger(t)
        || t <= 0)
    ) {
      throw new Error(
        '[promotion] humanGateTimeoutMs must be a finite positive integer (ms)',
      );
    }
  }

  /**
   * Build PromotionCandidates for every content-hash class at the source
   * layer. Returns one candidate per class (carrying the newest atom).
   */
  async findCandidates(
    targetLayer: PromotableLayer,
  ): Promise<PromotionCandidate[]> {
    const sourceLayer = sourceLayerFor(targetLayer);
    // Paginate: a 100_000 limit silently truncates large stores and
    // buffers the whole world in memory at once. Walk the cursor so
    // promotion reasons over every eligible atom.
    const PAGE = 1000;
    const byHash = new Map<string, Atom[]>();
    let cursor: string | undefined = undefined;
    do {
      const page = await this.host.atoms.query({ layer: [sourceLayer] }, PAGE, cursor);
      for (const atom of page.atoms) {
        // Fail-closed in-code guards: tainted or superseded atoms must
        // never promote, regardless of whether the adapter's AtomFilter
        // enforces these bits. AtomFilter enforcement varies; the
        // correctness floor is the in-code check here.
        if (atom.taint !== 'clean') continue;
        if (atom.superseded_by.length > 0) continue;
        const h = this.host.atoms.contentHash(atom.content);
        const arr = byHash.get(h) ?? [];
        arr.push(atom);
        byHash.set(h, arr);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const candidates: PromotionCandidate[] = [];
    for (const group of byHash.values()) {
      const sorted = [...group].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const newest = sorted[0];
      if (!newest) continue;
      const principals = new Set(group.map(a => a.principal_id));
      const validation = this.options.validators
        ? await this.options.validators.validate(newest, this.host)
        : 'unverifiable';
      candidates.push({
        atom: newest,
        consensusAtoms: Object.freeze(group),
        consensusCount: principals.size,
        validation,
      });
    }
    return candidates;
  }

  /**
   * Evaluate the candidate against policy, then apply if allowed.
   * For L3, the human gate is ALWAYS present in the code path
   * regardless of `thresholds.L3.requireHumanApproval`. That flag can
   * gate other promotion layers (e.g., tightening L2) but must not
   * elide the L3 gate: the top trust layer always traverses the
   * Notifier so the autonomy dial (auto-approve) can move without
   * removing the gate from the code path.
   */
  async promote(
    candidate: PromotionCandidate,
    targetLayer: PromotableLayer,
  ): Promise<PromotionOutcome> {
    const thresholds = this.options.thresholds ?? DEFAULT_THRESHOLDS;
    const decision = evaluate(candidate, targetLayer, thresholds);

    if (!decision.canPromote) {
      await this.auditRejected(decision, 'policy');
      return {
        decision,
        kind: 'rejected-by-policy',
        promotedAtomId: null,
        reason: decision.reasons.join('; '),
      };
    }

    const thr = targetLayer === 'L2' ? thresholds.L2 : thresholds.L3;
    // L3 always goes through the gate in the code path (canon);
    // other layers respect the per-layer `requireHumanApproval` flag.
    const requiresGate =
      targetLayer === 'L3' ? true : thr.requireHumanApproval === true;

    let effectiveDecision = decision;

    if (requiresGate) {
      const gate = await this.awaitHumanGate(decision);
      if (gate.kind !== 'promoted') {
        await this.auditGated(decision, gate);
        return gate;
      }
      // During the human-gate wait, the original consensus snapshot
      // can drift: atoms can become tainted (compromise cascade) or
      // superseded (another concurrent promotion), the representative
      // atom can disappear, or validators can flip the validation
      // verdict. Re-fetching only the representative atom - as an
      // earlier implementation did - missed drift in the REST of the
      // consensus set. Rebuild the candidate from the still-clean,
      // unsuperseded consensus atoms and re-run evaluate() so the
      // post-gate promotion uses the same policy machinery as
      // findCandidates.
      const rebuilt = await this.rebuildFreshDecision(decision, targetLayer, thresholds);
      if (rebuilt.kind === 'rebuilt') {
        effectiveDecision = rebuilt.decision;
      } else {
        const gateReject: PromotionOutcome = {
          decision,
          kind: 'rejected-by-policy',
          promotedAtomId: null,
          reason: rebuilt.reason,
        };
        await this.auditGated(decision, gateReject);
        return gateReject;
      }
    }

    const newAtomId = await this.applyPromotion(effectiveDecision);
    await this.auditPromoted(effectiveDecision, newAtomId);
    return {
      decision: effectiveDecision,
      kind: 'promoted',
      promotedAtomId: newAtomId,
      reason: 'all policy and gates satisfied',
    };
  }

  /**
   * Re-fetch every consensus atom and re-run evaluate() after a human
   * gate has resolved. Returns `{ kind: 'rebuilt', decision }` with a
   * fresh PromotionDecision if the consensus still satisfies policy
   * at the target layer, or `{ kind: 'rejected', reason }` if the
   * consensus has shrunk, the representative has vanished, or the
   * evaluation now fails (e.g., validators flipped, consensus dropped
   * below threshold, confidence degraded).
   */
  private async rebuildFreshDecision(
    decision: PromotionDecision,
    targetLayer: PromotableLayer,
    thresholds: PromotionThresholds,
  ): Promise<
    | { kind: 'rebuilt'; decision: PromotionDecision }
    | { kind: 'rejected'; reason: string }
  > {
    const originalSource = sourceLayerFor(targetLayer);
    const fetched = await Promise.all(
      decision.candidate.consensusAtoms.map(a => this.host.atoms.get(a.id)),
    );
    const freshAtoms: Atom[] = [];
    for (const a of fetched) {
      if (!a) continue;
      if (a.layer !== originalSource) continue;
      if (a.taint !== 'clean') continue;
      if (a.superseded_by.length > 0) continue;
      freshAtoms.push(a);
    }
    if (freshAtoms.length === 0) {
      return {
        kind: 'rejected',
        reason: 'all consensus atoms became ineligible during human gate',
      };
    }
    // Representative: prefer the original if it survived, else pick
    // the newest remaining atom so the new-id hash remains well-defined.
    const repId = decision.candidate.atom.id;
    const repSurvived = freshAtoms.find(a => a.id === repId) ?? null;
    const newest = [...freshAtoms].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )[0];
    const representative = repSurvived ?? newest!;
    const principals = new Set(freshAtoms.map(a => a.principal_id));
    const validation = this.options.validators
      ? await this.options.validators.validate(representative, this.host)
      : 'unverifiable';
    const freshCandidate: PromotionCandidate = {
      atom: representative,
      consensusAtoms: Object.freeze(freshAtoms),
      consensusCount: principals.size,
      validation,
    };
    const freshDecision = evaluate(freshCandidate, targetLayer, thresholds);
    if (!freshDecision.canPromote) {
      return {
        kind: 'rejected',
        reason: `consensus no longer satisfies policy after human gate: ${freshDecision.reasons.join('; ')}`,
      };
    }
    return { kind: 'rebuilt', decision: freshDecision };
  }

  /**
   * Convenience: find candidates and promote each that passes policy.
   * Returns outcomes in the order attempted.
   */
  async runPass(targetLayer: PromotableLayer): Promise<PromotionOutcome[]> {
    const cands = await this.findCandidates(targetLayer);
    const out: PromotionOutcome[] = [];
    for (const c of cands) {
      out.push(await this.promote(c, targetLayer));
    }
    return out;
  }

  // ---- Private ----

  private async awaitHumanGate(
    decision: PromotionDecision,
  ): Promise<PromotionOutcome> {
    const timeoutMs = this.options.humanGateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const event: Event = {
      kind: 'proposal',
      severity: 'info',
      summary: `Promote ${String(decision.candidate.atom.id)} to ${decision.targetLayer}`,
      body:
        `Candidate content: ${decision.candidate.atom.content}\n\n` +
        `Source layer: ${decision.candidate.atom.layer}\n` +
        `Consensus: ${decision.candidate.consensusCount} principals\n` +
        `Validation: ${decision.candidate.validation}\n\n` +
        `Approve (A promoted), reject (no promotion), ignore/timeout (no promotion).`,
      atom_refs: [decision.candidate.atom.id],
      principal_id: this.options.principalId,
      created_at: this.host.clock.now(),
    };
    const handle = await this.host.notifier.telegraph(event, null, 'timeout', timeoutMs);
    const disp = await this.host.notifier.awaitDisposition(handle, timeoutMs);
    if (disp === 'approve') {
      return {
        decision,
        kind: 'promoted',
        promotedAtomId: null, // filled by caller after applyPromotion
        reason: 'human approved',
      };
    }
    if (disp === 'reject') {
      return {
        decision,
        kind: 'rejected-by-human',
        promotedAtomId: null,
        reason: 'human rejected',
      };
    }
    return {
      decision,
      kind: 'timed-out-awaiting-human',
      promotedAtomId: null,
      reason: `disposition ${disp}`,
    };
  }

  /**
   * Create the promoted atom at target layer and mark all consensus
   * source atoms superseded. Deterministic ids prevent duplicate
   * promotions on re-run.
   *
   * Superseding every consensus atom (not just the representative) is
   * required: otherwise the remaining clean consensus atoms stay
   * eligible at the source layer, and a later tick can pick a
   * DIFFERENT representative from the same content-hash class and
   * re-promote the identical content under a different source-derived
   * id. Membership-guarded per-atom updates keep the AtomPatch-append
   * contract idempotent.
   */
  private async applyPromotion(decision: PromotionDecision): Promise<AtomId> {
    const src = decision.candidate.atom;
    // Dedupe consensus ids (they are by definition the same-content
    // group but the scanner shouldn't guarantee uniqueness).
    const sourceIds: ReadonlyArray<AtomId> = Object.freeze([
      ...new Set(decision.candidate.consensusAtoms.map(a => a.id)),
    ]);
    const newId = createHash('sha256')
      .update(String(src.id), 'utf8')
      .update('|->|', 'utf8')
      .update(decision.targetLayer, 'utf8')
      .digest('hex')
      .slice(0, 24) as AtomId;

    // Idempotent: if already promoted, repair every source atom's
    // superseded_by link if a prior partial run created the promoted
    // atom but didn't get to the updates. The membership check keeps
    // the AtomPatch-append contract idempotent (same fix as
    // arbitration.applyDecision). AtomPatch.superseded_by is APPEND
    // by the adapter contract (see AtomPatch JSDoc in types.ts and
    // MemoryAtomStore.update), so `{ superseded_by: [newId] }`
    // results in `existing.superseded_by ++ [newId]`; a concurrent
    // write that appended its own id is preserved.
    const existing = await this.host.atoms.get(newId);
    if (existing) {
      for (const sourceId of sourceIds) {
        const sourceNow = await this.host.atoms.get(sourceId);
        if (sourceNow && !sourceNow.superseded_by.includes(newId)) {
          await this.host.atoms.update(sourceId, { superseded_by: [newId] });
        }
      }
      return newId;
    }

    const now = this.host.clock.now();
    const promoted: Atom = {
      schema_version: src.schema_version,
      id: newId,
      content: src.content,
      type: src.type,
      layer: decision.targetLayer,
      provenance: {
        kind: 'canon-promoted',
        source: src.provenance.source,
        derived_from: sourceIds,
      },
      confidence: src.confidence,
      created_at: now as Time,
      last_reinforced_at: now as Time,
      expires_at: src.expires_at,
      supersedes: sourceIds,
      superseded_by: Object.freeze([]),
      scope: src.scope,
      signals: {
        agrees_with: src.signals.agrees_with,
        conflicts_with: src.signals.conflicts_with,
        validation_status: decision.candidate.validation === 'verified'
          ? 'verified'
          : src.signals.validation_status,
        last_validated_at: src.signals.last_validated_at,
      },
      principal_id: this.options.principalId,
      taint: 'clean',
      metadata: {
        ...src.metadata,
        promoted_from: String(src.id),
        promoted_at: now,
        consensus_count: decision.candidate.consensusCount,
        consensus_atom_ids: decision.candidate.consensusAtoms.map(a => String(a.id)),
      },
    };

    await this.host.atoms.put(promoted);
    // AtomPatch.superseded_by is APPEND-by-adapter-contract (see JSDoc
    // in types.ts, verified in MemoryAtomStore.update). Passing
    // `[newId]` results in each source's array being extended with
    // newId; a concurrent arbitration winner or second promotion
    // target that also appended is preserved. No overwrite risk.
    for (const sourceId of sourceIds) {
      const sourceNow = await this.host.atoms.get(sourceId);
      if (sourceNow && !sourceNow.superseded_by.includes(newId)) {
        await this.host.atoms.update(sourceId, { superseded_by: [newId] });
      }
    }
    return newId;
  }

  private async auditRejected(
    decision: PromotionDecision,
    cause: 'policy' | 'human',
  ): Promise<void> {
    const event: AuditEvent = {
      kind: `promotion.rejected.${cause}`,
      principal_id: this.options.principalId,
      timestamp: this.host.clock.now() as Time,
      refs: { atom_ids: [decision.candidate.atom.id] },
      details: {
        target_layer: decision.targetLayer,
        reasons: [...decision.reasons],
        consensus_count: decision.candidate.consensusCount,
        validation: decision.candidate.validation,
      },
    };
    await this.host.auditor.log(event);
  }

  private async auditGated(
    decision: PromotionDecision,
    gate: PromotionOutcome,
  ): Promise<void> {
    const event: AuditEvent = {
      kind: `promotion.gated.${gate.kind}`,
      principal_id: this.options.principalId,
      timestamp: this.host.clock.now() as Time,
      refs: { atom_ids: [decision.candidate.atom.id] },
      details: {
        target_layer: decision.targetLayer,
        reason: gate.reason,
      },
    };
    await this.host.auditor.log(event);
  }

  private async auditPromoted(
    decision: PromotionDecision,
    newAtomId: AtomId,
  ): Promise<void> {
    const event: AuditEvent = {
      kind: 'promotion.applied',
      principal_id: this.options.principalId,
      timestamp: this.host.clock.now() as Time,
      refs: { atom_ids: [decision.candidate.atom.id, newAtomId] },
      details: {
        target_layer: decision.targetLayer,
        consensus_count: decision.candidate.consensusCount,
        validation: decision.candidate.validation,
      },
    };
    await this.host.auditor.log(event);
  }
}

export { DEFAULT_THRESHOLDS, evaluate };
export type {
  PromotableLayer,
  PromotionCandidate,
  PromotionDecision,
  PromotionOutcome,
  PromotionThresholds,
};
