/**
 * Tests for scripts/lib/self-audit-prompt.mjs.
 *
 * Pins the contract the perpetual self-audit tick depends on:
 *   - The 6 audit dimensions named in the operator's 2026-05-22
 *     directive are all present in the rendered prompt.
 *   - The rendered prompt carries the fire-time so audit findings
 *     can be correlated back to a specific tick.
 *   - The prompt names indie-floor + org-ceiling as constraints,
 *     matching dev-indie-floor-org-ceiling canon.
 *   - The prompt enforces single-gap-per-tick scope discipline so
 *     the substrate ships one substrate fix per cycle (perfection,
 *     not breadth).
 *   - Input validation: empty / non-string nowIso throws.
 */

import { describe, expect, it } from 'vitest';

const { buildSelfAuditPrompt, AUDIT_DIMENSIONS } = await import(
  '../../scripts/lib/self-audit-prompt.mjs'
);

describe('buildSelfAuditPrompt', () => {
  const NOW_ISO = '2026-05-22T05:00:00.000Z';

  it('renders the fire-time so findings correlate to a specific tick', () => {
    const text = buildSelfAuditPrompt(NOW_ISO);
    expect(text).toContain(NOW_ISO);
  });

  it('names all 6 audit dimensions in the rendered prompt', () => {
    const text = buildSelfAuditPrompt(NOW_ISO);
    for (const dimension of AUDIT_DIMENSIONS) {
      expect(text).toContain(dimension);
    }
  });

  it('lists indie-floor first per dev-indie-floor-org-ceiling canon', () => {
    // The solo developer is first-class per canon. The dimension
    // order matters; flipping the order would silently re-prioritize
    // the audit toward org-only concerns.
    expect(AUDIT_DIMENSIONS[0]).toBe('indie-floor');
    expect(AUDIT_DIMENSIONS[1]).toBe('org-ceiling');
  });

  it('names both indie + org consumers as load-bearing constraints', () => {
    const text = buildSelfAuditPrompt(NOW_ISO);
    expect(text).toContain('organizations');
    expect(text).toContain('indie developers');
  });

  it('enforces single-gap-per-tick scope discipline', () => {
    // Without this rule the LLM tends to produce a 12-item roadmap
    // markdown instead of a shippable PR. The audit fires often;
    // each tick must converge on ONE substrate fix.
    const text = buildSelfAuditPrompt(NOW_ISO);
    expect(text).toContain('one PR per self-audit tick');
  });

  it('demands citation discipline (file:line evidence)', () => {
    // Speculation-without-evidence is the failure mode this guards
    // against. The substrate-deep pipeline already has a citation
    // fence; the prompt reinforces the contract at intent-time.
    const text = buildSelfAuditPrompt(NOW_ISO);
    expect(text).toContain('file:line');
    expect(text).toContain('No speculation');
  });

  it('exposes AUDIT_DIMENSIONS as frozen so accidental mutation throws', () => {
    expect(Object.isFrozen(AUDIT_DIMENSIONS)).toBe(true);
  });

  it('throws on empty nowIso (input validation)', () => {
    expect(() => buildSelfAuditPrompt('')).toThrow(/nowIso/);
  });

  it('throws on non-string nowIso', () => {
    expect(() => buildSelfAuditPrompt(123 as never)).toThrow(/nowIso/);
    expect(() => buildSelfAuditPrompt(null as never)).toThrow(/nowIso/);
    expect(() => buildSelfAuditPrompt(undefined as never)).toThrow(/nowIso/);
  });
});
