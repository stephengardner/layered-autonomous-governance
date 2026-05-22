/**
 * Drift tests for scripts/bootstrap-loop-pass-claim-reaper-canon.mjs.
 *
 * Seeds `pol-loop-pass-claim-reaper-default`, the L3 directive atom
 * that gates whether the LoopRunner's claim-reaper pass fires on
 * every tick. Default `enabled=false` (default-off per indie-floor)
 * matches the runner's canon reader's fallback so a deployment
 * running this bootstrap for the first time observes IDENTICAL
 * behavior to its pre-canon-policy run.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/loop-pass-claim-reaper-canon-policies.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-loop-pass-claim-reaper-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-loop-pass-claim-reaper-canon POLICIES', () => {
  it('returns the single expected policy id', () => {
    expect(buildPolicies(OP).map((p: { id: string }) => p.id)).toEqual([
      'pol-loop-pass-claim-reaper-default',
    ]);
  });

  it('seeds enabled=false (default-off posture)', () => {
    // Drift guard: indie-floor seed ships enabled=false so an operator
    // bootstrapping a deployment does not surprise-pay reaper sweeps
    // on every tick. Flipping to true on a deployment that wants the
    // pass on every tick is a one-line higher-priority atom edit.
    const spec = buildPolicies(OP)[0]!;
    expect(spec.fields.enabled).toBe(false);
  });

  it('policyAtom emits a well-formed L3 directive', () => {
    const spec = buildPolicies(OP)[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-loop-pass-claim-reaper-default');
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.principal_id).toBe(OP);
    expect(atom.taint).toBe('clean');
    expect(atom.scope).toBe('project');
    expect(atom.confidence).toBe(1.0);
    expect(atom.provenance.kind).toBe('operator-seeded');
    const meta = atom.metadata as { policy: { subject: string; enabled: boolean } };
    expect(meta.policy.subject).toBe('loop-pass-claim-reaper-default');
    expect(meta.policy.enabled).toBe(false);
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
