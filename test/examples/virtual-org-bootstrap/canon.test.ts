/**
 * Canon atom fixture validation.
 *
 * `pol-two-principal-approve-for-l3-merges` is the L3 policy the
 * deliberation coordinator references by id: merges to main and
 * promotions to L3 canon require two distinct principal approvals.
 * Changing the rule is a canon edit, not a runtime override, so the
 * committed fixture IS the source of truth; the boot script loads it
 * into an AtomStore at startup.
 *
 * These tests pin down the fixture's shape so drift from the Atom
 * interface surfaces as a test failure (loud) rather than a silent
 * atom-store write-error at boot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Atom } from '../../../src/substrate/types.js';

const CANON_ATOM_URL = new URL(
  '../../../src/examples/virtual-org-bootstrap/canon/pol-two-principal-approve-for-l3-merges.json',
  import.meta.url,
);

function loadAtom(): Atom {
  return JSON.parse(readFileSync(fileURLToPath(CANON_ATOM_URL), 'utf8')) as Atom;
}

describe('pol-two-principal-approve-for-l3-merges fixture', () => {
  const atom = loadAtom();

  it('has the canonical id', () => {
    expect(atom.id).toBe('pol-two-principal-approve-for-l3-merges');
  });

  it('is layer L3', () => {
    expect(atom.layer).toBe('L3');
  });

  it('carries type=preference', () => {
    expect(atom.type).toBe('preference');
  });

  it('has confidence 1.0', () => {
    expect(atom.confidence).toBe(1);
  });

  it('is operator-seeded', () => {
    expect(atom.provenance.kind).toBe('operator-seeded');
  });

  it('is authored by helix-root', () => {
    expect(atom.principal_id).toBe('helix-root');
  });

  it('content mentions the two distinct principal requirement', () => {
    expect(atom.content).toMatch(/two distinct principals?/i);
  });

  it('policy metadata declares minimum approvers = 2', () => {
    const policy = (atom.metadata as { policy?: { minimum_distinct_approvers?: number } })
      .policy;
    expect(policy).toBeDefined();
    expect(policy!.minimum_distinct_approvers).toBe(2);
  });

  it('has no supersession or expiry (canonical, active)', () => {
    expect(atom.supersedes).toEqual([]);
    expect(atom.superseded_by).toEqual([]);
    expect(atom.expires_at).toBeNull();
  });

  it('is clean (no taint)', () => {
    expect(atom.taint).toBe('clean');
  });
});
