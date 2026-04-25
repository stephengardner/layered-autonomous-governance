import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  REPLAY_TIER_DEFAULT,
  loadReplayTier,
  replayTierAtomId,
} from '../../../src/substrate/policy/replay-tier.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/substrate/types.js';

const NOW = '2026-04-25T00:00:00.000Z' as Time;

function mkPolAtom(overrides: Partial<Atom> & { metadata: Record<string, unknown> }): Atom {
  return {
    schema_version: 1,
    id: overrides.id ?? ('pol-replay-tier-test' as AtomId),
    content: 'replay tier policy',
    type: 'preference',
    layer: 'L3',
    provenance: { kind: 'operator-seeded', source: { agent_id: 'operator' }, derived_from: [] },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'verified', last_validated_at: null },
    principal_id: 'operator' as PrincipalId,
    taint: 'clean',
    metadata: overrides.metadata,
    ...overrides,
  } as Atom;
}

describe('loadReplayTier', () => {
  it('returns the default when no atom exists', async () => {
    const host = createMemoryHost();
    const t = await loadReplayTier(host.atoms, 'cto-actor' as PrincipalId, 'planning');
    expect(t).toBe(REPLAY_TIER_DEFAULT);
  });

  it('default is content-addressed', () => {
    expect(REPLAY_TIER_DEFAULT).toBe('content-addressed');
  });

  it('per-principal beats per-actor-type', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom({
      id: replayTierAtomId({ target_actor_type: 'planning' }),
      metadata: { kind: 'pol-replay-tier', target_actor_type: 'planning', tier: 'best-effort' },
    }));
    await host.atoms.put(mkPolAtom({
      id: replayTierAtomId({ target_principal: 'cto-actor' as PrincipalId }),
      metadata: { kind: 'pol-replay-tier', target_principal: 'cto-actor', tier: 'strict' },
    }));
    expect(await loadReplayTier(host.atoms, 'cto-actor' as PrincipalId, 'planning')).toBe('strict');
  });

  it('per-actor-type matched when no per-principal', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom({
      id: replayTierAtomId({ target_actor_type: 'planning' }),
      metadata: { kind: 'pol-replay-tier', target_actor_type: 'planning', tier: 'strict' },
    }));
    expect(await loadReplayTier(host.atoms, 'cto-actor' as PrincipalId, 'planning')).toBe('strict');
  });

  it('tainted atom returns default (fail-closed)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom({
      id: replayTierAtomId({ target_principal: 'cto-actor' as PrincipalId }),
      taint: 'tainted',
      metadata: { kind: 'pol-replay-tier', target_principal: 'cto-actor', tier: 'best-effort' },
    }));
    expect(await loadReplayTier(host.atoms, 'cto-actor' as PrincipalId, 'planning')).toBe(REPLAY_TIER_DEFAULT);
  });

  it('throws on malformed payload (unknown tier value)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(mkPolAtom({
      id: replayTierAtomId({ target_principal: 'cto-actor' as PrincipalId }),
      metadata: { kind: 'pol-replay-tier', target_principal: 'cto-actor', tier: 'turbo' },
    }));
    await expect(loadReplayTier(host.atoms, 'cto-actor' as PrincipalId, 'planning')).rejects.toThrow(/tier/);
  });
});
