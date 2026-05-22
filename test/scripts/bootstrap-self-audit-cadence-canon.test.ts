/**
 * Drift tests for scripts/bootstrap-self-audit-cadence-canon.mjs.
 *
 * Seeds `pol-self-audit-cadence`, the L3 directive atom that gates the
 * LoopRunner self-audit pass. Default `enabled=false` +
 * `intervalMs=3_600_000` (1 hour) matches the runner's inline fallback
 * in `src/runtime/loop/runner.ts` so a fresh deployment running this
 * seed for the first time observes IDENTICAL behavior to its
 * pre-canon-policy run. The default-off posture is deliberate per the
 * indie-floor + org-ceiling discipline: a deployment running a
 * long-running daemon does not surprise-pay a substrate-deep pipeline
 * run at midnight on the first tick after upgrading.
 *
 * Tests:
 *   - buildPolicies returns the expected stable id.
 *   - The seeded fields match the runner's inline default
 *     (enabled=false, intervalMs=3600000).
 *   - policyAtom emits a well-formed L3 directive (id, type, layer,
 *     principal_id, scope, taint, provenance, schema_version).
 *   - The metadata.policy.subject identifies the seed surface.
 *   - File-host round-trip preserves the policy payload.
 *   - Idempotency: buildPolicies output is byte-identical across calls.
 *   - First write succeeds; second read returns the stored shape.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/self-audit-cadence-canon-policies.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

// Inline fallback defaults match the LoopRunner's resolution chain
// documented in src/runtime/loop/runner.ts: enabled=false (default-off)
// and intervalMs=3_600_000 (1 hour). The seed mirrors these so a
// deployment running this bootstrap for the first time observes
// identical behavior to its pre-canon-policy run.
const EXPECTED_DEFAULTS = {
  enabled: false,
  intervalMs: 60 * 60 * 1000,
} as const;

async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-self-audit-cadence-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-self-audit-cadence-canon POLICIES', () => {
  it('returns the single expected policy id', () => {
    const policies = buildPolicies(OP);
    expect(policies.map((p: { id: string }) => p.id)).toEqual([
      'pol-self-audit-cadence',
    ]);
  });

  it('seeded fields match the LoopRunner inline default (default-off, 1-hour cadence)', () => {
    // Drift guard: the runner falls back to enabled=false +
    // intervalMs=3600000 when no atom is seeded. The seed MUST match
    // that fallback so an operator-bootstrap is a no-op behavioral
    // change. Tightening to enabled=true here would silently activate
    // the self-audit pass on the first tick after upgrade.
    const spec = buildPolicies(OP)[0]!;
    expect(spec.fields.enabled).toBe(EXPECTED_DEFAULTS.enabled);
    expect(spec.fields.intervalMs).toBe(EXPECTED_DEFAULTS.intervalMs);
  });

  it('policyAtom emits a well-formed L3 directive', () => {
    const spec = buildPolicies(OP)[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-self-audit-cadence');
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
        enabled: boolean;
        intervalMs: number;
      };
    };
    expect(meta.policy.subject).toBe('self-audit-cadence');
    expect(meta.policy.enabled).toBe(EXPECTED_DEFAULTS.enabled);
    expect(meta.policy.intervalMs).toBe(EXPECTED_DEFAULTS.intervalMs);
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
      expect(stored!.id).toBe(expected.id);
      expect(stored!.layer).toBe(expected.layer);
      expect(stored!.principal_id).toBe(expected.principal_id);
      expect(stored!.metadata.policy).toEqual(expected.metadata.policy);
    }));

  it('first write succeeds; subsequent get returns the stored shape (idempotency smoke)', () =>
    withTempFileHost(async (host) => {
      const spec = buildPolicies(OP)[0]!;
      const expected = policyAtom(spec, OP);
      const firstExisting = await host.atoms.get(expected.id);
      expect(firstExisting).toBeNull();
      await host.atoms.put(expected);
      const secondExisting = await host.atoms.get(expected.id);
      expect(secondExisting).not.toBeNull();
      expect(secondExisting!.metadata.policy).toEqual(expected.metadata.policy);
    }));
});
