/**
 * End-to-end boot wiring tests for the `--execute` path.
 *
 * Exercises the chain Decision -> Plan atom -> codeAuthorFn call, with
 * the deliberate() step replaced by an injected stub so no LLM
 * subprocess spawns under test. The assertion surface is the atom
 * store + the return shape after runDeliberation resolves.
 */

import { describe, expect, it, vi } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { InvokeResult } from '../../../src/runtime/actor-message/sub-actor-registry.js';
import {
  loadSeedPrincipals,
  parseExecutorArgs,
  runDeliberation,
} from '../../../src/examples/virtual-org-bootstrap/boot-lib.js';
import { fileURLToPath } from 'node:url';
import type { Decision } from '../../../src/substrate/deliberation/patterns.js';
import type { AtomId } from '../../../src/substrate/types.js';

const principalsDir = fileURLToPath(new URL('../../../src/examples/virtual-org-bootstrap/principals/', import.meta.url));

function makeCannedDecision(): Decision {
  return {
    id: 'dec-canned-001',
    type: 'decision',
    authorPrincipal: 'vo-cto',
    answer: 'proceed with the proposed change',
    resolving: 'q-canned-001',
    arbitrationTrace: [{
      candidateId: 'p-canned-1',
      principalId: 'vo-code-author',
      layer: 'L1',
      provenance: 'agent-inferred',
      principalDepth: 0,
      confidence: 1,
      score: 110000,
    }],
    created_at: new Date().toISOString(),
  };
}

// The deliberate injection is a newly-added seam (same shape as the
// real `deliberate` from coordinator.ts but injectable for tests). The
// stub emits the Decision through the sink the same way the real
// implementation does and returns the same shape.
const fakeDeliberate = async (opts: {
  readonly sink: (e: Decision) => Promise<void>;
}): Promise<Decision> => {
  const decision = makeCannedDecision();
  await opts.sink(decision);
  return decision;
};

describe('runDeliberation --execute integration', () => {
  it('materializes the Plan atom, calls codeAuthorFn with derived plan_id, and records PrOpenedAtom', async () => {
    const host = createMemoryHost();
    const codeAuthorFn = vi.fn(async (_h, payload, _c, _opts): Promise<InvokeResult> => {
      // Plan id surfaced at the seam is the derived plan-from-* id,
      // NOT the decision id. Asserting at the call site surfaces a
      // regression without a separate walk through the store.
      expect(payload.plan_id).toBe('plan-from-dec-canned-001');
      return {
        kind: 'dispatched',
        summary: 'code-author dispatched plan plan-from-dec-canned-001 as PR #42 (abc1234)',
      };
    });

    const seeds = loadSeedPrincipals({ dir: principalsDir })
      .filter((s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author');
    for (const s of seeds) await host.principals.put(s.principal);

    const question = {
      id: 'q-canned-001',
      type: 'question' as const,
      prompt: 'ship a one-line doc change',
      scope: ['bootstrap'],
      authorPrincipal: 'vo-cto',
      participants: ['vo-cto', 'vo-code-author'],
      roundBudget: 2,
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
    };

    const result = await runDeliberation({
      question,
      participants: seeds,
      atomStore: host.atoms,
      principalStore: host.principals,
      anthropic: { messages: { create: vi.fn() } } as never,
      canonAtoms: [],
      decidingPrincipal: 'vo-cto',
      execute: true,
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: codeAuthorFn as never,
      deliberate: fakeDeliberate as never,
      principalDepths: { 'vo-cto': 0, 'vo-code-author': 1 },
    });

    expect(result.outcome.type).toBe('decision');
    expect(result.execution).toBeDefined();
    expect(result.execution!.kind).toBe('pr-opened');

    const plan = await host.atoms.get('plan-from-dec-canned-001' as AtomId);
    expect(plan).not.toBeNull();
    expect(plan!.type).toBe('plan');
    expect(plan!.plan_state).toBe('executing');
    expect(codeAuthorFn).toHaveBeenCalledTimes(1);
  });

  it('runs execute:true with a memory host and injected codeAuthorFn + deliberate', async () => {
    // Exercises the execute-mode wiring on a memory-backed Host so the
    // seam stays testable without file-system state. Both codeAuthorFn
    // and deliberate are injected so no GitHub / git call and no LLM
    // round-trip happens under test; the assertion surface is the
    // PrOpenedAtom returned from the codeAuthorFn spy.
    const host = createMemoryHost();
    const codeAuthorFn = vi.fn(async (): Promise<InvokeResult> => ({
      kind: 'dispatched',
      summary: 'test PR #1 (xxx1111)',
    }));

    const seeds = loadSeedPrincipals({ dir: principalsDir })
      .filter((s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author');
    for (const s of seeds) await host.principals.put(s.principal);

    const result = await runDeliberation({
      question: {
        id: 'q-default-001',
        type: 'question',
        prompt: 'smoke',
        scope: ['bootstrap'],
        authorPrincipal: 'vo-cto',
        participants: ['vo-cto', 'vo-code-author'],
        roundBudget: 2,
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
        created_at: new Date().toISOString(),
      },
      participants: seeds,
      atomStore: host.atoms,
      principalStore: host.principals,
      anthropic: { messages: { create: vi.fn() } } as never,
      canonAtoms: [],
      decidingPrincipal: 'vo-cto',
      execute: true,
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: codeAuthorFn as never,
      deliberate: (async (o: { sink: (d: Decision) => Promise<void> }) => {
        const d: Decision = { ...makeCannedDecision(), id: 'dec-default-001', resolving: 'q-default-001' };
        await o.sink(d);
        return d;
      }) as never,
      principalDepths: { 'vo-cto': 0, 'vo-code-author': 1 },
    });

    expect(result.execution?.kind).toBe('pr-opened');
    expect(codeAuthorFn).toHaveBeenCalled();
  });
});

describe('parseExecutorArgs', () => {
  it('returns all defaults when no flags are set', () => {
    const result = parseExecutorArgs([], { cwd: '/tmp/cwd' });
    expect(result.known).toEqual({
      repoDir: '/tmp/cwd',
      owner: 'stephengardner',
      repo: 'layered-autonomous-governance',
      stateDir: '.lag/virtual-org-state',
      role: 'lag-ceo',
      model: 'claude-opus-4-7',
    });
    expect(result.rest).toEqual([]);
  });

  it('applies each flag override', () => {
    const result = parseExecutorArgs(
      [
        '--repo-dir', '/r',
        '--owner', 'o',
        '--repo', 'rr',
        '--state-dir', '/s',
        '--role', 'lag-cto',
        '--model', 'claude-sonnet-4-5',
      ],
      { cwd: '/cwd' },
    );
    expect(result.known).toEqual({
      repoDir: '/r',
      owner: 'o',
      repo: 'rr',
      stateDir: '/s',
      role: 'lag-cto',
      model: 'claude-sonnet-4-5',
    });
    expect(result.rest).toEqual([]);
  });

  it('passes unknown tokens through in order', () => {
    const result = parseExecutorArgs(
      ['--execute', 'prompt', '--role', 'lag-ceo', 'extra-positional'],
      { cwd: '/cwd' },
    );
    expect(result.known.role).toBe('lag-ceo');
    expect(result.rest).toEqual(['--execute', 'prompt', 'extra-positional']);
  });

  it('rejects an invalid --role value loudly', () => {
    expect(() =>
      parseExecutorArgs(['--role', 'lag-random'], { cwd: '/cwd' }),
    ).toThrow(/--role/);
  });

  it('rejects a --owner flag with missing value', () => {
    expect(() =>
      parseExecutorArgs(['--owner'], { cwd: '/cwd' }),
    ).toThrow(/--owner/);
  });
});
