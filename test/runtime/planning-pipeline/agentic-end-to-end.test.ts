/**
 * End-to-end deterministic test for the killer-pipeline upgrade.
 *
 * Composes:
 *   - the agentic brainstorm-stage adapter (stub-driven AgentLoopAdapter)
 *   - the existing single-shot spec / plan / review / dispatch adapters
 *   - the substrate runner (`runPipeline`)
 *
 * Asserts the chain integrity end-to-end:
 *   1. The pipeline atom exists and ends in pipeline_state='completed'
 *      (or paused at the brainstorm-stage's HIL gate -- canon defaults
 *      brainstorm to pause_mode='never').
 *   2. The brainstorm stage emits canon-bound + agent-turn +
 *      canon-audit-complete pipeline-stage-events.
 *   3. The substrate runner's enter + exit-success events are still
 *      emitted around the agentic stage (the runner is unchanged).
 *   4. The brainstorm-output atom matches `brainstormPayloadSchema`.
 *
 * Uses MemoryHost + a stub AgentLoopAdapter so the test is fully
 * deterministic and runs in the standard vitest pass without spawning
 * an LLM subprocess.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runPipeline } from '../../../src/runtime/planning-pipeline/index.js';
import { buildAgenticBrainstormStage } from '../../../examples/planning-stages/brainstorm/agentic.js';
import { brainstormPayloadSchema } from '../../../examples/planning-stages/brainstorm/index.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  blobRefFromHash,
  type BlobStore,
} from '../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../src/substrate/redactor.js';
import type {
  Workspace,
  WorkspaceProvider,
} from '../../../src/substrate/workspace-provider.js';
import type {
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
  PlanningStage,
} from '../../../src/substrate/agent-loop.js';
import type {
  AgentSessionMeta,
  AgentTurnMeta,
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../src/substrate/types.js';

const NOW: Time = '2026-05-01T00:00:00.000Z' as Time;
const PRINCIPAL = 'brainstorm-actor' as PrincipalId;

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

function makeStubAdapter(getOutputs: () => ReadonlyArray<string>): AgentLoopAdapter {
  return {
    capabilities: {
      tracks_cost: true,
      supports_signal: true,
      classify_failure: () => 'structural',
    },
    async run(input: AgentLoopInput): Promise<AgentLoopResult> {
      const outputs = getOutputs();
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

describe('killer-pipeline E2E (single agentic stage)', () => {
  it('runs an agentic brainstorm-stage end-to-end and emits the full chain', async () => {
    const { host, blobStore, redactor, workspaceProvider } = makeBundle();

    // Seed a synthetic operator-intent so the runner has a non-empty
    // seedAtomIds chain.
    const intentId = 'intent-e2e-1' as AtomId;
    const intentAtom: Atom = {
      schema_version: 1,
      id: intentId,
      content: 'add a one-line note to the README explaining the deep planning pipeline',
      type: 'operator-intent',
      layer: 'L0',
      provenance: {
        kind: 'user-directive',
        source: { tool: 'test', agent_id: 'operator', session_id: 'session-1' },
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
      principal_id: 'operator-principal' as PrincipalId,
      taint: 'clean',
      metadata: {},
    };
    await host.atoms.put(intentAtom);

    // Sequencing adapter: first call returns the brainstorm payload,
    // second call returns the canon-audit verdict. The agentic brainstorm
    // adapter calls the AgentLoopAdapter twice per stage run (main +
    // audit).
    let callIdx = 0;
    const sequenceAdapter: AgentLoopAdapter = {
      capabilities: {
        tracks_cost: true,
        supports_signal: true,
        classify_failure: () => 'structural',
      },
      async run(input) {
        const stub = makeStubAdapter(() => {
          if (callIdx === 0) {
            callIdx++;
            return [
              JSON.stringify({
                open_questions: [
                  'where in the README is the right insertion point?',
                  'one-line vs short paragraph?',
                ],
                alternatives_surveyed: [
                  { option: 'insert under existing Architecture section (selected)', rejection_reason: 'natural home for a pipeline pointer' },
                  { option: 'append to top of README', rejection_reason: 'would push the project tagline down; rejected' },
                  { option: 'create a new See Also section', rejection_reason: 'too heavy for a one-line addition; rejected' },
                ],
                decision_points: ['exact insertion point', 'phrasing'],
                cost_usd: 0.42,
              }),
            ];
          }
          callIdx++;
          return [JSON.stringify({ verdict: 'approved', findings: [] })];
        });
        return stub.run(input);
      },
    };

    const agenticBrainstorm = buildAgenticBrainstormStage({
      agentLoop: sequenceAdapter,
      workspaceProvider,
      blobStore,
      redactor,
      baseRef: 'main',
    });

    // Compose just the brainstorm stage (the rest of the pipeline is a
    // separate concern; this test isolates the agentic-stage chain).
    const stages: ReadonlyArray<PlanningStage> = [agenticBrainstorm];

    const result = await runPipeline(stages, host, {
      principal: PRINCIPAL,
      correlationId: 'corr-e2e-1',
      seedAtomIds: [intentId],
      stagePolicyAtomId: 'pol-test',
      mode: 'substrate-deep',
    });

    // The substrate's HIL policy default is 'always' when no policy
    // atom matches, so a single-stage pipeline run with no policy seed
    // halts at hil-paused after the stage completes successfully. The
    // chain integrity is what we assert; the HIL state is correct
    // substrate behaviour for an unconfigured pipeline.
    expect(['completed', 'hil-paused']).toContain(result.kind);
    if (result.kind !== 'completed' && result.kind !== 'hil-paused') return;

    // Walk the atom store for the chain.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 200);
    const ourEvents = events.atoms.filter(
      (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === result.pipelineId,
    );
    const transitions = ourEvents.map((a) => (a.metadata as { transition: string }).transition);

    // The runner emits enter around stage.run(); the helper emits
    // canon-bound, agent-turn (>=1), and canon-audit-complete. The
    // runner's exit-success or hil-pause event lands depending on HIL
    // policy; either is correct substrate behaviour.
    expect(transitions).toContain('enter');
    expect(transitions).toContain('canon-bound');
    expect(transitions).toContain('canon-audit-complete');
    expect(transitions.filter((t) => t === 'agent-turn').length).toBeGreaterThan(0);
    expect(
      transitions.includes('exit-success') || transitions.includes('hil-pause'),
    ).toBe(true);

    // The brainstorm-output atom is persisted by the runner; assert it
    // matches the schema.
    const outputs = await host.atoms.query({ type: ['brainstorm-output'] }, 50);
    const ourOutputs = outputs.atoms.filter(
      (a) => (a.metadata as { pipeline_id?: AtomId }).pipeline_id === result.pipelineId,
    );
    expect(ourOutputs.length).toBeGreaterThan(0);
    const stageOutput = ourOutputs[0]!;
    const stageMeta = stageOutput.metadata as { stage_output?: unknown };
    const parsed = brainstormPayloadSchema.safeParse(stageMeta.stage_output);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.alternatives_surveyed.length).toBeGreaterThanOrEqual(2);
    }
  });
});
