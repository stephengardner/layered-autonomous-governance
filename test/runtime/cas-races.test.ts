/**
 * CAS race tests for the runtime read-modify-write call sites that
 * adopt `expectedRevision` from PR #440 + PR #448.
 *
 * Goal: for each plan-state transition that two writers can race,
 * stage two concurrent writers via `Promise.all` and assert exactly
 * one succeeds + the loser observes ConflictError + the loser
 * subsequently reads the winner's terminal state.
 *
 * Adapter: MemoryAtomStore declares `hasStrictCrossProcessCas=false`
 * (best-effort, in-process CAS only). Tests run two concurrent
 * writers in the SAME process; the same-process CAS semantics hold
 * per the conformance spec, so the race tests exercise the
 * substrate guarantee that the strict adapter (SqliteAtomStore)
 * also makes.
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { ConflictError } from '../../src/substrate/errors.js';
import {
  bindAnswer,
  askQuestion,
  expirePastDueQuestions,
} from '../../src/runtime/questions/index.js';
import {
  markPipelineReaped,
  markStageAtomReaped,
} from '../../src/runtime/plans/pipeline-reaper.js';
import { transitionPlanState } from '../../src/runtime/plans/state.js';
import { runWithCas } from '../../src/runtime/util/cas-retry.js';
import { samplePlanAtom } from '../fixtures.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';

function pipelineAtom(id: string, overrides: Partial<Atom> = {}): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'pipeline body',
    type: 'pipeline',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: '2026-01-01T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    metadata: {},
    pipeline_state: 'completed',
    ...overrides,
  };
}

function questionAtom(id: string, overrides: Partial<Atom> = {}): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'question?',
    type: 'question',
    layer: 'L1',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: 'user_1' },
      derived_from: [],
    },
    confidence: 0.5,
    created_at: '2026-01-01T00:00:00.000Z' as Time,
    last_reinforced_at: '2026-01-01T00:00:00.000Z' as Time,
    expires_at: '2026-01-02T00:00:00.000Z' as Time,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'user_1' as PrincipalId,
    taint: 'clean',
    metadata: {},
    question_state: 'pending',
    ...overrides,
  };
}

/**
 * Count Promise.all outcomes: how many settled+fulfilled, how many
 * rejected with ConflictError, how many rejected with something else
 * (the test asserts on this to surface unexpected error shapes).
 */
function countOutcomes(results: PromiseSettledResult<unknown>[]) {
  let fulfilled = 0;
  let conflictRejected = 0;
  let otherRejected = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') fulfilled += 1;
    else if (r.reason instanceof ConflictError) conflictRejected += 1;
    else otherRejected += 1;
  }
  return { fulfilled, conflictRejected, otherRejected };
}

describe('CAS races on runtime read-modify-write call sites', () => {
  describe('transitionPlanState (src/runtime/plans/state.ts)', () => {
    it('proposed -> approved: exactly one writer wins, loser sees ConflictError', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-race-1', '2026-01-01T00:00:00.000Z', {
        plan_state: 'proposed',
      });
      await host.atoms.put(plan);

      // Two concurrent writers attempting proposed -> approved on the
      // same plan id. transitionPlanState reads the plan + passes
      // expectedRevision; one of the two reads observes revision 0,
      // both attempt the write with expectedRevision=0, the loser
      // sees ConflictError because the first write bumped revision
      // to 1.
      const outcomes = await Promise.allSettled([
        transitionPlanState(plan.id, 'approved', host, 'tester-1' as PrincipalId),
        transitionPlanState(plan.id, 'approved', host, 'tester-2' as PrincipalId),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.conflictRejected).toBe(1);
      expect(counts.otherRejected).toBe(0);

      const after = await host.atoms.get(plan.id);
      expect(after?.plan_state).toBe('approved');
      expect(after?.revision).toBe(1);
    });

    it('approved -> executing: exactly one writer wins', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-race-2', '2026-01-01T00:00:00.000Z', {
        plan_state: 'approved',
      });
      await host.atoms.put(plan);

      const outcomes = await Promise.allSettled([
        transitionPlanState(plan.id, 'executing', host, 'tester-1' as PrincipalId),
        transitionPlanState(plan.id, 'executing', host, 'tester-2' as PrincipalId),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.conflictRejected).toBe(1);

      const after = await host.atoms.get(plan.id);
      expect(after?.plan_state).toBe('executing');
    });

    it('executing -> succeeded: exactly one writer wins', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-race-3', '2026-01-01T00:00:00.000Z', {
        plan_state: 'executing',
      });
      await host.atoms.put(plan);

      const outcomes = await Promise.allSettled([
        transitionPlanState(plan.id, 'succeeded', host, 'tester-1' as PrincipalId),
        transitionPlanState(plan.id, 'succeeded', host, 'tester-2' as PrincipalId),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.conflictRejected).toBe(1);

      const after = await host.atoms.get(plan.id);
      expect(after?.plan_state).toBe('succeeded');
    });

    it('executing -> failed: exactly one writer wins', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-race-4', '2026-01-01T00:00:00.000Z', {
        plan_state: 'executing',
      });
      await host.atoms.put(plan);

      const outcomes = await Promise.allSettled([
        transitionPlanState(plan.id, 'failed', host, 'tester-1' as PrincipalId),
        transitionPlanState(plan.id, 'failed', host, 'tester-2' as PrincipalId),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.conflictRejected).toBe(1);

      const after = await host.atoms.get(plan.id);
      expect(after?.plan_state).toBe('failed');
    });

    it('competing terminal transitions (succeeded vs failed): exactly one writer wins', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-race-5', '2026-01-01T00:00:00.000Z', {
        plan_state: 'executing',
      });
      await host.atoms.put(plan);

      const outcomes = await Promise.allSettled([
        transitionPlanState(plan.id, 'succeeded', host, 'tester-1' as PrincipalId),
        transitionPlanState(plan.id, 'failed', host, 'tester-2' as PrincipalId),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.conflictRejected).toBe(1);

      const after = await host.atoms.get(plan.id);
      // Whichever transition won is the persisted state; both are
      // valid terminal targets from 'executing'.
      expect(['succeeded', 'failed']).toContain(after?.plan_state);
    });

    it('loser re-reading after ConflictError observes the winner final state', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-race-6', '2026-01-01T00:00:00.000Z', {
        plan_state: 'proposed',
      });
      await host.atoms.put(plan);

      const outcomes = await Promise.allSettled([
        transitionPlanState(plan.id, 'approved', host, 'tester-1' as PrincipalId),
        transitionPlanState(plan.id, 'approved', host, 'tester-2' as PrincipalId),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.conflictRejected).toBe(1);

      // The loser's recovery path: re-read sees the winner's state
      // and skips its retry attempt.
      const loserView = await host.atoms.get(plan.id);
      expect(loserView?.plan_state).toBe('approved');
    });
  });

  describe('bindAnswer (src/runtime/questions/index.ts)', () => {
    it('two answerers on the same question: exactly one succeeds', async () => {
      const host = createMemoryHost();
      const q = await askQuestion(host, {
        content: 'will this work?',
        asker: 'user_1' as PrincipalId,
      });

      const outcomes = await Promise.allSettled([
        bindAnswer(host, {
          questionId: q.id,
          answerContent: 'answer A',
          answerer: 'user_1' as PrincipalId,
        }),
        bindAnswer(host, {
          questionId: q.id,
          answerContent: 'answer B',
          answerer: 'user_1' as PrincipalId,
        }),
      ]);

      // bindAnswer mints distinct answer-atom ids from the answer
      // content hash, so both put() calls succeed. The CAS race
      // happens on the question's question_state transition; the
      // loser sees ConflictError on the update. If both answer
      // contents hash to the same id, the put collides too (still
      // exactly one fulfilled outcome).
      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(1);
      expect(counts.fulfilled + counts.conflictRejected + counts.otherRejected).toBe(2);

      const after = await host.atoms.get(q.id);
      expect(after?.question_state).toBe('answered');
    });
  });

  describe('expirePastDueQuestions (src/runtime/questions/index.ts)', () => {
    it('two concurrent expiry sweeps: exactly one expire lands per question, no other errors', async () => {
      const host = createMemoryHost();
      const q = questionAtom('q-expire-race', {
        expires_at: '2026-01-01T00:00:00.000Z' as Time,
      });
      await host.atoms.put(q);

      // Advance the clock past the question's expires_at so both
      // sweeps observe the question as past-due.
      host.clock.setTime('2026-01-02T00:00:00.000Z');

      const outcomes = await Promise.allSettled([
        expirePastDueQuestions(host, 'sweep-1' as PrincipalId),
        expirePastDueQuestions(host, 'sweep-2' as PrincipalId),
      ]);

      // Both sweeps return successfully (the in-loop ConflictError
      // is swallowed as "another sweep beat us"); the count of
      // expired questions across the two sweeps sums to exactly 1.
      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(2);
      expect(counts.conflictRejected).toBe(0);
      expect(counts.otherRejected).toBe(0);

      const totalExpired = outcomes
        .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
        .reduce((s, r) => s + r.value, 0);
      expect(totalExpired).toBe(1);

      const after = await host.atoms.get(q.id);
      expect(after?.question_state).toBe('expired');
    });
  });

  describe('markPipelineReaped + markStageAtomReaped (src/runtime/plans/pipeline-reaper.ts)', () => {
    it('two reaper sweeps on the same pipeline: exactly one reap lands, no audit duplicate', async () => {
      const host = createMemoryHost();
      const pipeline = pipelineAtom('pipe-race-1');
      await host.atoms.put(pipeline);

      const outcomes = await Promise.allSettled([
        markPipelineReaped(host, pipeline.id, 'reaper-1' as PrincipalId, 'terminal-pipeline-ttl'),
        markPipelineReaped(host, pipeline.id, 'reaper-2' as PrincipalId, 'terminal-pipeline-ttl'),
      ]);

      // The reap is idempotent in OUTCOME: both callers return the
      // reaped atom (the loser re-reads after ConflictError). What
      // CAS prevents is a duplicate audit log row.
      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(2);
      expect(counts.conflictRejected).toBe(0);
      expect(counts.otherRejected).toBe(0);

      const after = await host.atoms.get(pipeline.id);
      const meta = after?.metadata as Record<string, unknown>;
      expect(typeof meta?.reaped_at).toBe('string');

      // Audit log should carry exactly ONE pipeline.reaped entry
      // for this atom id (no double-fire from the racing loser).
      const auditEntries = await host.auditor.query({}, 1000);
      const reapedAuditRows = auditEntries.filter(
        a => a.kind === 'pipeline.reaped'
          && a.refs.atom_ids?.includes(pipeline.id),
      );
      expect(reapedAuditRows.length).toBe(1);
    });

    it('two reaper sweeps on the same stage atom: exactly one audit row', async () => {
      const host = createMemoryHost();
      const stage = pipelineAtom('stage-race-1', { type: 'pipeline-stage-event' });
      await host.atoms.put(stage);

      const outcomes = await Promise.allSettled([
        markStageAtomReaped(host, stage.id, 'reaper-1' as PrincipalId, 'cascade'),
        markStageAtomReaped(host, stage.id, 'reaper-2' as PrincipalId, 'cascade'),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(2);

      const auditEntries = await host.auditor.query({}, 1000);
      const reapedAuditRows = auditEntries.filter(
        a => a.kind === 'pipeline.stage_atom_reaped'
          && a.refs.atom_ids?.includes(stage.id),
      );
      expect(reapedAuditRows.length).toBe(1);
    });
  });

  describe('runWithCas helper (src/runtime/util/cas-retry.ts)', () => {
    it('successful first-try returns retries=0 and the updated atom', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-1', '2026-01-01T00:00:00.000Z', {
        plan_state: 'proposed',
      });
      await host.atoms.put(plan);

      const result = await runWithCas(host, plan.id, () => ({
        plan_state: 'approved',
      }));

      expect(result).not.toBeNull();
      expect(result?.retries).toBe(0);
      expect(result?.atom.plan_state).toBe('approved');
      expect(result?.atom.revision).toBe(1);
    });

    it('mutator returning null short-circuits without writing', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-2', '2026-01-01T00:00:00.000Z', {
        plan_state: 'approved',
      });
      await host.atoms.put(plan);

      const result = await runWithCas(host, plan.id, () => null);

      expect(result).toBeNull();
      const after = await host.atoms.get(plan.id);
      // Revision unchanged: no write happened.
      expect(after?.revision).toBeUndefined();
    });

    it('missing atom returns null without throwing', async () => {
      const host = createMemoryHost();
      const result = await runWithCas(host, 'does-not-exist' as AtomId, () => ({
        plan_state: 'approved',
      }));
      expect(result).toBeNull();
    });

    it('two concurrent runWithCas calls: both eventually succeed via retry', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-3', '2026-01-01T00:00:00.000Z', {
        plan_state: 'proposed',
        metadata: { count: 0 },
      });
      await host.atoms.put(plan);

      // Two concurrent metadata-merges; each increments a counter.
      // The helper retries once on ConflictError so both writers
      // land their increment. After both complete, count should be
      // 2 (no lost update).
      const outcomes = await Promise.allSettled([
        runWithCas(host, plan.id, current => {
          const c = (current.metadata as { count?: number }).count ?? 0;
          return { metadata: { count: c + 1 } };
        }),
        runWithCas(host, plan.id, current => {
          const c = (current.metadata as { count?: number }).count ?? 0;
          return { metadata: { count: c + 1 } };
        }),
      ]);

      const counts = countOutcomes(outcomes);
      expect(counts.fulfilled).toBe(2);
      expect(counts.conflictRejected).toBe(0);

      const after = await host.atoms.get(plan.id);
      expect((after?.metadata as { count?: number }).count).toBe(2);
      expect(after?.revision).toBe(2);
    });

    it('rejects NaN maxRetries with RangeError (terminates the loop guard)', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-nan', '2026-01-01T00:00:00.000Z');
      await host.atoms.put(plan);

      // NaN passes through `?? DEFAULT_MAX_RETRIES` (defined value)
      // but `retries >= NaN` is always false; without the validator
      // this loops forever on ConflictError. The guard surfaces a
      // RangeError at the call boundary so callers cannot accidentally
      // disable the escape check.
      await expect(
        runWithCas(host, plan.id, () => ({ confidence: 0.5 }), {
          maxRetries: Number.NaN,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it('rejects negative maxRetries with RangeError', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-neg', '2026-01-01T00:00:00.000Z');
      await host.atoms.put(plan);

      await expect(
        runWithCas(host, plan.id, () => ({ confidence: 0.5 }), {
          maxRetries: -1,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it('rejects non-integer maxRetries with RangeError', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-float', '2026-01-01T00:00:00.000Z');
      await host.atoms.put(plan);

      await expect(
        runWithCas(host, plan.id, () => ({ confidence: 0.5 }), {
          maxRetries: 1.5,
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it('exceeds maxRetries: ConflictError surfaces to caller', async () => {
      const host = createMemoryHost();
      const plan = samplePlanAtom('plan-runwithcas-4', '2026-01-01T00:00:00.000Z', {
        plan_state: 'proposed',
      });
      await host.atoms.put(plan);

      // Pre-bump revision once. Then start a runWithCas whose
      // mutator inserts a manual update BEFORE the helper's CAS
      // submit; that manual update bumps revision out from under the
      // helper. With maxRetries=0 the helper has no headroom to
      // retry, so the ConflictError propagates.
      await host.atoms.update(plan.id, { confidence: 0.6 });

      // Mutator that triggers a peer write each time it runs. With
      // maxRetries=0 the helper attempts once, sees the peer write,
      // and throws.
      let invocations = 0;
      await expect(
        runWithCas(
          host,
          plan.id,
          async () => {
            invocations += 1;
            await host.atoms.update(plan.id, { confidence: 0.7 });
            return { confidence: 0.8 };
          },
          { maxRetries: 0 },
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(invocations).toBe(1);
    });
  });
});
