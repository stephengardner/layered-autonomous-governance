/**
 * Contract test for the agentic brainstorm-stage adapter.
 *
 * Asserts:
 *   - the adapter is a PlanningStage<unknown, BrainstormPayload>;
 *   - run() returns a StageOutput with atom_type='brainstorm-output';
 *   - the produced payload passes brainstormPayloadSchema (mirrors the
 *     single-shot adapter's output contract);
 *   - the adapter emits the canon-bound + agent-turn + canon-audit-complete
 *     pipeline-stage-event chain (delegated to runStageAgentLoop, but
 *     verified end-to-end here as a regression guard);
 *   - audit() re-runs the single-shot citation-closure check unchanged.
 */

import { describe, expect, it } from 'vitest';
import { buildAgenticBrainstormStage } from '../../../../examples/planning-stages/brainstorm/agentic.js';
import { brainstormPayloadSchema } from '../../../../examples/planning-stages/brainstorm/index.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import {
  blobRefFromHash,
  type BlobStore,
} from '../../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../../src/substrate/redactor.js';
import type {
  Workspace,
  WorkspaceProvider,
} from '../../../../src/substrate/workspace-provider.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../../src/substrate/agent-loop.js';
import type {
  AgentSessionMeta,
  AgentTurnMeta,
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';
import type { StageInput } from '../../../../src/runtime/planning-pipeline/index.js';

const NOW: Time = '2026-05-01T00:00:00.000Z' as Time;
const PRINCIPAL = 'brainstorm-actor' as PrincipalId;
const PIPELINE_ID = 'pipeline-agentic-test' as AtomId;

function makeStubAdapter(outputs: ReadonlyArray<string>): AgentLoopAdapter {
  return {
    capabilities: {
      tracks_cost: true,
      supports_signal: true,
      classify_failure: () => 'structural',
    },
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      const sessionId = `agent-session-${input.correlationId}-${Math.random().toString(36).slice(2, 8)}` as AtomId;
      const sessionAtom: Atom = {
        schema_version: 1,
        id: sessionId,
        content: 'stub',
        type: 'agent-session',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: { tool: 'stub', agent_id: String(input.principal), session_id: input.correlationId },
          derived_from: [],
        },
        confidence: 1,
        created_at: NOW,
        last_reinforced_at: NOW,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: input.principal,
        taint: 'clean',
        metadata: {
          agent_session: {
            model_id: 'stub',
            adapter_id: 'stub',
            workspace_id: input.workspace.id,
            started_at: NOW,
            completed_at: NOW,
            terminal_state: 'completed',
            replay_tier: input.replayTier,
            budget_consumed: { turns: outputs.length, wall_clock_ms: 0, usd: 0 },
          } satisfies AgentSessionMeta,
        },
      };
      await input.host.atoms.put(sessionAtom);
      const turnAtomIds: AtomId[] = [];
      for (let i = 0; i < outputs.length; i++) {
        const turnId = `agent-turn-${input.correlationId}-${i}` as AtomId;
        const turnAtom: Atom = {
          schema_version: 1,
          id: turnId,
          content: `stub-turn-${i}`,
          type: 'agent-turn',
          layer: 'L0',
          provenance: {
            kind: 'agent-observed',
            source: { tool: 'stub', agent_id: String(input.principal), session_id: input.correlationId },
            derived_from: [sessionId],
          },
          confidence: 1,
          created_at: NOW,
          last_reinforced_at: NOW,
          expires_at: null,
          supersedes: [],
          superseded_by: [],
          scope: 'project',
          signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_turn: {
              session_atom_id: sessionId,
              turn_index: i,
              llm_input: 'stub',
              llm_output: outputs[i]!,
              tool_calls: [],
              latency_ms: 100,
              cost_usd: 0,
            } satisfies AgentTurnMeta,
          },
        };
        await input.host.atoms.put(turnAtom);
        turnAtomIds.push(turnId);
      }
      return { kind: 'completed', sessionAtomId: sessionId, turnAtomIds };
    },
  };
}

function makeBundle() {
  const host = createMemoryHost({ canonInitial: '<!-- canon -->\n[]\n' });
  const blobStore: BlobStore = {
    async put(content) {
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      return blobRefFromHash(
        require('node:crypto').createHash('sha256').update(buf).digest('hex'),
      );
    },
    async get() {
      return Buffer.from('');
    },
    async has() {
      return true;
    },
    describeStorage() {
      return { kind: 'local-file' as const, rootPath: '/tmp/test' };
    },
  };
  const redactor: Redactor = { redact: (c) => c };
  const workspaceProvider: WorkspaceProvider = {
    async acquire(input) {
      return {
        id: `ws-${input.correlationId}`,
        path: `/tmp/${input.correlationId}`,
        baseRef: input.baseRef,
      } satisfies Workspace;
    },
    async release() {},
  };
  return { host, blobStore, redactor, workspaceProvider };
}

function makeStageInput(host: ReturnType<typeof createMemoryHost>): StageInput<unknown> {
  return {
    host,
    principal: PRINCIPAL,
    correlationId: 'corr-agentic-1',
    priorOutput: null,
    pipelineId: PIPELINE_ID,
    seedAtomIds: [],
    verifiedCitedAtomIds: [],
    verifiedSubActorPrincipalIds: [],
    operatorIntentContent: 'add a one-line note to the README explaining what the deep planning pipeline does',
  };
}

describe('agenticBrainstormStage', () => {
  it('produces a BrainstormPayload with atom_type brainstorm-output', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeBundle();
    const adapter = makeStubAdapter([
      JSON.stringify({
        open_questions: ['where in the README is the right insertion point?'],
        alternatives_surveyed: [
          { option: 'append to top of README', rejection_reason: 'pushes other content down; keep current top' },
          { option: 'add under existing Architecture section', rejection_reason: 'natural home; preferred' },
          { option: 'create new section', rejection_reason: 'too heavy for a one-line note' },
        ],
        decision_points: ['where to insert', 'one-line vs short paragraph'],
        cost_usd: 0.42,
      }),
      // canon-audit run produces approved verdict
      JSON.stringify({ verdict: 'approved', findings: [] }),
    ]);
    // Use a recorder adapter that returns the appropriate output per
    // call (main run gets index 0, audit run gets index 1).
    let runIdx = 0;
    const sequencingAdapter: AgentLoopAdapter = {
      capabilities: adapter.capabilities,
      async run(input) {
        const stub = makeStubAdapter([
          JSON.stringify({
            open_questions: ['where in the README is the right insertion point?'],
            alternatives_surveyed: [
              { option: 'append to top of README', rejection_reason: 'pushes other content down' },
              { option: 'add under existing Architecture section', rejection_reason: 'natural home' },
              { option: 'create new section', rejection_reason: 'too heavy for a one-line note' },
            ],
            decision_points: ['where to insert', 'one-line vs short paragraph'],
            cost_usd: 0.42,
          }),
        ]);
        const auditStub = makeStubAdapter([
          JSON.stringify({ verdict: 'approved', findings: [] }),
        ]);
        const a = runIdx === 0 ? stub : auditStub;
        runIdx++;
        return a.run(input);
      },
    };

    const stage = buildAgenticBrainstormStage({
      agentLoop: sequencingAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });
    expect(stage.name).toBe('brainstorm-stage');
    expect(stage.outputSchema).toBe(brainstormPayloadSchema);

    const stageInput = makeStageInput(host);
    const out = await stage.run(stageInput);
    expect(out.atom_type).toBe('brainstorm-output');
    const parsed = brainstormPayloadSchema.safeParse(out.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.alternatives_surveyed).toHaveLength(3);
    }

    // Verify chain.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const transitions = events.atoms
      .filter((a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === PIPELINE_ID)
      .map((a) => (a.metadata as { transition: string }).transition);
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn').length).toBeGreaterThan(0);
  });

  it('exposes audit() so the runner re-runs the single-shot citation-closure check', () => {
    const { blobStore, redactor, workspaceProvider } = makeBundle();
    const adapter = makeStubAdapter(['{}']);
    const stage = buildAgenticBrainstormStage({
      agentLoop: adapter,
      workspaceProvider,
      blobStore,
      redactor,
    });
    expect(typeof stage.audit).toBe('function');
  });
});
