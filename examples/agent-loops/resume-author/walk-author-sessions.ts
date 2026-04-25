/**
 * Example-level helper that walks the pr-fix-actor's observation chain
 * to assemble a list of candidate sessions for resume-author strategies.
 *
 * pr-fix-actor writes observation atoms shaped:
 *   - `type: 'observation'`, `metadata.kind: 'pr-fix-observation'`
 *   - PR identity under `metadata.pr_fix_observation.{pr_owner, pr_repo, pr_number}`
 *   - `dispatched_session_atom_id` patched onto
 *     `metadata.pr_fix_observation` AFTER the corresponding agent-loop
 *     run lands (via `host.atoms.update`); the field is absent on
 *     fresh first-iteration observations.
 *   - `provenance.derived_from[0]` points at the prior observation atom
 *     for the same PR (prepended at write time by the actor's atom
 *     builder), so a chronological walk follows that pointer back.
 *
 * The walk:
 *   1. Reads the starting observation; bails (returns []) if missing or
 *      if it does not carry the pr-fix-observation metadata shape.
 *   2. Pins on the starting observation's PR identity (owner + repo +
 *      number). Subsequent observations whose PR identity does not
 *      match are NOT followed -- multi-tenancy at scale shares one
 *      atom store across many PRs, so cross-PR linkage MUST stop here.
 *   3. For each observation visited, if `dispatched_session_atom_id` is
 *      set, fetches the agent-session atom and extracts:
 *        - `metadata.agent_session.adapter_id`
 *        - `metadata.agent_session.started_at`
 *        - `metadata.agent_session.extra.resumable_session_id`
 *      Sessions whose `extra.resumable_session_id` is missing or empty
 *      are SKIPPED (legacy sessions predating the resume-author capture
 *      hook); the walk does not throw on them.
 *   4. Walks via `provenance.derived_from[0]` to the prior observation.
 *      A `Set<AtomId>` cycle guard short-circuits any accidental
 *      back-pointer loop so the walk always terminates.
 *
 * This helper is intentionally pr-fix-specific: future actors with
 * different observation/iteration chain shapes (e.g. an auditor-actor
 * walking audit-event chains) write their own walkers and pass the
 * result to the same `assembleCandidates` slot on the wrapper. The
 * wrapper itself does not interpret atoms.
 */

import type { Atom, AtomId } from '../../../src/substrate/types.js';
import type { Host } from '../../../src/substrate/interface.js';
import type { CandidateSession } from './types.js';

interface PrIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Read the PR identity tuple off an observation atom's
 * `metadata.pr_fix_observation` record. Returns undefined if the
 * fields are missing or have unexpected shapes (defensive: the helper
 * fails-soft rather than throwing on malformed data).
 */
function readPrIdentity(atom: Atom): PrIdentity | undefined {
  const meta = atom.metadata as Record<string, unknown>;
  const obs = meta['pr_fix_observation'] as Record<string, unknown> | undefined;
  if (obs === undefined) return undefined;
  const owner = obs['pr_owner'];
  const repo = obs['pr_repo'];
  const number = obs['pr_number'];
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof number !== 'number') {
    return undefined;
  }
  return { owner, repo, number };
}

/**
 * Returns true iff two PR identities refer to the same PR. Used to
 * stop the walk at PR boundaries so an accidental cross-PR
 * `provenance.derived_from` link does not leak sessions from a
 * sibling PR into the current PR's candidate list.
 */
function samePr(a: PrIdentity, b: PrIdentity): boolean {
  return a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

/**
 * Pull a CandidateSession out of an agent-session atom, or return
 * undefined if the atom does not carry a non-empty
 * `metadata.agent_session.extra.resumable_session_id`. Legacy sessions
 * predating the resume-author capture hook lack this field; they are
 * skipped (not surfaced as a defective candidate) so the consumer's
 * resume path can fall through to the wrapper's fallback adapter.
 */
function asCandidate(atom: Atom): CandidateSession | undefined {
  const meta = atom.metadata as Record<string, unknown>;
  const agentSession = meta['agent_session'] as Record<string, unknown> | undefined;
  if (agentSession === undefined) return undefined;
  const extra = (agentSession['extra'] as Record<string, unknown> | undefined) ?? {};
  const resumableSessionId = extra['resumable_session_id'];
  if (typeof resumableSessionId !== 'string' || resumableSessionId.length === 0) {
    return undefined;
  }
  const adapterId = typeof agentSession['adapter_id'] === 'string'
    ? (agentSession['adapter_id'] as string)
    : '';
  const startedAt = typeof agentSession['started_at'] === 'string'
    ? (agentSession['started_at'] as string)
    : '';
  return {
    sessionAtomId: atom.id,
    resumableSessionId,
    startedAt,
    extra: extra as Readonly<Record<string, unknown>>,
    adapterId,
  };
}

/**
 * Walk the pr-fix-observation chain backward from
 * `startingObservationAtomId`, returning every candidate session
 * dispatched on the same PR (newest-first by `started_at`).
 *
 * Sort key is the session's `metadata.agent_session.started_at` ISO-8601
 * timestamp; ISO-8601 strings with the same precision sort
 * lexicographically the same as chronological order, so a string
 * comparison is correct here.
 */
export async function walkAuthorSessions(
  host: Host,
  startingObservationAtomId: AtomId,
): Promise<ReadonlyArray<CandidateSession>> {
  const startObs = await host.atoms.get(startingObservationAtomId);
  if (startObs === null) return [];
  const startPr = readPrIdentity(startObs);
  if (startPr === undefined) return [];

  const candidates: CandidateSession[] = [];
  const visited = new Set<string>();
  let current: Atom | null = startObs;
  while (current !== null) {
    if (visited.has(current.id)) break;
    visited.add(current.id);

    // Stop at PR-boundary mismatches: only the starting PR's
    // observations contribute candidates, regardless of whatever
    // accidental cross-link a sibling PR's chain might present.
    const currentPr = readPrIdentity(current);
    if (currentPr === undefined || !samePr(startPr, currentPr)) break;

    const obsMeta = current.metadata as Record<string, unknown>;
    const prFix = obsMeta['pr_fix_observation'] as Record<string, unknown>;
    const dispatchedId = prFix['dispatched_session_atom_id'];
    if (typeof dispatchedId === 'string' && dispatchedId.length > 0) {
      const sessionAtom = await host.atoms.get(dispatchedId as AtomId);
      if (sessionAtom !== null) {
        const candidate = asCandidate(sessionAtom);
        if (candidate !== undefined) {
          candidates.push(candidate);
        }
      }
    }

    // Walk to the prior observation via provenance. The pr-fix-actor's
    // atom builder prepends `priorObservationAtomId` at index 0 of
    // `derived_from`, so following [0] returns to the immediately
    // preceding observation on this PR.
    const priorIds = current.provenance.derived_from;
    if (priorIds.length === 0) break;
    const priorId = priorIds[0]!;
    current = await host.atoms.get(priorId);
  }

  return candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
