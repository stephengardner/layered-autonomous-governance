/**
 * Compromise taint propagation.
 *
 * When a principal is marked compromised (via PrincipalStore.markCompromised),
 * atoms they wrote at/after the compromise time are no longer trustworthy.
 * Every downstream atom (via `provenance.derived_from`) that transitively
 * sourced from one of those atoms inherits the taint.
 *
 * This module exposes a single entry point:
 *   propagateCompromiseTaint(host, principalId, responderId): Promise<TaintReport>
 *
 * Effect:
 *   - Direct: any atom where principal_id === principalId AND
 *     created_at >= principal.compromised_at becomes taint='tainted'.
 *   - Transitive: any atom whose derived_from chain reaches a tainted atom
 *     also becomes tainted. Iterated to fixpoint.
 *   - Side-effect-free on the principal record itself.
 *   - Every transition is logged as an audit event (kind='atom.tainted').
 *   - Idempotent: atoms already tainted/quarantined are left alone.
 *
 * What this does NOT do:
 *   - Delete or supersede atoms. Tainted atoms remain queryable (for audit).
 *   - Revoke canon. The canon generator filters taint !== 'clean' on render;
 *     next canon-applier pass naturally expunges tainted entries.
 *   - Untaint: a separate operation, not provided here. Taint propagation
 *     is fail-safe; a false-positive compromise should be un-marked on the
 *     principal, and tainted atoms re-examined manually.
 */

import type { Host } from '../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../types.js';
import { NotFoundError } from '../errors.js';

export interface TaintReport {
  readonly principalId: PrincipalId;
  /**
   * When the principal was marked compromised. Null when the principal
   * is not compromised (the function returns early with this shape so
   * callers can distinguish "no work to do" from "zero atoms were
   * reachable"). Previously synthesised as `'' as Time` for the early
   * return, which type-lied a valid ISO timestamp.
   */
  readonly compromisedAt: Time | null;
  /** Atoms newly transitioned clean -> tainted. */
  readonly atomsTainted: number;
  /** Total atoms inspected across all iterations. */
  readonly atomsScanned: number;
  /** Fixpoint iteration count (1 = no transitive propagation needed). */
  readonly iterations: number;
  /** Set of atom IDs that transitioned during this invocation. */
  readonly taintedAtomIds: ReadonlyArray<AtomId>;
}

export interface PropagateOptions {
  /**
   * Max iterations for transitive propagation. Safety ceiling; real graphs
   * should converge in a handful of passes. Default 20.
   */
  readonly maxIterations?: number;
  /** Page size when scanning atoms. Default 10_000. */
  readonly pageSize?: number;
}

export async function propagateCompromiseTaint(
  host: Host,
  principalId: PrincipalId,
  responderId: PrincipalId,
  options: PropagateOptions = {},
): Promise<TaintReport> {
  const maxIterations = options.maxIterations ?? 20;
  const pageSize = options.pageSize ?? 10_000;
  // Validate budgets: non-finite, non-integer, or non-positive values
  // break the pagination / fixpoint loops. Fail at entry, not silently
  // later inside the scan.
  if (
    !Number.isFinite(maxIterations)
    || !Number.isInteger(maxIterations)
    || maxIterations <= 0
  ) {
    throw new Error(
      '[taint/propagate] maxIterations must be a finite positive integer',
    );
  }
  if (
    !Number.isFinite(pageSize)
    || !Number.isInteger(pageSize)
    || pageSize <= 0
  ) {
    throw new Error(
      '[taint/propagate] pageSize must be a finite positive integer',
    );
  }

  const principal = await host.principals.get(principalId);
  if (!principal) {
    throw new NotFoundError(`Principal ${String(principalId)} not found`);
  }
  if (principal.compromised_at === null) {
    // Nothing to do; principal is not marked compromised.
    return {
      principalId,
      compromisedAt: null,
      atomsTainted: 0,
      atomsScanned: 0,
      iterations: 0,
      taintedAtomIds: [],
    };
  }
  const compromisedAt = principal.compromised_at;

  // Split the set semantics so reruns are idempotent:
  // - reachableTaintedIds: every tainted atom the scan sees (including
  //   already-tainted ones from prior partial runs). Used to drive
  //   transitive propagation so a clean descendant of a partially-
  //   tainted ancestor is still caught on rerun.
  // - newlyTaintedIds: atoms this invocation transitioned clean ->
  //   tainted. This is what we report in the TaintReport so the
  //   "idempotent: rerun produces zero new transitions" contract holds.
  const reachableTaintedIds = new Set<AtomId>();
  const newlyTaintedIds = new Set<AtomId>();
  let atomsScanned = 0;
  let iterations = 0;

  // --- Iteration 0: direct taints from the compromised principal ----------
  // Paginate through EVERY atom authored by the compromised principal.
  // AtomStore.query is cursor-paginated, so only reading the first page
  // would leave atoms past pageSize silently clean - a false negative
  // with taint-leak consequences. Also add an explicit in-code
  // principal_id check because AtomFilter enforcement varies across
  // adapters (some ignore filters); belt + suspenders.
  iterations += 1;
  {
    let cursor: string | undefined = undefined;
    for (;;) {
      const page = await host.atoms.query(
        { principal_id: [principalId], superseded: true },
        pageSize,
        cursor,
      );
      atomsScanned += page.atoms.length;
      for (const atom of page.atoms) {
        if (atom.principal_id !== principalId) continue; // filter-defence guard
        if (atom.created_at < compromisedAt) continue; // written before compromise
        if (atom.taint !== 'clean') {
          // Already tainted/quarantined from a prior partial run - still
          // seed it so transitive propagation continues from here. A clean
          // descendant authored by a different principal after a partial
          // run would otherwise be missed on rerun. Do NOT add to
          // newlyTaintedIds - no new transition happened.
          reachableTaintedIds.add(atom.id);
          continue;
        }
        await applyTaint(host, atom, principalId, responderId, 'direct');
        reachableTaintedIds.add(atom.id);
        newlyTaintedIds.add(atom.id);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }

  // --- Iterate transitive propagation to fixpoint -------------------------
  // `lastNewlyTainted` captures the progress count of the most recent
  // iteration. If we exit because the fixpoint converged, this is 0. If
  // we exit because we hit the safety ceiling WHILE still making
  // progress, it is > 0 - a taint leak with no obvious signal to the
  // operator. Audit the ceiling hit so governance reviewers can see
  // the event.
  let lastNewlyTainted = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    let newlyTainted = 0;
    // Scan all atoms, paginating through EVERY page. For the V0 scale
    // this is fine; a derived_from -> atom_id index on the AtomStore is
    // the natural next step when atom volume grows.
    let cursor: string | undefined = undefined;
    for (;;) {
      const page = await host.atoms.query({ superseded: true }, pageSize, cursor);
      atomsScanned += page.atoms.length;
      for (const atom of page.atoms) {
        if (atom.provenance.derived_from.length === 0) continue;
        const sourcesTainted = atom.provenance.derived_from.some(id =>
          reachableTaintedIds.has(id),
        );
        if (!sourcesTainted) continue;
        if (atom.taint !== 'clean') {
          // Already tainted; still track the id so a further descendant
          // off this atom continues to propagate in the next iteration.
          // Do NOT add to newlyTaintedIds - no transition happened.
          if (!reachableTaintedIds.has(atom.id)) {
            reachableTaintedIds.add(atom.id);
            newlyTainted += 1; // new source-of-propagation this iteration
          }
          continue;
        }
        await applyTaint(host, atom, principalId, responderId, 'transitive');
        reachableTaintedIds.add(atom.id);
        newlyTaintedIds.add(atom.id);
        newlyTainted += 1;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    lastNewlyTainted = newlyTainted;
    if (newlyTainted === 0) break;
  }

  // Ceiling hit while still making progress is a governance gap: the
  // returned report would otherwise look identical to a clean
  // convergence, hiding a taint leak. Surface via the auditor so it
  // shows up in the audit log and reflection hooks.
  if (iterations >= maxIterations && lastNewlyTainted > 0) {
    await host.auditor.log({
      kind: 'taint.propagate.ceiling_hit',
      principal_id: responderId,
      timestamp: host.clock.now() as Time,
      refs: { atom_ids: [...newlyTaintedIds] },
      details: {
        principal_id_compromised: principalId,
        max_iterations: maxIterations,
        iterations,
        last_newly_tainted: lastNewlyTainted,
      },
    });
  }

  return {
    principalId,
    compromisedAt,
    // "atomsTainted" reports transitions this run, not the total reachable
    // tainted set. Idempotency contract: a rerun with nothing new to
    // transition returns 0 here.
    atomsTainted: newlyTaintedIds.size,
    atomsScanned,
    iterations,
    taintedAtomIds: Object.freeze([...newlyTaintedIds]),
  };
}

async function applyTaint(
  host: Host,
  atom: Atom,
  triggerPrincipal: PrincipalId,
  responderId: PrincipalId,
  mode: 'direct' | 'transitive',
): Promise<void> {
  // Re-read the atom right before patching. The scan captured an atom
  // snapshot; between capture and this update, a concurrent compromise
  // cascade (or manual operator action) may have already set taint to
  // 'quarantined' or 'tainted'. Overwriting 'quarantined' with 'tainted'
  // is a silent downgrade - quarantined is strictly stronger than
  // tainted. Check current state and skip or refine the patch.
  const fresh = await host.atoms.get(atom.id);
  if (!fresh) return; // atom vanished between scan and update; nothing to do.
  if (fresh.taint === 'quarantined') return; // don't downgrade
  if (fresh.taint === 'tainted' && atom.taint === 'tainted') return; // no-op; audit already written by earlier run
  await host.atoms.update(atom.id, { taint: 'tainted' });
  // The "every transition is logged" invariant needs the audit write
  // to succeed; if the auditor throws, the atom is now tainted in the
  // store but no audit record exists. Try-catch + best-effort rollback
  // would be heavier than the primitive warrants. Instead, let the
  // auditor error propagate so the CALLER knows the transition's audit
  // trail is broken - the caller decides whether to re-audit or mark
  // the taint pass as partial.
  await host.auditor.log({
    kind: 'atom.tainted',
    principal_id: responderId,
    timestamp: host.clock.now() as Time,
    refs: { atom_ids: [atom.id] },
    details: {
      mode,
      trigger_principal: triggerPrincipal,
      prior_taint: fresh.taint,
      atom_layer: fresh.layer,
      atom_type: fresh.type,
      atom_principal: fresh.principal_id,
    },
  });
}
