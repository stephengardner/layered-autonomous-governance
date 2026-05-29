import { describe, it, expect } from 'vitest';
import {
  assembleConversationForPipeline,
  assembleConversationForPlan,
  MAX_INLINE_CONTENT_CHARS,
  MAX_CONVERSATION_EVENTS,
} from './conversation-assembler';
import type { ConversationSourceAtom } from './conversation-types';

/*
 * Unit tests for the conversation-thread assembler.
 *
 * Pure-helper tests: feed atoms, assert on the discriminated-union
 * wire shape. No I/O, no globals, no time. Mirrors the test pattern
 * in pipeline-deliberation.test.ts and pipeline-lifecycle.test.ts.
 */

const NOW = Date.parse('2026-05-28T12:00:00.000Z');
const PIPELINE_ID = 'pipeline-cto-test-1';
const INTENT_ID = 'intent-test-1';
const PLAN_ID = 'plan-test-1';

function atom(
  partial: Partial<ConversationSourceAtom> & {
    id: string;
    type: string;
    created_at: string;
  },
): ConversationSourceAtom {
  return {
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    taint: 'clean',
    ...partial,
  };
}

function intent(overrides: { id?: string; created_at?: string; content?: string } = {}): ConversationSourceAtom {
  return atom({
    id: overrides.id ?? INTENT_ID,
    type: 'operator-intent',
    principal_id: 'apex-agent',
    created_at: overrides.created_at ?? '2026-05-28T10:00:00.000Z',
    content: overrides.content ?? 'Operator request: please write a hello world',
  });
}

function pipeline(overrides: { id?: string; intent_id?: string; created_at?: string } = {}): ConversationSourceAtom {
  return atom({
    id: overrides.id ?? PIPELINE_ID,
    type: 'pipeline',
    principal_id: 'cto-actor',
    created_at: overrides.created_at ?? '2026-05-28T10:05:00.000Z',
    metadata: { pipeline_id: overrides.id ?? PIPELINE_ID },
    provenance: { derived_from: [overrides.intent_id ?? INTENT_ID] },
  });
}

function stageEvent(overrides: { id: string; stage: string; transition: string; created_at: string; pipeline_id?: string }): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'pipeline-stage-event',
    created_at: overrides.created_at,
    content: `${overrides.stage}:${overrides.transition}`,
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
      stage_name: overrides.stage,
      transition: overrides.transition,
    },
    provenance: { derived_from: [overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function agentSession(overrides: { id: string; created_at: string; pipeline_id?: string }): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'agent-session',
    created_at: overrides.created_at,
    metadata: {
      session_id: overrides.id,
      started_at: overrides.created_at,
      agent_session: { model_id: 'claude-opus-4-7', adapter_id: 'claude-code' },
    },
    provenance: { derived_from: [overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function agentTurn(overrides: {
  id: string;
  created_at: string;
  session_atom_id: string;
  turn_index: number;
  llm_input?: string;
  llm_output?: string;
  tool_calls?: ReadonlyArray<{ name: string; args?: unknown; result?: unknown }>;
  latency_ms?: number;
  pipeline_id?: string;
  stage?: string;
}): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'agent-turn',
    created_at: overrides.created_at,
    metadata: {
      session_id: overrides.session_atom_id,
      stage_name: overrides.stage,
      agent_turn: {
        session_atom_id: overrides.session_atom_id,
        turn_index: overrides.turn_index,
        llm_input: { inline: overrides.llm_input ?? '' },
        llm_output: { inline: overrides.llm_output ?? '' },
        tool_calls: overrides.tool_calls ?? [],
        latency_ms: overrides.latency_ms ?? 100,
      },
    },
    provenance: { derived_from: [overrides.session_atom_id, overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function crossStageReprompt(overrides: {
  id: string;
  created_at: string;
  from_stage?: string;
  to_stage?: string;
  attempt?: number;
  severity?: 'critical' | 'major' | 'minor';
  thread_parent?: string | null;
  pipeline_id?: string;
}): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'pipeline-cross-stage-reprompt',
    created_at: overrides.created_at,
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
      correlation_id: 'corr-test',
      from_stage: overrides.from_stage ?? 'review-stage',
      to_stage: overrides.to_stage ?? 'plan-stage',
      attempt: overrides.attempt ?? 1,
      thread_parent: overrides.thread_parent === undefined ? null : overrides.thread_parent,
      verified_cited_atom_ids_origin: 'pipeline-seed',
      finding: {
        severity: overrides.severity ?? 'critical',
        category: 'drafter-refused',
        message: 'Plan needs revision',
        cited_atom_ids: [],
        cited_paths: [],
        reprompt_target: overrides.to_stage ?? 'plan-stage',
      },
    },
    provenance: { derived_from: [overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function auditFinding(overrides: {
  id: string;
  created_at: string;
  severity?: 'critical' | 'major' | 'minor' | 'info';
  pipeline_id?: string;
  stage?: string;
}): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'pipeline-audit-finding',
    created_at: overrides.created_at,
    content: 'Finding text',
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
      stage_name: overrides.stage ?? 'brainstorm-stage',
      severity: overrides.severity ?? 'major',
      category: 'fabricated-cited-atom',
      message: 'Finding text',
      cited_atom_ids: ['some-atom-id'],
    },
    provenance: { derived_from: [overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function stageOutput(overrides: {
  id: string;
  created_at: string;
  output_type: string;
  stage: string;
  content?: string;
  pipeline_id?: string;
}): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: overrides.output_type,
    created_at: overrides.created_at,
    content: overrides.content ?? '# Stage output\nbody here',
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
      stage_name: overrides.stage,
    },
    provenance: { derived_from: [overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function actorMessage(overrides: {
  id: string;
  created_at: string;
  sender?: string;
  recipient?: string;
  content?: string;
  pipeline_id?: string;
  urgency?: string;
}): ConversationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'actor-message',
    created_at: overrides.created_at,
    principal_id: overrides.sender ?? 'cto-actor',
    content: overrides.content ?? 'inter-agent ping',
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
      message: {
        sender_principal_id: overrides.sender ?? 'cto-actor',
        recipient_principal_id: overrides.recipient ?? 'code-author',
        content: overrides.content ?? 'inter-agent ping',
        urgency: overrides.urgency ?? 'normal',
      },
    },
    provenance: { derived_from: [overrides.pipeline_id ?? PIPELINE_ID] },
  });
}

function dispatchResult(overrides: {
  id: string;
  created_at: string;
  result_kind?: string;
  pr_url?: string | null;
  pipeline_id?: string;
  plan_id?: string;
}): ConversationSourceAtom {
  const metadata: Record<string, unknown> = {
    kind: 'code-author-invoked',
    pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
    plan_id: overrides.plan_id ?? PLAN_ID,
    executor_result: {
      kind: overrides.result_kind ?? 'ok',
      ...(overrides.pr_url ? { pr_url: overrides.pr_url } : {}),
    },
  };
  return atom({
    id: overrides.id,
    type: 'observation',
    created_at: overrides.created_at,
    principal_id: 'code-author',
    content: 'code-author invoked',
    metadata,
    provenance: { derived_from: [overrides.plan_id ?? PLAN_ID] },
  });
}

function planAtom(overrides: { id?: string; pipeline_id?: string; intent_id?: string; created_at?: string } = {}): ConversationSourceAtom {
  return atom({
    id: overrides.id ?? PLAN_ID,
    type: 'plan',
    created_at: overrides.created_at ?? '2026-05-28T10:30:00.000Z',
    content: '# Plan title\nbody',
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
    },
    provenance: {
      derived_from: [overrides.intent_id ?? INTENT_ID, overrides.pipeline_id ?? PIPELINE_ID],
    },
  });
}

describe('assembleConversationForPipeline', () => {
  describe('empty + 404', () => {
    it('returns null when atom set is empty', () => {
      const result = assembleConversationForPipeline([], PIPELINE_ID, NOW);
      expect(result).toBeNull();
    });

    it('returns null when no pipeline atom matches the id', () => {
      const result = assembleConversationForPipeline([intent()], PIPELINE_ID, NOW);
      expect(result).toBeNull();
    });

    it('returns empty events when pipeline exists but nothing else', () => {
      const result = assembleConversationForPipeline([pipeline()], PIPELINE_ID, NOW);
      expect(result).not.toBeNull();
      expect(result!.pipeline_id).toBe(PIPELINE_ID);
      expect(result!.intent_id).toBeNull();
      expect(result!.events).toEqual([]);
      expect(result!.computed_at).toBe('2026-05-28T12:00:00.000Z');
    });
  });

  describe('intent resolution', () => {
    it('resolves intent via pipeline.provenance.derived_from', () => {
      const atoms = [intent(), pipeline()];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      expect(result!.intent_id).toBe(INTENT_ID);
      expect(result!.events).toHaveLength(1);
      expect(result!.events[0].kind).toBe('operator-intent');
    });

    it('returns intent_id null when no operator-intent is in the chain', () => {
      const noIntent = pipeline();
      const result = assembleConversationForPipeline([noIntent], PIPELINE_ID, NOW);
      expect(result!.intent_id).toBeNull();
    });
  });

  describe('event projection', () => {
    it('emits stage-started for each pipeline-stage-event with transition=enter', () => {
      const atoms = [
        pipeline(),
        stageEvent({
          id: 'evt-1',
          stage: 'brainstorm-stage',
          transition: 'enter',
          created_at: '2026-05-28T10:06:00.000Z',
        }),
        stageEvent({
          id: 'evt-2',
          stage: 'brainstorm-stage',
          transition: 'exit-success',
          created_at: '2026-05-28T10:07:00.000Z',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const stageEvents = result!.events.filter((e) => e.kind === 'stage-started');
      expect(stageEvents).toHaveLength(1);
      expect(stageEvents[0]).toMatchObject({
        kind: 'stage-started',
        stage: 'brainstorm-stage',
      });
    });

    it('emits agent-prompt + agent-response for an agent-turn with both inline fields', () => {
      const sid = 'agent-session-1';
      const atoms = [
        pipeline(),
        agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' }),
        agentTurn({
          id: 'turn-1',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: 'What should we brainstorm?',
          llm_output: 'Here are 5 alternatives',
          latency_ms: 1500,
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const prompt = result!.events.find((e) => e.kind === 'agent-prompt');
      const response = result!.events.find((e) => e.kind === 'agent-response');
      expect(prompt).toBeDefined();
      expect(prompt).toMatchObject({
        kind: 'agent-prompt',
        turn_index: 0,
        session_atom_id: sid,
      });
      expect(response).toMatchObject({
        kind: 'agent-response',
        turn_index: 0,
        session_atom_id: sid,
        latency_ms: 1500,
      });
      if (prompt && 'body' in prompt) {
        expect(prompt.body.content).toBe('What should we brainstorm?');
        expect(prompt.body.content_truncated).toBe(false);
      }
    });

    it('skips agent-prompt when llm_input is empty (heartbeat case)', () => {
      const sid = 'agent-session-2';
      const atoms = [
        pipeline(),
        agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' }),
        agentTurn({
          id: 'turn-1',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: '',
          llm_output: 'operator-heartbeat',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const prompts = result!.events.filter((e) => e.kind === 'agent-prompt');
      const responses = result!.events.filter((e) => e.kind === 'agent-response');
      expect(prompts).toHaveLength(0);
      expect(responses).toHaveLength(1);
    });

    it('emits tool-call events for each entry in agent_turn.tool_calls', () => {
      const sid = 'agent-session-3';
      const atoms = [
        pipeline(),
        agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' }),
        agentTurn({
          id: 'turn-1',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: 'do stuff',
          llm_output: 'ok',
          tool_calls: [
            { name: 'Read', args: { path: '/foo' }, result: 'file contents' },
            { name: 'Edit', args: { file: '/bar', old: 'a', new: 'b' }, result: { ok: true } },
          ],
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const toolCalls = result!.events.filter((e) => e.kind === 'tool-call');
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]).toMatchObject({
        kind: 'tool-call',
        parent_turn_index: 0,
        session_atom_id: sid,
        tool_name: 'Read',
      });
      if (toolCalls[0].kind === 'tool-call') {
        expect(toolCalls[0].args).toContain('"path"');
        expect(toolCalls[0].result).toBe('file contents');
      }
    });

    it('emits cross-stage-reprompt events', () => {
      const atoms = [
        pipeline(),
        crossStageReprompt({
          id: 'reprompt-1',
          created_at: '2026-05-28T10:20:00.000Z',
          from_stage: 'review-stage',
          to_stage: 'plan-stage',
          attempt: 1,
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const handoffs = result!.events.filter((e) => e.kind === 'cross-stage-reprompt');
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]).toMatchObject({
        kind: 'cross-stage-reprompt',
        from_stage: 'review-stage',
        to_stage: 'plan-stage',
        attempt: 1,
        severity: 'critical',
      });
    });

    it('emits audit-finding events with normalized severity', () => {
      const atoms = [
        pipeline(),
        auditFinding({ id: 'find-1', created_at: '2026-05-28T10:15:00.000Z', severity: 'major' }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const findings = result!.events.filter((e) => e.kind === 'audit-finding');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        kind: 'audit-finding',
        severity: 'major',
        category: 'fabricated-cited-atom',
      });
    });

    it('emits stage-output events with summary line', () => {
      const atoms = [
        pipeline(),
        stageOutput({
          id: 'out-1',
          created_at: '2026-05-28T10:10:00.000Z',
          output_type: 'brainstorm-output',
          stage: 'brainstorm-stage',
          content: '# Brainstorm result\n\nfollowup line',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const outputs = result!.events.filter((e) => e.kind === 'stage-output');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({
        kind: 'stage-output',
        stage: 'brainstorm-stage',
        output_type: 'brainstorm-output',
      });
      if (outputs[0].kind === 'stage-output') {
        expect(outputs[0].summary).toBe('Brainstorm result');
      }
    });

    it('extracts a meaningful summary from JSON-content stage outputs', () => {
      const atoms = [
        pipeline(),
        stageOutput({
          id: 'out-json',
          created_at: '2026-05-28T10:10:00.000Z',
          output_type: 'spec-output',
          stage: 'spec-stage',
          content: JSON.stringify({
            summary: 'Add a README pointer to docs/framework.md',
            alternatives_surveyed: [],
            decision_points: [],
          }),
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const outputs = result!.events.filter((e) => e.kind === 'stage-output');
      expect(outputs).toHaveLength(1);
      if (outputs[0].kind === 'stage-output') {
        expect(outputs[0].summary).toBe('Add a README pointer to docs/framework.md');
      }
    });

    it('falls back to first non-empty line when JSON has no recognized summary field', () => {
      const atoms = [
        pipeline(),
        stageOutput({
          id: 'out-noname',
          created_at: '2026-05-28T10:10:00.000Z',
          output_type: 'brainstorm-output',
          stage: 'brainstorm-stage',
          content: JSON.stringify({ open_questions: ['q1'], alternatives_surveyed: [] }),
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const outputs = result!.events.filter((e) => e.kind === 'stage-output');
      expect(outputs).toHaveLength(1);
      if (outputs[0].kind === 'stage-output') {
        // No 'summary' / 'title' field, so we get the first non-empty line of the JSON string.
        expect(outputs[0].summary.length).toBeGreaterThan(0);
        expect(outputs[0].summary).not.toBe('{');
      }
    });

    it('emits inter-agent-message for actor-message atoms tied to the pipeline', () => {
      const atoms = [
        pipeline(),
        actorMessage({
          id: 'msg-1',
          created_at: '2026-05-28T10:11:00.000Z',
          sender: 'cto-actor',
          recipient: 'code-author',
          content: 'please draft this',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const msgs = result!.events.filter((e) => e.kind === 'inter-agent-message');
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({
        kind: 'inter-agent-message',
        recipient_principal_id: 'code-author',
      });
    });

    it('emits dispatch-result for code-author-invoked observation atoms', () => {
      const atoms = [
        pipeline(),
        dispatchResult({
          id: 'dispatch-1',
          created_at: '2026-05-28T10:25:00.000Z',
          result_kind: 'ok',
          pr_url: 'https://github.com/x/y/pull/123',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const dispatches = result!.events.filter((e) => e.kind === 'dispatch-result');
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        kind: 'dispatch-result',
        result: 'pr-opened',
        pr_url: 'https://github.com/x/y/pull/123',
      });
    });
  });

  describe('chronological ordering', () => {
    it('sorts events by ts ascending across all kinds', () => {
      const sid = 'agent-session-x';
      const atoms = [
        pipeline(),
        stageOutput({
          id: 'out-1',
          created_at: '2026-05-28T10:10:00.000Z',
          output_type: 'brainstorm-output',
          stage: 'brainstorm-stage',
        }),
        agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' }),
        stageEvent({
          id: 'evt-1',
          stage: 'brainstorm-stage',
          transition: 'enter',
          created_at: '2026-05-28T10:06:00.000Z',
        }),
        agentTurn({
          id: 'turn-1',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: 'what',
          llm_output: 'this',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const timestamps = result!.events.map((e) => e.ts);
      const sorted = [...timestamps].sort();
      expect(timestamps).toEqual(sorted);
    });
  });

  describe('truncation', () => {
    it('truncates inline content beyond MAX_INLINE_CONTENT_CHARS and flips the flag', () => {
      const sid = 'agent-session-big';
      const big = 'a'.repeat(MAX_INLINE_CONTENT_CHARS + 100);
      const atoms = [
        pipeline(),
        agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' }),
        agentTurn({
          id: 'turn-1',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: big,
          llm_output: 'ok',
        }),
      ];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const prompt = result!.events.find((e) => e.kind === 'agent-prompt');
      if (prompt && 'body' in prompt) {
        expect(prompt.body.content_truncated).toBe(true);
        expect(prompt.body.content.length).toBeLessThanOrEqual(MAX_INLINE_CONTENT_CHARS);
      }
    });
  });

  describe('hygiene', () => {
    it('skips superseded atoms', () => {
      const sid = 'agent-session-clean';
      const dirty = agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' });
      const supersededTurn: ConversationSourceAtom = {
        ...agentTurn({
          id: 'turn-bad',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: 'bad',
          llm_output: 'bad',
        }),
        superseded_by: ['turn-good'],
      };
      const atoms = [pipeline(), dirty, supersededTurn];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const prompts = result!.events.filter((e) => e.kind === 'agent-prompt');
      expect(prompts).toHaveLength(0);
    });

    it('skips tainted atoms', () => {
      const sid = 'agent-session-tainted';
      const taintedTurn: ConversationSourceAtom = {
        ...agentTurn({
          id: 'turn-bad',
          created_at: '2026-05-28T10:09:00.000Z',
          session_atom_id: sid,
          turn_index: 0,
          llm_input: 'bad',
          llm_output: 'bad',
        }),
        taint: 'compromised',
      };
      const atoms = [pipeline(), agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' }), taintedTurn];
      const result = assembleConversationForPipeline(atoms, PIPELINE_ID, NOW);
      const prompts = result!.events.filter((e) => e.kind === 'agent-prompt');
      expect(prompts).toHaveLength(0);
    });

    it('caps event count at MAX_CONVERSATION_EVENTS', () => {
      const sid = 'agent-session-big';
      const events: ConversationSourceAtom[] = [pipeline(), agentSession({ id: sid, created_at: '2026-05-28T10:08:00.000Z' })];
      for (let i = 0; i < MAX_CONVERSATION_EVENTS + 50; i += 1) {
        events.push(
          agentTurn({
            id: `turn-${i}`,
            created_at: `2026-05-28T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
            session_atom_id: sid,
            turn_index: i,
            llm_input: `prompt ${i}`,
            llm_output: `response ${i}`,
          }),
        );
      }
      const result = assembleConversationForPipeline(events, PIPELINE_ID, NOW);
      expect(result!.events.length).toBeLessThanOrEqual(MAX_CONVERSATION_EVENTS);
    });
  });
});

describe('assembleConversationForPlan', () => {
  it('returns null when the plan atom does not exist', () => {
    const result = assembleConversationForPlan([], PLAN_ID, NOW);
    expect(result).toBeNull();
  });

  it('resolves pipeline_id from plan metadata when present', () => {
    const atoms = [intent(), pipeline(), planAtom()];
    const result = assembleConversationForPlan(atoms, PLAN_ID, NOW);
    expect(result).not.toBeNull();
    expect(result!.plan_id).toBe(PLAN_ID);
    expect(result!.pipeline_id).toBe(PIPELINE_ID);
    expect(result!.intent_id).toBe(INTENT_ID);
  });

  it('returns pipeline_id null when the plan is not tied to a pipeline', () => {
    const orphan = atom({
      id: PLAN_ID,
      type: 'plan',
      created_at: '2026-05-28T10:30:00.000Z',
      content: '# Plan title\nbody',
      metadata: {},
      provenance: { derived_from: [] },
    });
    const result = assembleConversationForPlan([orphan], PLAN_ID, NOW);
    expect(result!.pipeline_id).toBeNull();
    expect(result!.events).toHaveLength(0);
  });

  it('includes events for the linked pipeline when resolved', () => {
    const atoms = [
      intent(),
      pipeline(),
      planAtom(),
      stageEvent({
        id: 'evt-1',
        stage: 'brainstorm-stage',
        transition: 'enter',
        created_at: '2026-05-28T10:06:00.000Z',
      }),
    ];
    const result = assembleConversationForPlan(atoms, PLAN_ID, NOW);
    const stageStarted = result!.events.filter((e) => e.kind === 'stage-started');
    expect(stageStarted).toHaveLength(1);
  });
});
