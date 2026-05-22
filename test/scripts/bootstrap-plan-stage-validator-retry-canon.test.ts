/**
 * Drift tests for scripts/bootstrap-plan-stage-validator-retry-canon.mjs.
 *
 * Seeds `pol-plan-stage-validator-retry-default`, the L3 directive
 * atom that gates the plan-stage's validator-retry loop. Default
 * `max_attempts=2` (attempt 1 + 1 retry) and
 * `recoverable_error_patterns=['schema-validation-failed']` match the
 * runner's wholesale-category prefix; org-ceiling deployments narrow
 * to specific zod-error substrings via a higher-priority atom.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/plan-stage-validator-retry-canon-policies.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

const EXPECTED_DEFAULTS = {
  max_attempts: 2,
  recoverable_error_patterns: ['schema-validation-failed'],
} as const;

async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-plan-stage-validator-retry-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-plan-stage-validator-retry-canon POLICIES', () => {
  it('returns the single expected policy id', () => {
    expect(buildPolicies(OP).map((p: { id: string }) => p.id)).toEqual([
      'pol-plan-stage-validator-retry-default',
    ]);
  });

  it('seeded fields match the runner default (max_attempts=2, schema-validation-failed)', () => {
    // Drift guard: max_attempts caps the retry loop; a drift toward
    // higher attempts widens the budget surface silently.
    // recoverable_error_patterns gates which zod failures are retried;
    // a drift here changes which validator-failure classes auto-recover.
    const spec = buildPolicies(OP)[0]!;
    expect(spec.fields.max_attempts).toBe(EXPECTED_DEFAULTS.max_attempts);
    expect(spec.fields.recoverable_error_patterns).toEqual(
      EXPECTED_DEFAULTS.recoverable_error_patterns,
    );
  });

  it('policyAtom emits a well-formed L3 directive', () => {
    const spec = buildPolicies(OP)[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-plan-stage-validator-retry-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.provenance.kind).toBe('operator-seeded');
    const meta = atom.metadata as {
      policy: {
        subject: string;
        max_attempts: number;
        recoverable_error_patterns: readonly string[];
      };
    };
    expect(meta.policy.subject).toBe('plan-stage-validator-retry-default');
    expect(meta.policy.max_attempts).toBe(EXPECTED_DEFAULTS.max_attempts);
    expect(meta.policy.recoverable_error_patterns).toEqual(
      EXPECTED_DEFAULTS.recoverable_error_patterns,
    );
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
