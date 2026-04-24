import { describe, expect, it } from 'vitest';
import { RADIUS_RANK, isBlastRadiusWithin, findIntentInProvenance } from '../../../src/runtime/actor-message/intent-approve.js';

describe('RADIUS_RANK', () => {
  it('orders radius labels ordinally', () => {
    expect(RADIUS_RANK.none).toBe(0);
    expect(RADIUS_RANK.docs).toBeLessThan(RADIUS_RANK.tooling);
    expect(RADIUS_RANK.tooling).toBeLessThan(RADIUS_RANK.framework);
    expect(RADIUS_RANK.framework).toBeLessThan(RADIUS_RANK['l3-canon-proposal']);
  });
});

describe('isBlastRadiusWithin', () => {
  it('accepts when plan is narrower than envelope', () => {
    expect(isBlastRadiusWithin('tooling', 'framework')).toBe(true);
  });
  it('accepts when equal', () => {
    expect(isBlastRadiusWithin('framework', 'framework')).toBe(true);
  });
  it('rejects when plan is wider than envelope', () => {
    expect(isBlastRadiusWithin('framework', 'tooling')).toBe(false);
  });
});

describe('findIntentInProvenance', () => {
  const makeHost = (atoms: Record<string, any>) => ({
    atoms: { get: async (id: string) => atoms[id] ?? null },
  });

  it('returns the intent id when plan.provenance.derived_from includes an operator-intent atom', async () => {
    const host = makeHost({
      'intent-1': { id: 'intent-1', type: 'operator-intent' },
      'canon-1': { id: 'canon-1', type: 'directive' },
    });
    const plan = { provenance: { derived_from: ['canon-1', 'intent-1'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBe('intent-1');
  });
  it('returns null when no intent is cited', async () => {
    const host = makeHost({
      'canon-1': { id: 'canon-1', type: 'directive' },
    });
    const plan = { provenance: { derived_from: ['canon-1'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBeNull();
  });
  it('does NOT do a transitive walk (v1: direct-only)', async () => {
    const host = makeHost({
      'intent-1': { id: 'intent-1', type: 'operator-intent' },
      'question-1': { id: 'question-1', type: 'question', provenance: { derived_from: ['intent-1'] } },
    });
    const plan = { provenance: { derived_from: ['question-1'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBeNull();
  });
  it('handles missing atom gracefully', async () => {
    const host = makeHost({});
    const plan = { provenance: { derived_from: ['missing-id'] } };
    expect(await findIntentInProvenance(host as any, plan as any)).toBeNull();
  });
});
