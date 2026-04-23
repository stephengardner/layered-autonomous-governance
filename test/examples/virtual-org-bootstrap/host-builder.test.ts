/**
 * Host-builder composition tests.
 *
 * `buildVirtualOrgHost` assembles the 8-interface Host from
 * `createFileHost` (atoms, canon, auditor, clock, notifier, principals,
 * scheduler) + a caller-supplied LLM, then seeds the blast-radius fence
 * atoms via `seedFenceAtoms`. These tests pin the assembled surface and
 * the seeding invariants so a regression in either surfaces loud here
 * rather than at an integration boundary.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildVirtualOrgHost } from '../../../src/examples/virtual-org-bootstrap/host-builder.js';
import { MemoryLLM } from '../../../src/adapters/memory/llm.js';
import { MemoryClock } from '../../../src/adapters/memory/clock.js';
import type { LLM } from '../../../src/substrate/interface.js';
import type { AtomId, Principal, PrincipalId } from '../../../src/substrate/types.js';

const OPERATOR_ID = 'test-operator' as PrincipalId;

// Branded-id helpers keep the test free of `as any` casts while still
// permitting literal string construction (the branded-type convention
// the core types establish for every call site).
const asAtomId = (id: string): AtomId => id as AtomId;

function mockLlm(): LLM {
  return new MemoryLLM(new MemoryClock());
}

function testOperatorPrincipal(): Principal {
  return {
    id: OPERATOR_ID,
    name: 'Test Operator',
    role: 'root',
    active: true,
    signed_by: null,
    compromised_at: null,
    created_at: '2026-04-22T00:00:00.000Z',
    permitted_scopes: {
      read: ['session', 'project', 'user', 'global'],
      write: ['session', 'project', 'user', 'global'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1', 'L2', 'L3'],
    },
    goals: [],
    constraints: [],
  };
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'vo-host-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('buildVirtualOrgHost', () => {
  it('returns a Host satisfying the 8-interface contract', async () => {
    const { host, close } = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
      seedPrincipals: [testOperatorPrincipal()],
    });
    try {
      expect(host.atoms).toBeDefined();
      expect(host.canon).toBeDefined();
      expect(host.llm).toBeDefined();
      expect(host.notifier).toBeDefined();
      expect(host.scheduler).toBeDefined();
      expect(host.auditor).toBeDefined();
      expect(host.principals).toBeDefined();
      expect(host.clock).toBeDefined();
    } finally {
      await close();
    }
  });

  it('seeds the 4 pol-code-author-* fence atoms by default', async () => {
    const { host, close } = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
      seedPrincipals: [testOperatorPrincipal()],
    });
    try {
      const required = [
        'pol-code-author-signed-pr-only',
        'pol-code-author-per-pr-cost-cap',
        'pol-code-author-ci-gate',
        'pol-code-author-write-revocation-on-stop',
      ];
      for (const id of required) {
        const atom = await host.atoms.get(asAtomId(id));
        expect(atom, `fence atom ${id} missing`).not.toBeNull();
        expect(atom!.type).toBe('directive');
        expect(atom!.layer).toBe('L3');
        expect(atom!.confidence).toBe(1.0);
        expect(atom!.taint).toBe('clean');
        expect(atom!.principal_id).toBe(OPERATOR_ID);
        expect(atom!.provenance.kind).toBe('operator-seeded');
      }
    } finally {
      await close();
    }
  });

  it('skips fence seeding when skipSeed: true', async () => {
    const { host, close } = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
      skipSeed: true,
    });
    try {
      const atom = await host.atoms.get(asAtomId('pol-code-author-signed-pr-only'));
      expect(atom).toBeNull();
    } finally {
      await close();
    }
  });

  it('atoms persist across Host rebuilds when pointed at the same stateDir', async () => {
    const commonOpts = {
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
      seedPrincipals: [testOperatorPrincipal()],
      // Fence seeding is idempotent; default-on is fine but we want to
      // assert plain atom round-trip, not just seeded fences.
    };

    const first = await buildVirtualOrgHost(commonOpts);
    await first.host.atoms.put({
      schema_version: 1,
      id: asAtomId('test-atom-1'),
      content: 'hello round-trip',
      type: 'observation',
      layer: 'L0',
      provenance: {
        kind: 'agent-observed',
        source: { session_id: 'test', agent_id: 'test' },
        derived_from: [],
      },
      confidence: 0.5,
      created_at: new Date().toISOString(),
      last_reinforced_at: new Date().toISOString(),
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: OPERATOR_ID,
      taint: 'clean',
      metadata: {},
    });
    await first.close();

    const second = await buildVirtualOrgHost(commonOpts);
    try {
      const roundTripped = await second.host.atoms.get(asAtomId('test-atom-1'));
      expect(roundTripped).not.toBeNull();
      expect(roundTripped!.content).toBe('hello round-trip');
    } finally {
      await second.close();
    }
  });

  it('re-seeding is idempotent: a second build does not throw ConflictError', async () => {
    const first = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
      seedPrincipals: [testOperatorPrincipal()],
    });
    await first.close();

    // Same stateDir, default seeding on: the seeder must no-op on each
    // atom id that already exists. A naive put() would throw
    // ConflictError here. Second build omits seedPrincipals to
    // exercise the "operator already persisted from prior build"
    // case: file-backed principal store round-trips the record, so
    // the operator remains resolvable without re-registration.
    const second = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
    });
    try {
      const atom = await second.host.atoms.get(asAtomId('pol-code-author-signed-pr-only'));
      expect(atom).not.toBeNull();
    } finally {
      await second.close();
    }
  });

  it('throws synchronously when llm is missing', async () => {
    // An untyped caller (JS consumer, dynamic dispatch) could omit
    // llm; the builder must NOT silently fall through to
    // createFileHost's default. Fail-fast before any file-system work.
    await expect(
      buildVirtualOrgHost({
        stateDir,
        // @ts-expect-error: intentionally omitted to cover the runtime guard.
        llm: undefined,
        operatorPrincipalId: OPERATOR_ID,
        seedPrincipals: [testOperatorPrincipal()],
      }),
    ).rejects.toThrow(/llm/i);
  });

  it('throws synchronously when operatorPrincipalId is missing and skipSeed is false', async () => {
    await expect(
      buildVirtualOrgHost({
        stateDir,
        llm: mockLlm(),
        // @ts-expect-error: intentionally omitted to cover the runtime guard.
        operatorPrincipalId: undefined,
      }),
    ).rejects.toThrow(/operatorPrincipalId/i);
  });

  it('accepts a missing operatorPrincipalId when skipSeed: true', async () => {
    const { host, close } = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      skipSeed: true,
    });
    try {
      // No fence atoms should have been seeded; operatorPrincipalId was
      // unused, so the builder did not need it.
      const atom = await host.atoms.get(asAtomId('pol-code-author-signed-pr-only'));
      expect(atom).toBeNull();
    } finally {
      await close();
    }
  });

  it('throws when operatorPrincipalId is set but the principal is not registered', async () => {
    // Fence atoms attributed to an unregistered principal would taint
    // the authority chain: downstream arbitration relies on every
    // atom's principal_id resolving to a live Principal in the store.
    // A hardcoded operator id that the caller forgot to register must
    // fail fast rather than silently stamp fences with a dangling
    // author.
    await expect(
      buildVirtualOrgHost({
        stateDir,
        llm: mockLlm(),
        operatorPrincipalId: 'ghost-operator' as PrincipalId,
      }),
    ).rejects.toThrow(/ghost-operator/);
  });

  it('registers seedPrincipals into the host before fence seeding', async () => {
    // The caller can thread a list of principals through the builder so
    // the operator (and any other pre-seed principal) is registered
    // before fence seeding runs. This closes the chicken-and-egg gap
    // where the operator id in `operatorPrincipalId` must be resolvable
    // at fence-seed time but the only writable surface for principal
    // registration is the Host that is being built.
    const operatorPrincipal: Principal = {
      id: OPERATOR_ID,
      name: 'Test Operator',
      role: 'root',
      active: true,
      signed_by: null,
      compromised_at: null,
      created_at: '2026-04-22T00:00:00.000Z',
      permitted_scopes: {
        read: ['session', 'project', 'user', 'global'],
        write: ['session', 'project', 'user', 'global'],
      },
      permitted_layers: {
        read: ['L0', 'L1', 'L2', 'L3'],
        write: ['L0', 'L1', 'L2', 'L3'],
      },
      goals: [],
      constraints: [],
    };

    const { host, close } = await buildVirtualOrgHost({
      stateDir,
      llm: mockLlm(),
      operatorPrincipalId: OPERATOR_ID,
      seedPrincipals: [operatorPrincipal],
    });
    try {
      const registered = await host.principals.get(OPERATOR_ID);
      expect(registered).not.toBeNull();
      expect(registered!.id).toBe(OPERATOR_ID);
      const fence = await host.atoms.get(asAtomId('pol-code-author-signed-pr-only'));
      expect(fence).not.toBeNull();
      expect(fence!.principal_id).toBe(OPERATOR_ID);
    } finally {
      await close();
    }
  });
});
