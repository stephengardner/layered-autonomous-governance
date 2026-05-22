/**
 * Drift tests for scripts/bootstrap-medium-tier-kill-switch-canon.mjs.
 *
 * The companion-atom seed set carries the canonical "medium-tier
 * kill-switch shipped" decision plus three companion atoms binding it
 * to the four canon directives that historically cited D13 as an
 * unfulfilled gate (pol-cto-no-merge, pol-pr-landing-no-auto-merge,
 * inv-kill-switch-first, dec-kill-switch-design-first).
 *
 * Covers:
 *   - buildPolicies returns the expected stable set of 4 atom ids.
 *   - Each spec carries the expected subject + companion_to binding.
 *   - companionAtom() shape is a well-formed L3 decision atom.
 *   - Running buildPolicies twice with the same operator id returns
 *     structurally identical specs (idempotency proxy).
 */

import { describe, expect, it } from 'vitest';

import {
  buildPolicies,
  companionAtom,
} from '../../scripts/lib/medium-tier-kill-switch-canon-policies.mjs';

const OP = 'test-operator';

interface PolicySpec {
  id: string;
  subject: string;
  fields: Record<string, unknown>;
  reason: string;
}

describe('bootstrap-medium-tier-kill-switch-canon POLICIES', () => {
  it('returns the expected stable set of 4 atom ids', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    const ids = policies.map((p) => p.id).sort();
    expect(ids).toEqual([
      'dec-inv-kill-switch-first-medium-tier-available-2026-05-22',
      'dec-medium-tier-kill-switch-shipped-2026-05-22',
      'dec-pol-cto-no-merge-medium-tier-available-2026-05-22',
      'dec-pol-pr-landing-no-auto-merge-medium-tier-available-2026-05-22',
    ]);
  });

  it('base ship atom carries substrate paths + unblocks list', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    const base = policies.find(
      (p) => p.id === 'dec-medium-tier-kill-switch-shipped-2026-05-22',
    );
    expect(base).toBeDefined();
    expect(base!.subject).toBe('medium-tier-kill-switch-shipped');
    expect(base!.fields['substrate_path']).toBe('src/substrate/kill-switch/medium-tier.ts');
    expect(base!.fields['reference_impl_path']).toBe(
      'examples/kill-switches/process-supervisor/',
    );
    expect(base!.fields['runner_wiring_path']).toBe('src/runtime/actors/run-actor.ts');
    expect(base!.fields['unblocks']).toEqual([
      'pol-cto-no-merge',
      'pol-pr-landing-no-auto-merge',
      'inv-kill-switch-first',
      'dec-kill-switch-design-first',
    ]);
  });

  it('three companion atoms each bind to their parent canon id', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    const companions: Array<[string, string]> = [
      [
        'dec-pol-cto-no-merge-medium-tier-available-2026-05-22',
        'pol-cto-no-merge',
      ],
      [
        'dec-pol-pr-landing-no-auto-merge-medium-tier-available-2026-05-22',
        'pol-pr-landing-no-auto-merge',
      ],
      [
        'dec-inv-kill-switch-first-medium-tier-available-2026-05-22',
        'inv-kill-switch-first',
      ],
    ];
    for (const [id, parent] of companions) {
      const spec = policies.find((p) => p.id === id);
      expect(spec, `${id} should be present in buildPolicies output`).toBeDefined();
      expect(spec!.subject).toBe('medium-tier-companion');
      expect(spec!.fields['companion_to']).toBe(parent);
      expect(spec!.fields['prerequisite_shipped']).toBe(
        'dec-medium-tier-kill-switch-shipped-2026-05-22',
      );
    }
  });

  it('inv-kill-switch-first companion also references the design decision', () => {
    // The audit doc names FOUR canon directives blocked on D13; three of
    // those are parent atoms (pol-cto-no-merge, pol-pr-landing-no-auto-merge,
    // inv-kill-switch-first) and the fourth (dec-kill-switch-design-first)
    // is the original design decision the invariant is paired with.
    // Folding it into the inv-kill-switch-first companion avoids a fourth
    // companion atom whose content would substantively duplicate the
    // invariant binding.
    const policies = buildPolicies(OP) as PolicySpec[];
    const spec = policies.find(
      (p) => p.id === 'dec-inv-kill-switch-first-medium-tier-available-2026-05-22',
    );
    expect(spec!.fields['also_unblocks']).toBe('dec-kill-switch-design-first');
  });
});

describe('companionAtom()', () => {
  it('produces a well-formed L3 decision atom with required canonical fields', () => {
    const spec = buildPolicies(OP)[0] as PolicySpec;
    const atom = companionAtom(spec, OP);
    expect(atom.id).toBe(spec.id);
    expect(atom.type).toBe('decision');
    expect(atom.layer).toBe('L3');
    expect(atom.confidence).toBe(1.0);
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.provenance.kind).toBe('operator-seeded');
    expect(atom.provenance.source).toEqual({
      session_id: 'bootstrap-medium-tier-kill-switch',
      agent_id: 'bootstrap',
    });
    expect(atom.provenance.derived_from).toEqual([]);
    expect(atom.metadata.policy.subject).toBe(spec.subject);
    expect(atom.metadata.policy.reason).toBe(spec.reason);
    // Stable bootstrap timestamp; matches the seed-time used across
    // the canon-bootstrap suite so a drift-check on created_at would
    // surface as a "second run is not idempotent" failure.
    expect(atom.created_at).toBe('2026-05-22T00:00:00.000Z');
    expect(atom.last_reinforced_at).toBe('2026-05-22T00:00:00.000Z');
  });

  it('uses the operator id as principal_id signature on every atom', () => {
    const policies = buildPolicies(OP) as PolicySpec[];
    for (const spec of policies) {
      const atom = companionAtom(spec, OP);
      expect(atom.principal_id).toBe(OP);
    }
  });
});

describe('idempotency proxy', () => {
  it('buildPolicies returns structurally identical specs across calls', () => {
    const a = buildPolicies(OP);
    const b = buildPolicies(OP);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('companionAtom is a pure function of (spec, operatorId)', () => {
    const spec = buildPolicies(OP)[0] as PolicySpec;
    const a = companionAtom(spec, OP);
    const b = companionAtom(spec, OP);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
