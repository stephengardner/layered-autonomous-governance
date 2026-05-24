/**
 * Drift tests for scripts/bootstrap-cross-stage-reprompt-canon.mjs.
 *
 * Seeds `pol-cross-stage-reprompt-default`, the L3 directive atom that
 * gates the deep planning pipeline's cross-stage walk-back mechanism.
 * Default `max_attempts=2`, `severities_to_reprompt=['critical']`, and
 * `allowed_targets='derive-from-pipeline-composition'` activate the
 * cross-stage walk at the safest shape. Per the lib comment: this seed
 * is asymmetric with auditor-feedback-reprompt because the runner has
 * NO fallback default; the gate is dormant until the atom is seeded.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/cross-stage-reprompt-canon-policies.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

const EXPECTED_DEFAULTS = {
  max_attempts: 2,
  severities_to_reprompt: ['critical'],
  allowed_targets: 'derive-from-pipeline-composition',
} as const;

async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-cross-stage-reprompt-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-cross-stage-reprompt-canon POLICIES', () => {
  it('returns the single expected policy id', () => {
    expect(buildPolicies(OP).map((p: { id: string }) => p.id)).toEqual([
      'pol-cross-stage-reprompt-default',
    ]);
  });

  it('seeded fields activate the cross-stage walk at the safest defaults', () => {
    // Drift guard: seeding this atom FLIPS the gate from dormant to
    // active. A drift here means an operator-bootstrap silently
    // changes pipeline routing semantics. Locking the default shape
    // makes any future relaxation a deliberate canon edit.
    const spec = buildPolicies(OP)[0]!;
    expect(spec.fields.max_attempts).toBe(EXPECTED_DEFAULTS.max_attempts);
    expect(spec.fields.severities_to_reprompt).toEqual(
      EXPECTED_DEFAULTS.severities_to_reprompt,
    );
    expect(spec.fields.allowed_targets).toBe(EXPECTED_DEFAULTS.allowed_targets);
  });

  it('policyAtom emits a well-formed L3 directive', () => {
    const spec = buildPolicies(OP)[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-cross-stage-reprompt-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.provenance.kind).toBe('operator-seeded');
    expect(atom.schema_version).toBe(1);
    const meta = atom.metadata as {
      policy: {
        subject: string;
        max_attempts: number;
        severities_to_reprompt: readonly string[];
        allowed_targets: string;
      };
    };
    expect(meta.policy.subject).toBe('cross-stage-reprompt-default');
    expect(meta.policy.max_attempts).toBe(EXPECTED_DEFAULTS.max_attempts);
    expect(meta.policy.severities_to_reprompt).toEqual(
      EXPECTED_DEFAULTS.severities_to_reprompt,
    );
    expect(meta.policy.allowed_targets).toBe(EXPECTED_DEFAULTS.allowed_targets);
  });

  it('rebuild is byte-identical (deterministic, no Date.now / Math.random leakage)', () => {
    const a = buildPolicies(OP).map((spec: { id: string }) => policyAtom(spec, OP));
    const b = buildPolicies(OP).map((spec: { id: string }) => policyAtom(spec, OP));
    expect(a).toEqual(b);
  });

  it('round-trips through the file host with the policy payload preserved', () =>
    withTempFileHost(async (host) => {
      const spec = buildPolicies(OP)[0]!;
      const expected = policyAtom(spec, OP);
      await host.atoms.put(expected);
      const stored = await host.atoms.get(expected.id);
      expect(stored).not.toBeNull();
      expect(stored!.metadata.policy).toEqual(expected.metadata.policy);
    }));
});
