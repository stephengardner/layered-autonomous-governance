import { describe, it, expect } from 'vitest';
import {
  extractDeliberation,
  hasAnyDeliberation,
} from './deliberation-fields';
import type { AnyAtom } from '@/services/atoms.service';

/*
 * Builder for a minimally-valid AnyAtom under test. Every test below
 * mutates the metadata bag or provenance to exercise one narrowing
 * branch; the surrounding fields stay constant so the assertions are
 * readable.
 */
function fixture(over: Partial<AnyAtom> = {}): AnyAtom {
  return {
    id: 'plan-test-2026-05-05',
    type: 'plan',
    layer: 'L0',
    content: '# Test plan\nbody',
    principal_id: 'cto-actor',
    confidence: 0.9,
    created_at: '2026-05-05T00:00:00.000Z',
    ...over,
  } as AnyAtom;
}

describe('extractDeliberation', () => {
  it('returns the full set when every field is present', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        principles_applied: ['dev-extreme-rigor-and-research', 'dev-mobile-first'],
        alternatives_rejected: [
          { option: 'alt 1', reason: 'too risky' },
          { option: 'alt 2' },
        ],
        what_breaks_if_revisit: 'the substrate purity guarantee',
      },
      provenance: {
        kind: 'cto-plan',
        derived_from: ['intent-1', 'intent-2'],
      },
    }));

    expect(fields.principlesApplied).toEqual([
      'dev-extreme-rigor-and-research',
      'dev-mobile-first',
    ]);
    expect(fields.alternativesRejected).toEqual([
      { option: 'alt 1', reason: 'too risky' },
      { option: 'alt 2' },
    ]);
    expect(fields.whatBreaksIfRevisit).toBe('the substrate purity guarantee');
    expect(fields.derivedFrom).toEqual(['intent-1', 'intent-2']);
  });

  it('handles a legacy atom with no deliberation fields at all', () => {
    const fields = extractDeliberation(fixture());
    expect(fields.principlesApplied).toEqual([]);
    expect(fields.alternativesRejected).toEqual([]);
    expect(fields.whatBreaksIfRevisit).toBeNull();
    expect(fields.derivedFrom).toEqual([]);
  });

  it('handles a partial atom (only principles)', () => {
    const fields = extractDeliberation(fixture({
      metadata: { principles_applied: ['dev-mobile-first'] },
    }));
    expect(fields.principlesApplied).toEqual(['dev-mobile-first']);
    expect(fields.alternativesRejected).toEqual([]);
    expect(fields.whatBreaksIfRevisit).toBeNull();
    expect(fields.derivedFrom).toEqual([]);
  });

  it('tolerates the older spelling what_breaks_if_revisited', () => {
    const fields = extractDeliberation(fixture({
      metadata: { what_breaks_if_revisited: 'old spelling worked' },
    }));
    expect(fields.whatBreaksIfRevisit).toBe('old spelling worked');
  });

  it('prefers the canonical spelling when both spellings appear', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        what_breaks_if_revisit: 'canonical wins',
        what_breaks_if_revisited: 'old also present',
      },
    }));
    expect(fields.whatBreaksIfRevisit).toBe('canonical wins');
  });

  it('treats whitespace-only what_breaks as absent', () => {
    const fields = extractDeliberation(fixture({
      metadata: { what_breaks_if_revisit: '   \n  ' },
    }));
    expect(fields.whatBreaksIfRevisit).toBeNull();
  });

  it('dedupes principles_applied while preserving first-occurrence order', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        principles_applied: ['dev-a', 'dev-b', 'dev-a', 'dev-c', 'dev-b'],
      },
    }));
    expect(fields.principlesApplied).toEqual(['dev-a', 'dev-b', 'dev-c']);
  });

  it('dedupes derived_from while preserving first-occurrence order', () => {
    const fields = extractDeliberation(fixture({
      provenance: {
        kind: 'cto-plan',
        derived_from: ['x', 'y', 'x', 'z'],
      },
    }));
    expect(fields.derivedFrom).toEqual(['x', 'y', 'z']);
  });

  it('drops empty strings and trims whitespace from id arrays', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        principles_applied: ['  dev-x  ', '', '   ', 'dev-y'],
      },
      provenance: {
        kind: 'cto-plan',
        derived_from: ['  ', 'foo', '   bar  '],
      },
    }));
    expect(fields.principlesApplied).toEqual(['dev-x', 'dev-y']);
    expect(fields.derivedFrom).toEqual(['foo', 'bar']);
  });

  it('survives non-array shapes for every list field', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        // simulate a malformed atom that put a string where an array
        // is expected -- the whole module must not throw.
        principles_applied: 'dev-x' as unknown as ReadonlyArray<string>,
        alternatives_rejected: 42 as unknown as ReadonlyArray<{ option: string }>,
      },
      provenance: {
        kind: 'cto-plan',
        // and an object where an array is expected on provenance.
        derived_from: { 0: 'ignored' } as unknown as ReadonlyArray<string>,
      },
    }));
    expect(fields.principlesApplied).toEqual([]);
    expect(fields.alternativesRejected).toEqual([]);
    expect(fields.derivedFrom).toEqual([]);
  });

  it('accepts both string and {option,reason} shapes in alternatives', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        alternatives_rejected: [
          'short string entry',
          { option: 'structured', reason: 'too long' },
          { option: 'no reason' },
        ],
      },
    }));
    expect(fields.alternativesRejected).toEqual([
      { option: 'short string entry' },
      { option: 'structured', reason: 'too long' },
      { option: 'no reason' },
    ]);
  });

  it('drops alternative entries with empty option', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        alternatives_rejected: [
          { option: '', reason: 'has reason but no option' },
          { option: 'good one' },
          null as unknown as { option: string },
        ],
      },
    }));
    expect(fields.alternativesRejected).toEqual([{ option: 'good one' }]);
  });

  it('drops alternative reason if it is non-string', () => {
    const fields = extractDeliberation(fixture({
      metadata: {
        alternatives_rejected: [
          { option: 'opt', reason: 42 as unknown as string },
        ],
      },
    }));
    expect(fields.alternativesRejected).toEqual([{ option: 'opt' }]);
  });
});

describe('hasAnyDeliberation', () => {
  it('returns false when every field is empty', () => {
    expect(hasAnyDeliberation({
      principlesApplied: [],
      alternativesRejected: [],
      whatBreaksIfRevisit: null,
      derivedFrom: [],
    })).toBe(false);
  });

  it('returns true when only principles are present', () => {
    expect(hasAnyDeliberation({
      principlesApplied: ['dev-x'],
      alternativesRejected: [],
      whatBreaksIfRevisit: null,
      derivedFrom: [],
    })).toBe(true);
  });

  it('returns true when only alternatives are present', () => {
    expect(hasAnyDeliberation({
      principlesApplied: [],
      alternativesRejected: [{ option: 'x' }],
      whatBreaksIfRevisit: null,
      derivedFrom: [],
    })).toBe(true);
  });

  it('returns true when only what_breaks is present', () => {
    expect(hasAnyDeliberation({
      principlesApplied: [],
      alternativesRejected: [],
      whatBreaksIfRevisit: 'something',
      derivedFrom: [],
    })).toBe(true);
  });

  it('returns true when only derived_from is present', () => {
    expect(hasAnyDeliberation({
      principlesApplied: [],
      alternativesRejected: [],
      whatBreaksIfRevisit: null,
      derivedFrom: ['x'],
    })).toBe(true);
  });
});
