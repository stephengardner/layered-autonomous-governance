/**
 * Drift tests for scripts/bootstrap-auditor-feedback-reprompt-canon.mjs.
 *
 * Seeds `pol-auditor-feedback-reprompt-default`, the L3 directive atom
 * that gates the deep planning pipeline's auditor-feedback re-prompt
 * loop. Default `max_attempts=2` + `severities_to_reprompt=['critical']`
 * matches the runner's hardcoded fallback in
 * `src/runtime/planning-pipeline/auditor-feedback-reprompt-config.ts`
 * (HARDCODED_DEFAULT) so a fresh deployment running this seed for the
 * first time observes IDENTICAL behavior to its pre-canon-policy run.
 *
 * Tests lock these together. A drift is a test failure, not a silent
 * runtime surprise.
 *
 * Covers:
 *   - buildPolicies returns the expected stable id.
 *   - The seeded fields match the runner's HARDCODED_DEFAULT.
 *   - policyAtom emits a well-formed L3 directive (id, type, layer,
 *     principal_id, scope, taint, provenance, schema_version).
 *   - The metadata.policy.subject identifies the seed surface.
 *   - File-host round-trip preserves the policy payload.
 *   - Idempotency: buildPolicies output is byte-identical across calls
 *     (no Date.now / Math.random leakage).
 *   - First write succeeds; second read returns the stored shape.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPolicies,
  policyAtom,
} from '../../scripts/lib/auditor-feedback-reprompt-canon-policies.mjs';
import { HARDCODED_DEFAULT } from '../../src/runtime/planning-pipeline/auditor-feedback-reprompt-config.js';
import { createFileHost } from '../../src/adapters/file/index.js';

const OP = 'test-operator';

async function withTempFileHost(
  fn: (host: Awaited<ReturnType<typeof createFileHost>>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-bootstrap-auditor-feedback-reprompt-'));
  try {
    const host = await createFileHost({ rootDir: dir });
    await fn(host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('bootstrap-auditor-feedback-reprompt-canon POLICIES', () => {
  it('returns the single expected policy id', () => {
    const policies = buildPolicies(OP);
    expect(policies.map((p: { id: string }) => p.id)).toEqual([
      'pol-auditor-feedback-reprompt-default',
    ]);
  });

  it('seeded fields match the runner HARDCODED_DEFAULT', () => {
    // Drift guard: HARDCODED_DEFAULT is the runner's fallback when no
    // policy atom exists. The seed MUST match so a deployment running
    // this bootstrap for the first time observes identical behavior to
    // its pre-canon-policy run. A drift here means the operator's first
    // bootstrap run silently changes pipeline posture.
    const spec = buildPolicies(OP)[0]!;
    expect(spec.fields.max_attempts).toBe(HARDCODED_DEFAULT.max_attempts);
    expect(spec.fields.severities_to_reprompt).toEqual(
      HARDCODED_DEFAULT.severities_to_reprompt,
    );
  });

  it('policyAtom emits a well-formed L3 directive', () => {
    const spec = buildPolicies(OP)[0]!;
    const atom = policyAtom(spec, OP);
    expect(atom.id).toBe('pol-auditor-feedback-reprompt-default');
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
      };
    };
    expect(meta.policy.subject).toBe('auditor-feedback-reprompt-default');
    expect(meta.policy.max_attempts).toBe(HARDCODED_DEFAULT.max_attempts);
    expect(meta.policy.severities_to_reprompt).toEqual(
      HARDCODED_DEFAULT.severities_to_reprompt,
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
