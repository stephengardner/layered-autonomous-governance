import { describe, expect, it } from 'vitest';
import { classifyDiffBlastRadius, computeVerdict } from '../../scripts/lib/auditor.mjs';

describe('classifyDiffBlastRadius', () => {
  it('returns docs when only docs/ or *.md files change', () => {
    expect(classifyDiffBlastRadius(['docs/foo.md', 'README.md'])).toBe('docs');
  });
  it('returns tooling when only scripts/ or config changes', () => {
    expect(classifyDiffBlastRadius(['scripts/foo.mjs', 'package.json'])).toBe('tooling');
  });
  it('returns framework when src/ changes', () => {
    expect(classifyDiffBlastRadius(['src/runtime/foo.ts'])).toBe('framework');
  });
  it('returns l3-canon-proposal when scripts/bootstrap-*-canon.mjs changes', () => {
    expect(classifyDiffBlastRadius(['scripts/bootstrap-dev-canon.mjs'])).toBe('l3-canon-proposal');
  });
  it('returns framework for mixed src + tooling', () => {
    expect(classifyDiffBlastRadius(['scripts/x.mjs', 'src/y.ts'])).toBe('framework');
  });
});

describe('computeVerdict', () => {
  it('passes when diff-radius is within envelope', () => {
    expect(computeVerdict({ diffRadius: 'tooling', envelopeMax: 'framework' })).toEqual({ verdict: 'pass', reason: 'within envelope' });
  });
  it('fails when diff-radius exceeds envelope', () => {
    const r = computeVerdict({ diffRadius: 'framework', envelopeMax: 'tooling' });
    expect(r.verdict).toBe('fail');
  });
});
