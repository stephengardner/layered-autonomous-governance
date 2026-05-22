/**
 * Unit + integration tests for resolveOutdatedThreadsAfterPush.
 *
 * Coverage shape (pins the substrate enforcement of the canonical
 * outdated-thread sweep discipline):
 *   1. 1 outdated thread -> 1 resolveReviewThread mutation + audit
 *      atom written with resolved=1.
 *   2. 0 outdated threads -> 0 mutations + audit atom written with
 *      resolved=0.
 *   3. resolveReviewThread mutation throws -> caller sees
 *      ResolveThreadsError + audit atom captures the error string.
 *   4. classifyReviewThreads pure-function bucketing across the three
 *      thread states.
 *   5. Integration: AgenticCodeAuthorExecutor success path triggers
 *      the sweep automatically without an explicit caller invocation.
 */

import { describe, it, expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  resolveOutdatedThreadsAfterPush,
  classifyReviewThreads,
  ResolveThreadsError,
} from '../../../src/runtime/actor-message/resolve-outdated-threads-after-push.js';
import { buildAgenticCodeAuthorExecutor } from '../../../src/runtime/actor-message/agentic-code-author-executor.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
} from '../../../src/substrate/types.js';
import type { GhClient } from '../../../src/external/github/index.js';
import type {
  AgentLoopAdapter,
  AgentLoopResult,
  AdapterCapabilities,
} from '../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../src/substrate/agent-loop.js';
import type {
  Workspace,
  WorkspaceProvider,
} from '../../../src/substrate/workspace-provider.js';
import type { BlobStore } from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type { CodeAuthorFence } from '../../../src/runtime/actors/code-author/fence.js';

interface RecordedGraphqlCall {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

interface ThreadFixture {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path?: string;
}

/**
 * Build a GhClient stub that scripts a single reviewThreads listing
 * page plus a configurable resolveReviewThread side-effect. Records
 * every call so tests assert the mutation count.
 */
function buildGhStub(opts: {
  readonly threads: ReadonlyArray<ThreadFixture>;
  readonly resolveBehavior?: (threadId: string) => Promise<unknown>;
}): { client: GhClient; calls: RecordedGraphqlCall[] } {
  const calls: RecordedGraphqlCall[] = [];
  const client = {
    rest: async () => undefined,
    raw: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    async graphql(query: string, variables: Record<string, unknown> = {}) {
      calls.push({ query, variables });
      if (query.includes('reviewThreads')) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: opts.threads,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        };
      }
      if (query.includes('resolveReviewThread')) {
        if (opts.resolveBehavior !== undefined) {
          return opts.resolveBehavior(String(variables['id']));
        }
        return {
          resolveReviewThread: {
            thread: { id: String(variables['id']), isResolved: true },
          },
        };
      }
      throw new Error(`unexpected graphql query: ${query.slice(0, 60)}`);
    },
  } as unknown as GhClient;
  return { client, calls };
}

describe('classifyReviewThreads', () => {
  it('buckets every thread into exactly one of three groups', () => {
    const { resolveTargets, stillCurrent, alreadyResolved } = classifyReviewThreads([
      { id: 't1', isResolved: false, isOutdated: true },
      { id: 't2', isResolved: false, isOutdated: false },
      { id: 't3', isResolved: true, isOutdated: false },
      // Already-resolved + outdated still bucketed as alreadyResolved.
      // isResolved is terminal and takes precedence over isOutdated.
      { id: 't4', isResolved: true, isOutdated: true },
    ]);
    expect(resolveTargets.map((t) => t.id)).toEqual(['t1']);
    expect(stillCurrent.map((t) => t.id)).toEqual(['t2']);
    expect(alreadyResolved.map((t) => t.id).sort()).toEqual(['t3', 't4']);
  });

  it('returns empty arrays for an empty input', () => {
    const r = classifyReviewThreads([]);
    expect(r.resolveTargets).toHaveLength(0);
    expect(r.stillCurrent).toHaveLength(0);
    expect(r.alreadyResolved).toHaveLength(0);
  });
});

describe('resolveOutdatedThreadsAfterPush', () => {
  const PR = { owner: 'o', repo: 'r', prNumber: 999 };

  it('resolves outdated threads + writes a single audit atom with the counts', async () => {
    const host = createMemoryHost();
    const { client, calls } = buildGhStub({
      threads: [
        { id: 'gid-A', isResolved: false, isOutdated: true, path: 'src/foo.ts' },
        { id: 'gid-B', isResolved: false, isOutdated: false, path: 'src/bar.ts' },
        { id: 'gid-C', isResolved: true, isOutdated: false, path: 'src/baz.ts' },
      ],
    });
    const result = await resolveOutdatedThreadsAfterPush({
      host,
      ghClient: client,
      principal: 'lag-pr-landing' as PrincipalId,
      ...PR,
      now: () => '2026-05-22T10:00:00.000Z',
      newSuffix: () => 'fixed-suffix',
    });
    expect(result.resolved).toBe(1);
    expect(result.stillCurrent).toBe(1);
    expect(result.alreadyResolved).toBe(1);
    expect(result.atomId).not.toBeNull();

    // One listing call + one resolve mutation.
    expect(calls.filter((c) => c.query.includes('reviewThreads'))).toHaveLength(1);
    const resolveCalls = calls.filter((c) => c.query.includes('resolveReviewThread'));
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]!.variables['id']).toBe('gid-A');

    // Audit atom carries the counters and the operator_action payload.
    const atom = await host.atoms.get(result.atomId!);
    expect(atom).not.toBeNull();
    expect(atom!.type).toBe('observation');
    expect(atom!.layer).toBe('L1');
    const opAction = (atom!.metadata as { operator_action: Record<string, unknown> }).operator_action;
    expect(opAction['kind']).toBe('resolve-outdated-threads');
    expect(opAction['resolved']).toBe(1);
    expect(opAction['still_current']).toBe(1);
    expect(opAction['already_resolved']).toBe(1);
    expect(opAction['pr']).toEqual({ owner: 'o', repo: 'r', number: 999 });
  });

  it('writes an audit atom with resolved=0 when no threads are outdated', async () => {
    const host = createMemoryHost();
    const { client, calls } = buildGhStub({
      threads: [
        { id: 'gid-C', isResolved: true, isOutdated: false },
      ],
    });
    const result = await resolveOutdatedThreadsAfterPush({
      host,
      ghClient: client,
      principal: 'lag-pr-landing' as PrincipalId,
      ...PR,
      now: () => '2026-05-22T10:00:00.000Z',
      newSuffix: () => 'no-op-suffix',
    });
    expect(result.resolved).toBe(0);
    expect(result.stillCurrent).toBe(0);
    expect(result.alreadyResolved).toBe(1);
    // Zero mutation calls when there's nothing to resolve.
    expect(calls.filter((c) => c.query.includes('resolveReviewThread'))).toHaveLength(0);
    const atom = await host.atoms.get(result.atomId!);
    const opAction = (atom!.metadata as { operator_action: Record<string, unknown> }).operator_action;
    expect(opAction['resolved']).toBe(0);
  });

  it('rejects with ResolveThreadsError when the mutation throws + records an error audit atom', async () => {
    const host = createMemoryHost();
    const { client } = buildGhStub({
      threads: [{ id: 'gid-A', isResolved: false, isOutdated: true }],
      resolveBehavior: async () => { throw new Error('graphql 503'); },
    });
    await expect(resolveOutdatedThreadsAfterPush({
      host,
      ghClient: client,
      principal: 'lag-pr-landing' as PrincipalId,
      ...PR,
      now: () => '2026-05-22T10:00:00.000Z',
      newSuffix: () => 'err-suffix',
    })).rejects.toBeInstanceOf(ResolveThreadsError);

    // The audit atom records the failure even though the helper rejected.
    const page = await host.atoms.query({ type: ['observation'] }, 10);
    const errorAtom = page.atoms.find((a) => {
      const op = (a.metadata as { operator_action?: Record<string, unknown> }).operator_action;
      return op !== undefined && op['kind'] === 'resolve-outdated-threads' && op['error'] !== undefined;
    });
    expect(errorAtom).toBeDefined();
    const opAction = (errorAtom!.metadata as { operator_action: Record<string, unknown> }).operator_action;
    expect(String(opAction['error'])).toContain('failed to resolve thread gid-A');
  });

  it('rejects with ResolveThreadsError when the listing throws + records the failure', async () => {
    const host = createMemoryHost();
    const client = {
      rest: async () => undefined,
      raw: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      graphql: async () => { throw new Error('graphql 502'); },
    } as unknown as GhClient;
    await expect(resolveOutdatedThreadsAfterPush({
      host,
      ghClient: client,
      principal: 'lag-pr-landing' as PrincipalId,
      ...PR,
      now: () => '2026-05-22T10:00:00.000Z',
      newSuffix: () => 'list-err',
    })).rejects.toBeInstanceOf(ResolveThreadsError);
    const page = await host.atoms.query({ type: ['observation'] }, 10);
    expect(page.atoms.length).toBeGreaterThan(0);
    const errAtom = page.atoms.find((a) => {
      const op = (a.metadata as { operator_action?: Record<string, unknown> }).operator_action;
      return op !== undefined && op['error'] !== undefined;
    });
    expect(errAtom).toBeDefined();
  });

  it('rejects with ResolveThreadsError when reviewThreads payload is missing', async () => {
    // A repo/PR lookup failure (deleted PR, wrong owner/repo, auth
    // scope drop) returns the GraphQL envelope with `repository: null`.
    // The helper must treat this as a hard error rather than silently
    // returning resolved=0, because a `resolved=0` audit atom would
    // misrepresent a query-shape failure as a successful no-op sweep.
    const host = createMemoryHost();
    const client = {
      rest: async () => undefined,
      raw: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      graphql: async () => ({ repository: null }),
    } as unknown as GhClient;
    await expect(resolveOutdatedThreadsAfterPush({
      host,
      ghClient: client,
      principal: 'lag-pr-landing' as PrincipalId,
      ...PR,
      now: () => '2026-05-22T10:00:00.000Z',
      newSuffix: () => 'missing-payload',
    })).rejects.toThrow(/reviewThreads query returned no payload/);
  });

  it('reports partial-progress resolved count on a mid-loop mutation failure', async () => {
    // The first thread resolves successfully; the second throws. The
    // error-path audit atom must record `resolved: 1` (not 0) so an
    // incident reader sees the partial progress. Pre-fix the audit
    // atom under-reported every partial sweep as resolved=0.
    const host = createMemoryHost();
    const client = {
      rest: async () => undefined,
      raw: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      async graphql(query: string, variables: Record<string, unknown> = {}) {
        if (query.includes('reviewThreads')) {
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { id: 'gid-1', isResolved: false, isOutdated: true },
                    { id: 'gid-2', isResolved: false, isOutdated: true },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        const id = String(variables['id']);
        if (id === 'gid-2') throw new Error('graphql 503');
        return {
          resolveReviewThread: { thread: { id, isResolved: true } },
        };
      },
    } as unknown as GhClient;
    await expect(resolveOutdatedThreadsAfterPush({
      host,
      ghClient: client,
      principal: 'lag-pr-landing' as PrincipalId,
      ...PR,
      now: () => '2026-05-22T10:00:00.000Z',
      newSuffix: () => 'partial',
    })).rejects.toBeInstanceOf(ResolveThreadsError);
    const page = await host.atoms.query({ type: ['observation'] }, 10);
    const errorAtom = page.atoms.find((a) => {
      const op = (a.metadata as { operator_action?: Record<string, unknown> }).operator_action;
      return op !== undefined && op['error'] !== undefined;
    });
    expect(errorAtom).toBeDefined();
    const opAction = (errorAtom!.metadata as { operator_action: Record<string, unknown> }).operator_action;
    expect(opAction['resolved']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: the agentic-code-author-executor success path now invokes
// the helper automatically. This test pins the wiring so a future refactor
// that drops the call line in the executor fails loud.
// ---------------------------------------------------------------------------

const NOOP_CAPS: AdapterCapabilities = {
  tracks_cost: false,
  supports_signal: false,
  classify_failure: defaultClassifyFailure,
};

function stubWorkspaceProvider(): WorkspaceProvider {
  const ws: Workspace = { id: 'ws-x', path: '/tmp/lag-test', baseRef: 'main' };
  return { acquire: async () => ws, release: async () => undefined };
}

function stubAdapter(result: AgentLoopResult): AgentLoopAdapter {
  return { capabilities: NOOP_CAPS, run: async () => result };
}

function mkPlanAtom(): Atom {
  return {
    schema_version: 1,
    id: 'plan-test' as AtomId,
    content: '# plan',
    type: 'plan',
    layer: 'L1',
    provenance: { kind: 'agent-observed', source: { agent_id: 'cto-actor' }, derived_from: [] },
    confidence: 1,
    created_at: '2026-05-22T10:00:00.000Z',
    last_reinforced_at: '2026-05-22T10:00:00.000Z',
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: { plan_state: 'approved' },
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

describe('AgenticCodeAuthorExecutor + resolve-outdated-threads wiring', () => {
  it('invokes the thread-resolution helper after the PR-create REST call succeeds', async () => {
    const host = createMemoryHost();
    const graphqlCalls: RecordedGraphqlCall[] = [];
    // ghStub: rest() responds to the PR-create POST; graphql() responds
    // to the reviewThreads listing + any resolve mutation.
    const ghStub = {
      rest: async (req: Record<string, unknown>) => {
        // Pin the path so a wiring change to a different REST surface
        // fails this test rather than passing on accident.
        expect((req as { method?: string }).method).toBe('POST');
        expect((req as { path?: string }).path).toBe('repos/o/r/pulls');
        return {
          number: 7777,
          html_url: 'https://example.test/pr/7777',
          url: 'https://example.test/api/pr/7777',
          node_id: 'PR_z',
          state: 'open',
        };
      },
      async graphql(query: string, variables: Record<string, unknown> = {}) {
        graphqlCalls.push({ query, variables });
        if (query.includes('reviewThreads')) {
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { id: 'gid-1', isResolved: false, isOutdated: true, path: 'src/foo.ts' },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        return {
          resolveReviewThread: {
            thread: { id: String(variables['id']), isResolved: true },
          },
        };
      },
      raw: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as GhClient;

    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 'sess-1' as AtomId,
      turnAtomIds: ['turn-1' as AtomId],
      artifacts: { commitSha: 'sha-xyz', branchName: 'agentic/wired', touchedPaths: ['src/foo.ts'] },
    });

    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: adapter,
      workspaceProvider: stubWorkspaceProvider(),
      blobStore: EMPTY_BLOB_STORE,
      redactor: NOOP_REDACTOR,
      ghClient: ghStub,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'm',
      verifyCommitExists: async () => undefined,
    });

    const result = await executor.execute({
      plan: mkPlanAtom(),
      fence: mkFence(),
      correlationId: 'c',
      observationAtomId: 'obs-1' as AtomId,
    });

    expect(result.kind).toBe('dispatched');

    // The listing query AND the resolve mutation both fired on the same
    // executor.execute() call, proving the wiring is live.
    expect(graphqlCalls.filter((c) => c.query.includes('reviewThreads')).length).toBe(1);
    expect(graphqlCalls.filter((c) => c.query.includes('resolveReviewThread')).length).toBe(1);

    // The sweep wrote an operator-action audit atom for the PR.
    const page = await host.atoms.query({ type: ['observation'] }, 10);
    const sweepAtom = page.atoms.find((a) => {
      const op = (a.metadata as { operator_action?: Record<string, unknown> }).operator_action;
      return op !== undefined && op['kind'] === 'resolve-outdated-threads';
    });
    expect(sweepAtom).toBeDefined();
    const opAction = (sweepAtom!.metadata as { operator_action: Record<string, unknown> }).operator_action;
    expect(opAction['resolved']).toBe(1);
    expect((opAction['pr'] as { number: number }).number).toBe(7777);
  });

  it('does NOT fail the dispatch when the resolve sweep throws', async () => {
    // Failure of the post-PR sweep MUST NOT roll back the PR-creation
    // success. This is the executor safety net so an actor flow never
    // reports failure for a glitch in an audit-side helper.
    const host = createMemoryHost();
    const ghStub = {
      rest: async () => ({
        number: 8888,
        html_url: 'https://example.test/pr/8888',
        url: 'https://example.test/api/pr/8888',
        node_id: 'PR_q',
        state: 'open',
      }),
      // Listing throws. The helper rejects with ResolveThreadsError
      // and the executor catch swallows.
      graphql: async () => { throw new Error('graphql 500'); },
      raw: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      executor: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    } as unknown as GhClient;
    const adapter = stubAdapter({
      kind: 'completed',
      sessionAtomId: 'sess-2' as AtomId,
      turnAtomIds: [],
      artifacts: { commitSha: 'sha-yyy', branchName: 'agentic/b2' },
    });
    const executor = buildAgenticCodeAuthorExecutor({
      host,
      principal: 'agentic-code-author' as PrincipalId,
      actorType: 'code-author',
      agentLoop: adapter,
      workspaceProvider: stubWorkspaceProvider(),
      blobStore: EMPTY_BLOB_STORE,
      redactor: NOOP_REDACTOR,
      ghClient: ghStub,
      owner: 'o',
      repo: 'r',
      baseRef: 'main',
      model: 'm',
      verifyCommitExists: async () => undefined,
    });
    const result = await executor.execute({
      plan: mkPlanAtom(),
      fence: mkFence(),
      correlationId: 'c',
      observationAtomId: 'obs-2' as AtomId,
    });
    // Even with the sweep failing, the dispatch result lands.
    expect(result.kind).toBe('dispatched');
  });
});
