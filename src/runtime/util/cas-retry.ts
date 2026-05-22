/**
 * Shared CAS retry helper.
 *
 * Wraps a read-modify-write against an atom in a bounded retry loop so
 * runtime callers can consume the AtomStore's `expectedRevision`
 * compare-and-swap primitive without each call site reimplementing the
 * retry posture.
 *
 * The mutator returns an `AtomPatch` derived from the freshly-read atom.
 * The helper:
 *
 *   1. Reads the atom via `host.atoms.get`.
 *   2. Calls the mutator with the atom; mutator returns `null` to
 *      indicate "no mutation needed" (the helper then returns null).
 *   3. Submits `host.atoms.update(id, { ...patch, expectedRevision })`
 *      with the read-time revision stamped on the patch.
 *   4. On `ConflictError` from a strict adapter, re-reads and retries
 *      up to `maxRetries` (default 1) before surfacing the error.
 *      Best-effort adapters do not produce cross-process ConflictError;
 *      a same-process ConflictError still triggers the retry path
 *      because the helper cannot distinguish the two without inspecting
 *      the capability bit, and the retry posture is correct in both
 *      cases.
 *   5. On `NotFoundError` (the atom vanished between read and write),
 *      the helper returns null so the caller can short-circuit cleanly.
 *
 * The capability bit `host.atoms.capabilities?.hasStrictCrossProcessCas`
 * is consulted by the caller, not the helper: a caller that wants to
 * warn-and-proceed on best-effort adapters routes around this helper
 * (the runtime call sites that adopt CAS today all WANT the retry
 * posture; warn-and-proceed sites stay direct and document the skip
 * in JSDoc).
 *
 * The helper is intentionally narrow: one atom, one mutator, one
 * retry budget. Batch CAS is not supported (the substrate rejects
 * `expectedRevision` on batchUpdate; consumers split into per-atom
 * loops).
 */

import { ConflictError, NotFoundError } from '../../substrate/errors.js';
import type { Host } from '../../substrate/interface.js';
import type { Atom, AtomId, AtomPatch } from '../../substrate/types.js';

/**
 * Mutator function: given the freshly-read atom, decide whether to
 * mutate and what the patch should be. Return null to indicate "no
 * mutation needed" (the read showed the atom is no longer eligible,
 * the prior state already matches, etc.); the helper returns null in
 * turn so the caller can short-circuit.
 *
 * The mutator MUST NOT itself call `host.atoms.update`; the helper
 * owns the write so the CAS guard is consistently applied.
 *
 * The mutator MAY be async (e.g. it reads additional atoms to compute
 * the patch). The helper awaits the result.
 */
export type CasMutator = (atom: Atom) => AtomPatch | null | Promise<AtomPatch | null>;

export interface RunWithCasOptions {
  /**
   * Maximum number of retries after a ConflictError. Default 1: the
   * caller sees ONE re-read attempt before the error surfaces. A
   * higher value trades latency for resilience against high-contention
   * races; the default matches the substrate contract (single retry is
   * enough for the common two-writer race and prevents an unbounded
   * spin under pathological contention).
   */
  readonly maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 1;

export interface RunWithCasResult {
  readonly atom: Atom;
  readonly retries: number;
}

/**
 * Read-modify-write an atom under CAS protection.
 *
 * Returns the updated atom + how many retries it took (0 = first
 * attempt succeeded), or null when the mutator declined to mutate or
 * the atom vanished between read and write.
 *
 * The caller MUST handle the null return; the helper does not throw
 * on "not eligible" because the caller's eligibility check is the
 * primary signal and the helper's null is the secondary one.
 *
 * Surfaces ConflictError to the caller after exhausting maxRetries
 * so the caller's outer loop (a tick re-runs from candidate
 * collection, an explicit escalation atom is written, etc.) decides
 * how to respond.
 */
export async function runWithCas(
  host: Host,
  atomId: AtomId,
  mutator: CasMutator,
  opts?: RunWithCasOptions,
): Promise<RunWithCasResult | null> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  // Validate the retry budget at the boundary so a caller that
  // passes NaN, a negative value, or a non-integer cannot disable
  // the escape check and turn an in-process retry into an
  // unbounded ConflictError spin. Relational comparisons against
  // NaN are always false, so `retries >= NaN` would loop forever
  // without this guard.
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError(
      `runWithCas: maxRetries must be a non-negative integer (got ${String(maxRetries)})`,
    );
  }
  let retries = 0;
  while (true) {
    const atom = await host.atoms.get(atomId);
    if (atom === null) return null;
    const patch = await mutator(atom);
    if (patch === null) return null;
    try {
      const updated = await host.atoms.update(atomId, {
        ...patch,
        expectedRevision: atom.revision ?? 0,
      });
      return { atom: updated, retries };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      if (!(err instanceof ConflictError)) throw err;
      if (retries >= maxRetries) throw err;
      retries += 1;
      // Re-loop: fresh read, fresh patch, fresh CAS submission.
    }
  }
}
