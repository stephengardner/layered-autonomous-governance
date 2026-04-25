import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import { walkAuthorSessions } from '../../../../examples/agent-loops/resume-author/walk-author-sessions.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../../src/substrate/types.js';

const PRINCIPAL = 'pr-fix-actor' as PrincipalId;

/**
 * Build a generic atom-skeleton that other constructors layer specific
 * fields onto. Keeps each test concise; the shape mirrors what
 * pr-fix-observation.ts and the agent-loop substrate write.
 */
function mkBaseAtom(
  id: string,
  type: Atom['type'],
  createdAt: Time,
  derivedFrom: ReadonlyArray<string>,
  metadata: Record<string, unknown>,
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: id,
    type,
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'pr-fix-actor' },
      derived_from: derivedFrom as ReadonlyArray<AtomId>,
    },
    confidence: 1,
    created_at: createdAt,
    last_reinforced_at: createdAt,
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
    principal_id: PRINCIPAL,
    taint: 'clean',
    metadata,
  };
}

/**
 * Build a pr-fix-observation atom shaped like `mkPrFixObservationAtom`
 * writes them: `type: 'observation'`, `metadata.kind:
 * 'pr-fix-observation'`, with the PR identity and (optional)
 * dispatched_session_atom_id under `metadata.pr_fix_observation`.
 */
function mkObservationAtom(opts: {
  readonly id: string;
  readonly createdAt: Time;
  readonly priorObservationId?: string;
  readonly prOwner: string;
  readonly prRepo: string;
  readonly prNumber: number;
  readonly dispatchedSessionAtomId?: string;
}): Atom {
  const derivedFrom = opts.priorObservationId !== undefined ? [opts.priorObservationId] : [];
  const prFixObs: Record<string, unknown> = {
    pr_owner: opts.prOwner,
    pr_repo: opts.prRepo,
    pr_number: opts.prNumber,
    head_branch: 'main',
    head_sha: 'deadbeef',
    cr_review_states: [],
    merge_state_status: null,
    mergeable: null,
    line_comment_count: 0,
    body_nit_count: 0,
    check_run_failure_count: 0,
    legacy_status_failure_count: 0,
    partial: false,
    classification: 'has-findings',
  };
  if (opts.dispatchedSessionAtomId !== undefined) {
    prFixObs['dispatched_session_atom_id'] = opts.dispatchedSessionAtomId;
  }
  return mkBaseAtom(opts.id, 'observation', opts.createdAt, derivedFrom, {
    kind: 'pr-fix-observation',
    pr_fix_observation: prFixObs,
  });
}

/**
 * Build an agent-session atom shaped like the agent-loop substrate
 * writes them: `type: 'agent-session'`, with `metadata.agent_session`
 * carrying `adapter_id`, `started_at`, and the optional `extra` slot.
 */
function mkSessionAtom(opts: {
  readonly id: string;
  readonly createdAt: Time;
  readonly startedAt: Time;
  readonly adapterId: string;
  readonly extra?: Record<string, unknown>;
}): Atom {
  return mkBaseAtom(opts.id, 'agent-session', opts.createdAt, [], {
    agent_session: {
      model_id: 'stub-model',
      adapter_id: opts.adapterId,
      workspace_id: 'ws-1',
      started_at: opts.startedAt,
      terminal_state: 'completed',
      replay_tier: 'best-effort',
      budget_consumed: { turns: 1, wall_clock_ms: 1 },
      ...(opts.extra !== undefined ? { extra: opts.extra } : {}),
    },
  });
}

describe('walkAuthorSessions', () => {
  it('returns candidate sessions newest-first scoped to one PR', async () => {
    const host = createMemoryHost();

    // Seed three sessions with strictly-ordered started_at values.
    await host.atoms.put(mkSessionAtom({
      id: 'session-1',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-001' },
    }));
    await host.atoms.put(mkSessionAtom({
      id: 'session-2',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-002' },
    }));
    await host.atoms.put(mkSessionAtom({
      id: 'session-3',
      createdAt: '2026-04-25T03:00:00.000Z',
      startedAt: '2026-04-25T03:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-003' },
    }));

    // Three observations on PR (acme, repo, 1) chained via priorObservationId.
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-1',
      createdAt: '2026-04-25T01:00:00.000Z',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 1,
      dispatchedSessionAtomId: 'session-1',
    }));
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-2',
      createdAt: '2026-04-25T02:00:00.000Z',
      priorObservationId: 'pr-fix-obs-1',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 1,
      dispatchedSessionAtomId: 'session-2',
    }));
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-3',
      createdAt: '2026-04-25T03:00:00.000Z',
      priorObservationId: 'pr-fix-obs-2',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 1,
      dispatchedSessionAtomId: 'session-3',
    }));

    // One unrelated observation on PR (acme, repo, 2) -- must NOT be picked up.
    await host.atoms.put(mkSessionAtom({
      id: 'session-other',
      createdAt: '2026-04-25T02:30:00.000Z',
      startedAt: '2026-04-25T02:30:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-other' },
    }));
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-other',
      createdAt: '2026-04-25T02:30:00.000Z',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 2,
      dispatchedSessionAtomId: 'session-other',
    }));

    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-3' as AtomId);
    expect(candidates).toHaveLength(3);
    expect(candidates.map(c => c.resumableSessionId)).toEqual(['uuid-003', 'uuid-002', 'uuid-001']);
    expect(candidates[0]!.startedAt > candidates[1]!.startedAt).toBe(true);
    expect(candidates[1]!.startedAt > candidates[2]!.startedAt).toBe(true);
    // Unrelated PR's session must not appear.
    expect(candidates.some(c => c.resumableSessionId === 'uuid-other')).toBe(false);
  });

  it('skips sessions missing extra.resumable_session_id', async () => {
    const host = createMemoryHost();
    // Legacy session predating the resume-author capture hook;
    // no resumable_session_id in extra.
    await host.atoms.put(mkSessionAtom({
      id: 'session-legacy',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      // No extra at all.
    }));
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-legacy',
      createdAt: '2026-04-25T01:00:00.000Z',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 5,
      dispatchedSessionAtomId: 'session-legacy',
    }));

    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-legacy' as AtomId);
    expect(candidates).toEqual([]);
  });

  it('returns empty when starting observation has no dispatched_session_atom_id chain', async () => {
    const host = createMemoryHost();
    // First-iteration observation: no dispatched session yet, no prior.
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-fresh',
      createdAt: '2026-04-25T01:00:00.000Z',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 7,
    }));

    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-fresh' as AtomId);
    expect(candidates).toEqual([]);
  });

  it('does not cross PR boundaries', async () => {
    const host = createMemoryHost();
    // A foreign-PR session that should NOT be picked up.
    await host.atoms.put(mkSessionAtom({
      id: 'session-foreign',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-foreign' },
    }));
    // Foreign PR's observation chains via provenance.derived_from to our
    // PR's observation -- pretend an accidental cross-link.
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-foreign',
      createdAt: '2026-04-25T01:00:00.000Z',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 99,
      dispatchedSessionAtomId: 'session-foreign',
    }));
    // Our PR's session + observation, with priorObservationId pointing
    // at the foreign PR observation.
    await host.atoms.put(mkSessionAtom({
      id: 'session-ours',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-ours' },
    }));
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-ours',
      createdAt: '2026-04-25T02:00:00.000Z',
      priorObservationId: 'pr-fix-obs-foreign',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 1,
      dispatchedSessionAtomId: 'session-ours',
    }));

    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-ours' as AtomId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.resumableSessionId).toBe('uuid-ours');
    expect(candidates.some(c => c.resumableSessionId === 'uuid-foreign')).toBe(false);
  });

  it('handles missing observation atom gracefully', async () => {
    const host = createMemoryHost();
    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-missing' as AtomId);
    expect(candidates).toEqual([]);
  });

  it('terminates without infinite loop on a derived_from cycle', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkSessionAtom({
      id: 'session-A',
      createdAt: '2026-04-25T01:00:00.000Z',
      startedAt: '2026-04-25T01:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-A' },
    }));
    await host.atoms.put(mkSessionAtom({
      id: 'session-B',
      createdAt: '2026-04-25T02:00:00.000Z',
      startedAt: '2026-04-25T02:00:00.000Z',
      adapterId: 'claude-code-agent-loop',
      extra: { resumable_session_id: 'uuid-B' },
    }));
    // Two observations on the same PR that point at each other via
    // provenance.derived_from. The walker MUST NOT loop infinitely.
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-A',
      createdAt: '2026-04-25T01:00:00.000Z',
      priorObservationId: 'pr-fix-obs-B',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 1,
      dispatchedSessionAtomId: 'session-A',
    }));
    await host.atoms.put(mkObservationAtom({
      id: 'pr-fix-obs-B',
      createdAt: '2026-04-25T02:00:00.000Z',
      priorObservationId: 'pr-fix-obs-A',
      prOwner: 'acme',
      prRepo: 'repo',
      prNumber: 1,
      dispatchedSessionAtomId: 'session-B',
    }));

    const candidates = await walkAuthorSessions(host, 'pr-fix-obs-A' as AtomId);
    // Both sessions appear once each -- the cycle guard short-circuits the
    // re-visit before any duplicate is collected.
    expect(candidates).toHaveLength(2);
    const ids = candidates.map(c => c.resumableSessionId).sort();
    expect(ids).toEqual(['uuid-A', 'uuid-B']);
  });
});
