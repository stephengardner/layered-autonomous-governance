/**
 * Unit tests for buildAgenticCodeAuthorExecutor.
 *
 * The agentic executor composes substrate seams (AgentLoopAdapter,
 * WorkspaceProvider, BlobStore, Redactor) plus the per-actor policy
 * resolvers into a CodeAuthorExecutor implementation. These tests pin
 * the factory shape + the failure-mapping contract.
 */

import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { buildAgenticCodeAuthorExecutor } from '../../../src/runtime/actor-message/agentic-code-author-executor.js';
import type { Atom, AtomId, FailureKind, PrincipalId } from '../../../src/substrate/types.js';
import type {
  AgentLoopAdapter,
  AgentLoopResult,
  AdapterCapabilities,
} from '../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type { Workspace, WorkspaceProvider } from '../../../src/substrate/workspace-provider.js';
import type { BlobStore } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { GhClient } from '../../../src/external/github/index.js';
import type { CodeAuthorFence } from '../../../src/runtime/actors/code-author/fence.js';

const NOOP_CAPS: AdapterCapabilities = {
  tracks_cost: false,
  supports_signal: false,
  classify_failure: defaultClassifyFailure,
};

function stubWorkspaceProvider(): WorkspaceProvider {
  const ws: Workspace = { id: 'ws-test', path: '/tmp/lag-test', baseRef: 'main' };
  return {
    acquire: async () => ws,
    release: async () => undefined,
  };
}

function stubAdapter(result: AgentLoopResult): AgentLoopAdapter {
  return { capabilities: NOOP_CAPS, run: async () => result };
}

function mkPlanAtom(meta: Record<string, unknown> = { plan_state: 'approved' }): Atom {
  return {
    schema_version: 1,
    id: 'plan-test' as AtomId,
    content: '# test plan',
    type: 'plan',
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
    confidence: 1,
    created_at: '2026-04-25T00:00:00.000Z',
    last_reinforced_at: '2026-04-25T00:00:00.000Z',
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: meta,
  };
}

function mkFence(): CodeAuthorFence {
  return {
    signedPrOnly: {
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: [],
      require_app_identity: true,
    },
    perPrCostCap: {
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: 10,
      include_retries: true,
    },
    ciGate: {
      subject: 'code-author-ci-gate',
      required_checks: ['Node 22 on ubuntu-latest'],
      require_all: true,
      max_check_age_ms: 600_000,
    },
    writeRevocationOnStop: {
      subject: 'code-author-write-revocation',
      on_stop_action: 'close-pr-with-revocation-comment',
      draft_atoms_layer: 'L0',
      revocation_atom_type: 'code-author-revoked',
    },
    warnings: [],
  };
}

const NOOP_REDACTOR: Redactor = { redact: (s: string) => s };
const EMPTY_BLOB_STORE = {} as BlobStore;
const NOOP_GH_CLIENT = {} as GhClient;

interface BaseConfig {
  agentLoop: AgentLoopAdapter;
  workspaceProvider?: WorkspaceProvider;
  ghClient?: GhClient;
  host?: ReturnType<typeof createMemoryHost>;
  verifyCommitExists?: (workspacePath: string, sha: string) => Promise<void>;
}

// Pass-through verifier used by tests that exercise paths AFTER the
// SHA-verification gate. The production default spawns
// `git cat-file -e`, which cannot run against the stub workspace
// path `/tmp/lag-test`; injecting a no-op keeps the happy-path tests
// focused on what they pin (PR-create call shape, workspace release,
// failure-mapping table) without coupling them to the verifier.
const PASS_VERIFY: (workspacePath: string, sha: string) => Promise<void> = async () => undefined;

function buildExec(opts: BaseConfig) {
  const host = opts.host ?? createMemoryHost();
  return buildAgenticCodeAuthorExecutor({
    host,
    principal: 'agentic-code-author' as PrincipalId,
    actorType: 'code-author',
    agentLoop: opts.agentLoop,
    workspaceProvider: opts.workspaceProvider ?? stubWorkspaceProvider(),
    blobStore: EMPTY_BLOB_STORE,
    redactor: NOOP_REDACTOR,
    ghClient: opts.ghClient ?? NOOP_GH_CLIENT,
    owner: 'o',
    repo: 'r',
    baseRef: 'main',
    model: 'm',
    verifyCommitExists: opts.verifyCommitExists ?? PASS_VERIFY,
  });
}

async function run(executor: ReturnType<typeof buildExec>) {
  return executor.execute({
    plan: mkPlanAtom(),
    fence: mkFence(),
    correlationId: 'c',
    observationAtomId: 'obs-1' as AtomId,
  });
}

describe('buildAgenticCodeAuthorExecutor', () => {
  it('returns an object with an execute() method', () => {
    const host = createMemoryHost();
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: {} as AgentLoopAdapter,
      workspaceProvider: {} as WorkspaceProvider,
      blobStore: {} as BlobStore,
      redactor: {} as Redactor,
      ghClient: {} as GhClient,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'claude-opus-4-7',
    });
    expect(typeof executor.execute).toBe('function');
  });
});

describe('AgenticCodeAuthorExecutor success path', () => {
  it('returns dispatched with PR handle when adapter completes with artifacts', async () => {
    let createdPr: Record<string, unknown> | null = null;
    const ghStub = {
      rest: async (req: Record<string, unknown>) => {
        createdPr = req;
        return {
          number: 4242,
          html_url: 'https://example.test/pr/4242',
          url: 'https://example.test/api/pr/4242',
          node_id: 'PR_x',
          state: 'open',
        };
      },
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 'sess-1' as AtomId,
      turnAtomIds: ['turn-1' as AtomId],
      artifacts: { commitSha: 'sha-deadbeef', branchName: 'agentic/test', touchedPaths: ['README.md'] },
    });
    const executor = buildExec({ agentLoop: adapter, ghClient: ghStub });
    const result = await run(executor);
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.prNumber).toBe(4242);
    expect(result.commitSha).toBe('sha-deadbeef');
    expect(result.branchName).toBe('agentic/test');
    expect(result.touchedPaths).toEqual(['README.md']);
    expect(createdPr).not.toBeNull();
    expect((createdPr as { method: string }).method).toBe('POST');
    expect((createdPr as { path: string }).path).toBe('repos/o/r/pulls');
  });
});

describe('AgenticCodeAuthorExecutor failure mapping', () => {
  it('maps adapter "completed" with no artifacts to agentic/no-artifacts', async () => {
    const ghCalled = { count: 0 };
    const ghStub = {
      rest: async () => {
        ghCalled.count += 1;
        return {} as never;
      },
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 'sess-1' as AtomId,
      turnAtomIds: ['turn-1' as AtomId],
      // artifacts intentionally missing
    });
    const result = await run(buildExec({ agentLoop: adapter, ghClient: ghStub }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/no-artifacts');
    expect(ghCalled.count).toBe(0);
  });

  it('maps adapter "completed" with commitSha but no branchName to agentic/no-artifacts', async () => {
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 'sess-1' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'abc' },
    });
    const result = await run(buildExec({ agentLoop: adapter }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/no-artifacts');
  });

  // Failure-mapping table: every (result.kind x failure?.kind) cell.
  const cases: ReadonlyArray<{
    label: string;
    result: AgentLoopResult;
    expectedStage: string;
    expectedReasonContains?: string;
  }> = [
    {
      label: 'budget-exhausted, no failure',
      result: { kind: 'budget-exhausted', sessionAtomId: 's' as AtomId, turnAtomIds: [] },
      expectedStage: 'agentic/budget-exhausted',
      expectedReasonContains: 'agent loop hit budget cap',
    },
    {
      label: 'budget-exhausted with failure.kind transient',
      result: { kind: 'budget-exhausted', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'transient', reason: 'rl', stage: 'turn-x' } },
      expectedStage: 'agentic/budget-exhausted/transient',
      expectedReasonContains: 'rl',
    },
    {
      label: 'budget-exhausted with failure.kind structural',
      result: { kind: 'budget-exhausted', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'structural', reason: 'turn cap', stage: 'turn-cap' } },
      expectedStage: 'agentic/budget-exhausted/structural',
      expectedReasonContains: 'turn cap',
    },
    {
      label: 'budget-exhausted with failure.kind catastrophic',
      result: { kind: 'budget-exhausted', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'catastrophic', reason: 'host fault', stage: 'budget' } },
      expectedStage: 'agentic/budget-exhausted/catastrophic',
      expectedReasonContains: 'host fault',
    },
    {
      label: 'aborted, no failure',
      result: { kind: 'aborted', sessionAtomId: 's' as AtomId, turnAtomIds: [] },
      expectedStage: 'agentic/aborted',
      expectedReasonContains: 'agent loop aborted via signal',
    },
    {
      label: 'aborted with failure.kind transient',
      result: { kind: 'aborted', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'transient', reason: 'transient cancel', stage: 'turn' } },
      expectedStage: 'agentic/aborted/transient',
      expectedReasonContains: 'transient cancel',
    },
    {
      label: 'aborted with failure.kind structural',
      result: { kind: 'aborted', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'structural', reason: 'op-cancel', stage: 'turn' } },
      expectedStage: 'agentic/aborted/structural',
      expectedReasonContains: 'op-cancel',
    },
    {
      label: 'aborted with failure.kind catastrophic',
      result: { kind: 'aborted', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'catastrophic', reason: 'sig-fault', stage: 'turn' } },
      expectedStage: 'agentic/aborted/catastrophic',
      expectedReasonContains: 'sig-fault',
    },
    {
      label: 'error with failure.kind transient',
      result: { kind: 'error', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'transient', reason: 'rate limited', stage: 'turn-2' } },
      expectedStage: 'agentic/agent-loop/transient',
      expectedReasonContains: 'rate limited',
    },
    {
      label: 'error with failure.kind structural',
      result: { kind: 'error', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'structural', reason: 'agent stuck', stage: 'turn-5' } },
      expectedStage: 'agentic/agent-loop/structural',
      expectedReasonContains: 'agent stuck',
    },
    {
      label: 'error with failure.kind catastrophic',
      result: { kind: 'error', sessionAtomId: 's' as AtomId, turnAtomIds: [], failure: { kind: 'catastrophic', reason: 'redactor crashed', stage: 'redact' } },
      expectedStage: 'agentic/agent-loop/catastrophic',
      expectedReasonContains: 'redactor crashed',
    },
    {
      label: 'error with no failure record',
      result: { kind: 'error', sessionAtomId: 's' as AtomId, turnAtomIds: [] },
      expectedStage: 'agentic/agent-loop/unknown',
      expectedReasonContains: 'agent loop failed without structured FailureRecord',
    },
  ];

  for (const tc of cases) {
    it(`maps ${tc.label} -> ${tc.expectedStage}`, async () => {
      const result = await run(buildExec({ agentLoop: stubAdapter(tc.result) }));
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('unreachable');
      expect(result.stage).toBe(tc.expectedStage);
      if (tc.expectedReasonContains !== undefined) {
        expect(result.reason).toContain(tc.expectedReasonContains);
      }
    });
  }

  it('maps a thrown adapter error using classify_failure -> agentic/adapter-threw/<kind>', async () => {
    const throwingAdapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: false,
        supports_signal: false,
        classify_failure: (_err) => 'transient' as FailureKind,
      },
      run: async () => { throw new Error('boom'); },
    };
    const result = await run(buildExec({ agentLoop: throwingAdapter }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/adapter-threw/transient');
    expect(result.reason).toContain('boom');
  });

  it('maps WorkspaceProvider.acquire throw to agentic/workspace-acquire', async () => {
    const failingProvider: WorkspaceProvider = {
      acquire: async () => { throw new Error('disk full'); },
      release: async () => undefined,
    };
    const result = await run(buildExec({
      agentLoop: stubAdapter({
        kind: 'completed',
        sessionAtomId: 's' as AtomId,
        turnAtomIds: [],
        artifacts: { commitSha: 'a', branchName: 'b' },
      }),
      workspaceProvider: failingProvider,
    }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/workspace-acquire');
    expect(result.reason).toContain('disk full');
  });

  it('maps GhClient PR-create throw to agentic/pr-creation', async () => {
    const failingGh = {
      rest: async () => { throw new Error('gh-api 422'); },
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'sha', branchName: 'br' },
    });
    const result = await run(buildExec({ agentLoop: adapter, ghClient: failingGh }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/pr-creation');
    expect(result.reason).toContain('gh-api 422');
    // The branch reached the remote before pr-creation failed; the
    // failure surfaces `branchName` so the dispatch wrapper can
    // probe `gh pr list --head <branch>` for an orphaned PR on a
    // transient `gh REST pulls create` 5xx.
    expect(result.branchName).toBe('br');
  });

  it('always releases the workspace, even on adapter throw', async () => {
    const released = { count: 0 };
    const provider: WorkspaceProvider = {
      acquire: async () => ({ id: 'ws-x', path: '/tmp/x', baseRef: 'main' }),
      release: async () => { released.count += 1; },
    };
    const throwingAdapter: AgentLoopAdapter = {
      capabilities: NOOP_CAPS,
      run: async () => { throw new Error('boom'); },
    };
    await run(buildExec({ agentLoop: throwingAdapter, workspaceProvider: provider }));
    expect(released.count).toBe(1);
  });

  it('always releases the workspace on success', async () => {
    const released = { count: 0 };
    const provider: WorkspaceProvider = {
      acquire: async () => ({ id: 'ws-x', path: '/tmp/x', baseRef: 'main' }),
      release: async () => { released.count += 1; },
    };
    const ghStub = {
      rest: async () => ({
        number: 1,
        html_url: 'https://example.test/pr/1',
        url: 'https://example.test/api/pr/1',
        node_id: 'PR_y',
        state: 'open',
      }),
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'a', branchName: 'b' },
    });
    await run(buildExec({ agentLoop: adapter, workspaceProvider: provider, ghClient: ghStub }));
    expect(released.count).toBe(1);
  });
});

describe('AgenticCodeAuthorExecutor SHA verification', () => {
  it('short-circuits with agentic/sha-verification-failed when verifier rejects (fabricated SHA)', async () => {
    // Threat model regression: a misbehaving AgentLoopAdapter returns
    // a SHA that does not exist in the workspace. The executor MUST
    // detect this before any GhClient.createPr call so no remote
    // artifact is produced for an unverified commit.
    const ghCalled = { count: 0 };
    const ghStub = {
      rest: async () => {
        ghCalled.count += 1;
        return {} as never;
      },
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'fabricated-sha-not-on-disk', branchName: 'agentic/br' },
    });
    const verifyCalls: Array<{ path: string; sha: string }> = [];
    const verifyCommitExists = async (workspacePath: string, sha: string) => {
      verifyCalls.push({ path: workspacePath, sha });
      throw new Error('fatal: Not a valid object name fabricated-sha-not-on-disk');
    };
    const result = await run(buildExec({
      agentLoop: adapter,
      ghClient: ghStub,
      verifyCommitExists,
    }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/sha-verification-failed');
    expect(result.reason).toContain('fabricated-sha-not-on-disk');
    expect(result.reason).toContain('Not a valid object name');
    expect(result.branchName).toBe('agentic/br');
    // The verifier was consulted with the workspace path + SHA the
    // adapter returned.
    expect(verifyCalls).toEqual([{ path: '/tmp/lag-test', sha: 'fabricated-sha-not-on-disk' }]);
    // The PR-create path never fired -- no remote artifact for an
    // unverified commit.
    expect(ghCalled.count).toBe(0);
  });

  it('proceeds to PR creation when verifier resolves (real SHA)', async () => {
    let createdPr: Record<string, unknown> | null = null;
    const ghStub = {
      rest: async (req: Record<string, unknown>) => {
        createdPr = req;
        return {
          number: 7,
          html_url: 'https://example.test/pr/7',
          url: 'https://example.test/api/pr/7',
          node_id: 'PR_z',
          state: 'open',
        };
      },
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'real-sha', branchName: 'agentic/ok' },
    });
    const verifyCalls: Array<{ path: string; sha: string }> = [];
    const verifyCommitExists = async (workspacePath: string, sha: string) => {
      verifyCalls.push({ path: workspacePath, sha });
    };
    const result = await run(buildExec({
      agentLoop: adapter,
      ghClient: ghStub,
      verifyCommitExists,
    }));
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.prNumber).toBe(7);
    expect(verifyCalls).toEqual([{ path: '/tmp/lag-test', sha: 'real-sha' }]);
    expect(createdPr).not.toBeNull();
  });

  it('releases the workspace even when SHA verification fails', async () => {
    const released = { count: 0 };
    const provider: WorkspaceProvider = {
      acquire: async () => ({ id: 'ws-v', path: '/tmp/lag-v', baseRef: 'main' }),
      release: async () => { released.count += 1; },
    };
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'nope', branchName: 'br' },
    });
    const verifyCommitExists = async () => {
      throw new Error('object missing');
    };
    await run(buildExec({
      agentLoop: adapter,
      workspaceProvider: provider,
      verifyCommitExists,
    }));
    // Workspace release is non-negotiable; SHA-verification failure
    // is just another exit through the same try/finally as every
    // other failure mode.
    expect(released.count).toBe(1);
  });

  it('prefers provider.verifyCommitExists over the config override', async () => {
    // Substrate-purity check: when a provider declares the seam, the
    // executor calls IT and NOT the test override. This is what lets
    // non-git workspace providers implement the check natively.
    const providerCalls: Array<{ wsId: string; sha: string }> = [];
    const overrideCalls: Array<{ path: string; sha: string }> = [];
    const provider: WorkspaceProvider = {
      acquire: async () => ({ id: 'ws-pref', path: '/tmp/lag-pref', baseRef: 'main' }),
      release: async () => undefined,
      verifyCommitExists: async (workspace, sha) => {
        providerCalls.push({ wsId: workspace.id, sha });
      },
    };
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'verifiable-sha', branchName: 'agentic/pref' },
    });
    const verifyCommitExists = async (workspacePath: string, sha: string) => {
      overrideCalls.push({ path: workspacePath, sha });
      throw new Error('override should not be reached');
    };
    const ghStub = {
      rest: async () => ({
        number: 9,
        html_url: 'https://example.test/pr/9',
        url: 'https://example.test/api/pr/9',
        node_id: 'PR_p',
        state: 'open',
      }),
    } as unknown as GhClient;
    const result = await run(buildExec({
      agentLoop: adapter,
      workspaceProvider: provider,
      ghClient: ghStub,
      verifyCommitExists,
    }));
    expect(result.kind).toBe('dispatched');
    expect(providerCalls).toEqual([{ wsId: 'ws-pref', sha: 'verifiable-sha' }]);
    expect(overrideCalls).toEqual([]);
  });

  it('falls back to the config override when provider does not declare the seam', async () => {
    // Back-compat path: providers that have not yet implemented the
    // seam continue to use the test-injectable override. This keeps
    // existing adapters working without breaking changes.
    const overrideCalls: Array<{ path: string; sha: string }> = [];
    const provider: WorkspaceProvider = {
      acquire: async () => ({ id: 'ws-fb', path: '/tmp/lag-fb', baseRef: 'main' }),
      release: async () => undefined,
    };
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'fb-sha', branchName: 'agentic/fb' },
    });
    const verifyCommitExists = async (workspacePath: string, sha: string) => {
      overrideCalls.push({ path: workspacePath, sha });
    };
    const ghStub = {
      rest: async () => ({
        number: 11,
        html_url: 'https://example.test/pr/11',
        url: 'https://example.test/api/pr/11',
        node_id: 'PR_f',
        state: 'open',
      }),
    } as unknown as GhClient;
    const result = await run(buildExec({
      agentLoop: adapter,
      workspaceProvider: provider,
      ghClient: ghStub,
      verifyCommitExists,
    }));
    expect(result.kind).toBe('dispatched');
    expect(overrideCalls).toEqual([{ path: '/tmp/lag-fb', sha: 'fb-sha' }]);
  });
});

describe('AgenticCodeAuthorExecutor policy resolution', () => {
  it('surfaces malformed pol-replay-tier as agentic/policy-resolution', async () => {
    const host = createMemoryHost();
    // Seed a malformed replay-tier policy atom for the principal so the
    // loader throws.
    await host.atoms.put({
      schema_version: 1,
      id: 'pol-replay-tier-principal-agentic-code-author' as AtomId,
      content: '',
      type: 'directive',
      layer: 'L3',
      provenance: { kind: 'operator-seeded', source: { agent_id: 'op' }, derived_from: [] },
      confidence: 1,
      created_at: '2026-04-25T00:00:00.000Z',
      last_reinforced_at: '2026-04-25T00:00:00.000Z',
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
      principal_id: 'op' as PrincipalId,
      taint: 'clean',
      metadata: { kind: 'pol-replay-tier', tier: 'not-a-real-tier' },
    });
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 's' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'a', branchName: 'b' },
    });
    const result = await run(buildExec({ agentLoop: adapter, host }));
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('agentic/policy-resolution');
  });
});
