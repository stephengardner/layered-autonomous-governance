/**
 * Drift tests for scripts/bootstrap-autonomous-intent-canon.mjs.
 *
 * Seeds three L3 atoms that form the autonomous-intent substrate's
 * governance layer:
 *
 *   - pol-operator-intent-creation (directive): whitelist of principals
 *     allowed to author operator-intent atoms the approval tick honors.
 *     v1 ships with the configured operator principal only.
 *   - pol-plan-autonomous-intent-approve (directive): policy governing
 *     intent-based auto-approval of plans (trust envelope match).
 *   - dev-autonomous-intent-substrate-shape (directive): describes the
 *     authorization model so a future agent reading canon understands
 *     why operator-intent atoms by other principals are advisory.
 *
 * Tests lock the seed shape against the runtime reader expectations.
 * Pre-fix history: the bootstrap once wrote type='decision' instead of
 * 'directive', and the readIntentCreationPolicy query (filter
 * type=['directive']) fell through to the empty-allowlist fail-closed
 * path. The test exists so a future type-drift surfaces here, not in
 * a deployment running with no autonomous-intent approvals.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAutonomousIntentCanonSpecs,
  buildAtomFromSpec,
  buildAutonomousIntentCanonAtoms,
} from '../../scripts/lib/autonomous-intent-canon-atoms.mjs';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-autonomous-intent-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-autonomous-intent-canon SPECS', () => {
  it('returns the expected stable triple of atom ids', () => {
    const specs = buildAutonomousIntentCanonSpecs(OP);
    expect(specs.map((s: { id: string }) => s.id)).toEqual([
      'pol-operator-intent-creation',
      'pol-plan-autonomous-intent-approve',
      'dev-autonomous-intent-substrate-shape',
    ]);
  });

  it('rejects empty/missing operatorId loud (not silently)', () => {
    // Drift guard: silent acceptance would let a bootstrap proceed
    // with an empty principal_id, which the arbitration stack treats
    // as anonymous. Loud failure is the indie-floor + org-ceiling
    // discipline so a fresh deployment surfaces the missing env var
    // at bootstrap time, not at first-use.
    expect(() => buildAutonomousIntentCanonSpecs('')).toThrow(
      /operatorId is required/,
    );
    // @ts-expect-error - intentional type violation for runtime guard
    expect(() => buildAutonomousIntentCanonSpecs(null)).toThrow(
      /operatorId is required/,
    );
  });

  it('all three specs are type=directive (regression guard for the type=decision bug)', () => {
    // History: a prior bootstrap wrote type='decision' for one of
    // these seeds, and readIntentCreationPolicy filters type=
    // ['directive'], so every read fell through to the empty-
    // allowlist fail-closed path. The fix is locked here: every seed
    // is type='directive' or the test fails. A future re-introduction
    // surfaces immediately.
    const specs = buildAutonomousIntentCanonSpecs(OP);
    for (const spec of specs) {
      expect((spec as { type: string }).type).toBe('directive');
    }
  });

  it('pol-operator-intent-creation seeds the operator principal in allowed_principal_ids', () => {
    // v1 ships with operator-only authorship per spec section 4. The
    // tick treats non-whitelisted authors as non-authorizing
    // observations; widening the list is a conscious canon-edit moment
    // that broadens the authorization surface.
    const specs = buildAutonomousIntentCanonSpecs(OP);
    const intent = specs.find(
      (s: { id: string }) => s.id === 'pol-operator-intent-creation',
    );
    expect(intent).toBeDefined();
    const policy = (intent as { policy: { allowed_principal_ids: string[] } }).policy;
    expect(policy.allowed_principal_ids).toEqual([OP]);
  });

  it('buildAtomFromSpec emits a well-formed L3 directive', () => {
    const spec = buildAutonomousIntentCanonSpecs(OP)[0]!;
    const atom = buildAtomFromSpec(spec, OP);
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
  });

  it('rebuild is byte-identical (deterministic, no Date.now / Math.random leakage)', () => {
    const a = buildAutonomousIntentCanonAtoms(OP);
    const b = buildAutonomousIntentCanonAtoms(OP);
    expect(a).toEqual(b);
  });

  it('round-trips all three atoms through the file host with metadata preserved', () =>
    withTempFileHost(async (host) => {
      const atoms = buildAutonomousIntentCanonAtoms(OP);
      for (const atom of atoms) {
        await host.atoms.put(atom);
      }
      for (const expected of atoms) {
        const stored = await host.atoms.get(expected.id);
        expect(stored).not.toBeNull();
        expect(stored!.type).toBe(expected.type);
        expect(stored!.layer).toBe(expected.layer);
        expect(stored!.metadata).toEqual(expected.metadata);
      }
    }));
});
