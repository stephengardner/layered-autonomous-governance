/**
 * Drift tests for scripts/bootstrap-reaper-canon.mjs.
 *
 * The POLICIES array (built via buildPolicies) seeds the L3 directive
 * atom `pol-reaper-ttls-default` whose runtime behavior is consumed by
 * `readReaperTtlsFromCanon` in src/runtime/loop/reaper-ttls.ts and
 * fall-through-validated against `DEFAULT_REAPER_TTLS` in
 * src/runtime/plans/reaper.ts. Keeping seed and runtime fallback in
 * sync is load-bearing: a deployment that never runs the bootstrap
 * gets the runtime fallback at every tick, and a silent divergence
 * (e.g. seed says warn=12h but DEFAULT_REAPER_TTLS drifted to 6h) means
 * the policy the operator thinks they have differs from what runs.
 *
 * These tests lock the two together. A drift is a test failure, not a
 * silent runtime surprise.
 *
 * Covers:
 *   - buildPolicies returns the expected stable set of ids.
 *   - pol-reaper-ttls-default fields match DEFAULT_REAPER_TTLS exactly.
 *   - policyAtom() shape is a well-formed L3 directive with
 *     metadata.policy.subject='reaper-ttls'.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/reaper-canon-policies.mjs';
import { DEFAULT_REAPER_TTLS } from '../../src/runtime/plans/reaper.js';

const OP = 'test-operator';

describe('bootstrap-reaper-canon POLICIES', () => {
  it('returns the expected stable set of policy ids', () => {
    const policies = buildPolicies(OP);
    const ids = policies.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual(['pol-reaper-ttls-default']);
  });

  it('pol-reaper-ttls-default fields match DEFAULT_REAPER_TTLS exactly', () => {
    // Drift guard: if someone edits buildPolicies OR DEFAULT_REAPER_TTLS
    // in isolation, this test catches it before a tenant's runtime
    // diverges from their seeded canon. The seed carries
    // metadata.policy.warn_ms / abandon_ms; the runtime fallback uses
    // staleWarnMs / staleAbandonMs. The reader translates between the
    // two; this test asserts the values match.
    const policies = buildPolicies(OP);
    const spec = policies.find(
      (p: { id: string }) => p.id === 'pol-reaper-ttls-default',
    );
    expect(spec).toBeDefined();
    expect(spec!.subject).toBe('reaper-ttls');
    const fields = spec!.fields as { warn_ms: number; abandon_ms: number };
    expect(fields.warn_ms).toBe(DEFAULT_REAPER_TTLS.staleWarnMs);
    expect(fields.abandon_ms).toBe(DEFAULT_REAPER_TTLS.staleAbandonMs);
  });

  it('policyAtom shape is a well-formed L3 directive with metadata.policy', () => {
    const policies = buildPolicies(OP);
    const spec = policies[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-reaper-ttls-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.provenance.kind).toBe('operator-seeded');
    const meta = atom.metadata as {
      policy: { subject: string; warn_ms: number; abandon_ms: number };
    };
    expect(meta.policy.subject).toBe('reaper-ttls');
    expect(meta.policy.warn_ms).toBe(DEFAULT_REAPER_TTLS.staleWarnMs);
    expect(meta.policy.abandon_ms).toBe(DEFAULT_REAPER_TTLS.staleAbandonMs);
  });
});
