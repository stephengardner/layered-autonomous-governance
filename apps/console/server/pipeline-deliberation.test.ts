import { describe, it, expect } from 'vitest';
import {
  listPipelineDeliberation,
  MAX_DELIBERATION_ENTRIES,
} from './pipeline-deliberation';
import type { PipelineDeliberationSourceAtom } from './pipeline-deliberation-types';

/*
 * Unit tests for the cross-stage deliberation projection.
 *
 * Pure-helper tests: feed atoms, assert on the wire shape. No I/O, no
 * time, no globals. Mirrors the test pattern in pipelines.test.ts and
 * pipeline-lifecycle.test.ts.
 */

const NOW = Date.parse('2026-05-21T12:00:00.000Z');
const PIPELINE_ID = 'pipeline-corr-test';

function atom(
  partial: Partial<PipelineDeliberationSourceAtom> & {
    id: string;
    type: string;
    created_at: string;
  },
): PipelineDeliberationSourceAtom {
  return {
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    taint: 'clean',
    ...partial,
  };
}

function reprompt(overrides: {
  id: string;
  created_at: string;
  pipeline_id?: string;
  from_stage?: string;
  to_stage?: string;
  attempt?: number;
  thread_parent?: string | null;
  severity?: 'critical' | 'major' | 'minor';
  category?: string;
  message?: string;
  cited_atom_ids?: ReadonlyArray<string>;
  cited_paths?: ReadonlyArray<string>;
  reprompt_target?: string;
  verified_cited_atom_ids_origin?: string;
  correlation_id?: string;
  taint?: string;
  superseded_by?: ReadonlyArray<string>;
}): PipelineDeliberationSourceAtom {
  return atom({
    id: overrides.id,
    type: 'pipeline-cross-stage-reprompt',
    created_at: overrides.created_at,
    ...(overrides.taint ? { taint: overrides.taint } : {}),
    ...(overrides.superseded_by ? { superseded_by: overrides.superseded_by } : {}),
    metadata: {
      pipeline_id: overrides.pipeline_id ?? PIPELINE_ID,
      correlation_id: overrides.correlation_id ?? 'corr-test',
      from_stage: overrides.from_stage ?? 'dispatch-stage',
      to_stage: overrides.to_stage ?? 'plan-stage',
      attempt: overrides.attempt ?? 1,
      thread_parent:
        overrides.thread_parent === undefined ? null : overrides.thread_parent,
      verified_cited_atom_ids_origin:
        overrides.verified_cited_atom_ids_origin ?? 'pipeline-seed',
      finding: {
        severity: overrides.severity ?? 'critical',
        category: overrides.category ?? 'drafter-refused',
        message:
          overrides.message ?? 'Drafter refused to open PR; plan needs revision',
        cited_atom_ids: overrides.cited_atom_ids ?? [],
        cited_paths: overrides.cited_paths ?? [],
        reprompt_target: overrides.reprompt_target ?? 'plan-stage',
      },
    },
  });
}

describe('listPipelineDeliberation', () => {
  describe('empty / dormant cases', () => {
    it('returns empty entries when atom set is empty', () => {
      const result = listPipelineDeliberation([], PIPELINE_ID, NOW);
      expect(result.pipeline_id).toBe(PIPELINE_ID);
      expect(result.entries).toEqual([]);
      expect(result.computed_at).toBe('2026-05-21T12:00:00.000Z');
    });

    it('returns empty entries when no atoms match the requested pipeline', () => {
      const atoms = [
        reprompt({
          id: 'pipeline-cross-stage-reprompt-other-1',
          created_at: '2026-05-21T12:00:00.000Z',
          pipeline_id: 'pipeline-other',
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toEqual([]);
    });

    it('ignores atoms of other types', () => {
      const atoms: PipelineDeliberationSourceAtom[] = [
        atom({
          id: 'pipeline-audit-finding-x',
          type: 'pipeline-audit-finding',
          created_at: '2026-05-21T12:00:00.000Z',
          metadata: { pipeline_id: PIPELINE_ID },
        }),
        atom({
          id: 'pipeline-stage-event-x',
          type: 'pipeline-stage-event',
          created_at: '2026-05-21T12:00:00.000Z',
          metadata: { pipeline_id: PIPELINE_ID },
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toEqual([]);
    });
  });

  describe('happy path', () => {
    it('projects a single cross-stage re-prompt atom into the wire shape', () => {
      const atoms = [
        reprompt({
          id: 'pipeline-cross-stage-reprompt-corr-test-dispatch-stage-plan-stage-attempt-1-corr-test',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1,
          thread_parent: null,
          from_stage: 'dispatch-stage',
          to_stage: 'plan-stage',
          severity: 'critical',
          category: 'drafter-refused',
          message: 'Drafter refused to open PR; plan needs revision',
          cited_atom_ids: ['plan-abc'],
          cited_paths: ['design/foo.md'],
          reprompt_target: 'plan-stage',
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0]!;
      expect(entry.atom_id).toBe(
        'pipeline-cross-stage-reprompt-corr-test-dispatch-stage-plan-stage-attempt-1-corr-test',
      );
      expect(entry.pipeline_id).toBe(PIPELINE_ID);
      expect(entry.from_stage).toBe('dispatch-stage');
      expect(entry.to_stage).toBe('plan-stage');
      expect(entry.attempt).toBe(1);
      expect(entry.thread_parent).toBeNull();
      expect(entry.finding.severity).toBe('critical');
      expect(entry.finding.category).toBe('drafter-refused');
      expect(entry.finding.cited_atom_ids).toEqual(['plan-abc']);
      expect(entry.finding.cited_paths).toEqual(['design/foo.md']);
      expect(entry.finding.reprompt_target).toBe('plan-stage');
      expect(entry.verified_cited_atom_ids_origin).toBe('pipeline-seed');
    });

    it('sorts entries by attempt ascending (chain order)', () => {
      const atoms = [
        reprompt({
          id: 'cross-3',
          created_at: '2026-05-21T11:55:00.000Z',
          attempt: 3,
          thread_parent: 'cross-2',
        }),
        reprompt({
          id: 'cross-1',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1,
          thread_parent: null,
        }),
        reprompt({
          id: 'cross-2',
          created_at: '2026-05-21T11:52:00.000Z',
          attempt: 2,
          thread_parent: 'cross-1',
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries.map((e) => e.atom_id)).toEqual([
        'cross-1',
        'cross-2',
        'cross-3',
      ]);
    });

    it('breaks attempt ties by created_at ascending', () => {
      const atoms = [
        reprompt({
          id: 'cross-b',
          created_at: '2026-05-21T11:51:00.000Z',
          attempt: 1,
        }),
        reprompt({
          id: 'cross-a',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1,
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries.map((e) => e.atom_id)).toEqual(['cross-a', 'cross-b']);
    });

    it('breaks attempt + timestamp ties by atom_id ascending', () => {
      const atoms = [
        reprompt({
          id: 'cross-b',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1,
        }),
        reprompt({
          id: 'cross-a',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1,
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries.map((e) => e.atom_id)).toEqual(['cross-a', 'cross-b']);
    });
  });

  describe('hygiene filters', () => {
    it('drops tainted atoms', () => {
      const atoms = [
        reprompt({
          id: 'tainted',
          created_at: '2026-05-21T11:50:00.000Z',
          taint: 'tainted',
        }),
        reprompt({
          id: 'clean',
          created_at: '2026-05-21T11:51:00.000Z',
          attempt: 2,
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries.map((e) => e.atom_id)).toEqual(['clean']);
    });

    it('drops superseded atoms', () => {
      const atoms = [
        reprompt({
          id: 'superseded',
          created_at: '2026-05-21T11:50:00.000Z',
          superseded_by: ['newer'],
        }),
        reprompt({
          id: 'clean',
          created_at: '2026-05-21T11:51:00.000Z',
          attempt: 2,
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries.map((e) => e.atom_id)).toEqual(['clean']);
    });
  });

  describe('malformed atom handling', () => {
    it('drops atoms missing required metadata.pipeline_id', () => {
      const atoms: PipelineDeliberationSourceAtom[] = [
        atom({
          id: 'malformed',
          type: 'pipeline-cross-stage-reprompt',
          created_at: '2026-05-21T11:50:00.000Z',
          metadata: {
            from_stage: 'a',
            to_stage: 'b',
            attempt: 1,
            thread_parent: null,
            verified_cited_atom_ids_origin: 'x',
            finding: {
              severity: 'critical',
              category: 'c',
              message: 'm',
              cited_atom_ids: [],
              cited_paths: [],
              reprompt_target: 'b',
            },
          },
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toEqual([]);
    });

    it('drops atoms with non-integer attempt', () => {
      const atoms = [
        reprompt({
          id: 'fractional',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1.5 as unknown as number,
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toEqual([]);
    });

    it('drops atoms with severity outside the canonical bucket', () => {
      const atoms: PipelineDeliberationSourceAtom[] = [
        atom({
          id: 'bad-severity',
          type: 'pipeline-cross-stage-reprompt',
          created_at: '2026-05-21T11:50:00.000Z',
          metadata: {
            pipeline_id: PIPELINE_ID,
            correlation_id: 'corr',
            from_stage: 'a',
            to_stage: 'b',
            attempt: 1,
            thread_parent: null,
            verified_cited_atom_ids_origin: 'x',
            finding: {
              severity: 'fatal',
              category: 'c',
              message: 'm',
              cited_atom_ids: [],
              cited_paths: [],
              reprompt_target: 'b',
            },
          },
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toEqual([]);
    });

    it('drops atoms with malformed thread_parent (non-string, non-null)', () => {
      const atoms: PipelineDeliberationSourceAtom[] = [
        atom({
          id: 'bad-thread-parent',
          type: 'pipeline-cross-stage-reprompt',
          created_at: '2026-05-21T11:50:00.000Z',
          metadata: {
            pipeline_id: PIPELINE_ID,
            correlation_id: 'corr',
            from_stage: 'a',
            to_stage: 'b',
            attempt: 1,
            thread_parent: 12345,
            verified_cited_atom_ids_origin: 'x',
            finding: {
              severity: 'critical',
              category: 'c',
              message: 'm',
              cited_atom_ids: [],
              cited_paths: [],
              reprompt_target: 'b',
            },
          },
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toEqual([]);
    });

    it('treats missing finding.cited_atom_ids as empty array (not a drop)', () => {
      const atoms: PipelineDeliberationSourceAtom[] = [
        atom({
          id: 'no-citations',
          type: 'pipeline-cross-stage-reprompt',
          created_at: '2026-05-21T11:50:00.000Z',
          metadata: {
            pipeline_id: PIPELINE_ID,
            correlation_id: 'corr',
            from_stage: 'a',
            to_stage: 'b',
            attempt: 1,
            thread_parent: null,
            verified_cited_atom_ids_origin: 'x',
            finding: {
              severity: 'minor',
              category: 'c',
              message: 'm',
              reprompt_target: 'b',
              // cited_atom_ids and cited_paths absent
            },
          },
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.finding.cited_atom_ids).toEqual([]);
      expect(result.entries[0]!.finding.cited_paths).toEqual([]);
    });
  });

  describe('bounds', () => {
    it('caps entries at MAX_DELIBERATION_ENTRIES', () => {
      const atoms: PipelineDeliberationSourceAtom[] = [];
      for (let i = 0; i < MAX_DELIBERATION_ENTRIES + 5; i++) {
        atoms.push(
          reprompt({
            id: `cross-${i.toString().padStart(3, '0')}`,
            created_at: `2026-05-21T11:${(50 + (i % 10)).toString().padStart(2, '0')}:00.000Z`,
            attempt: i + 1,
            thread_parent: i === 0 ? null : `cross-${(i - 1).toString().padStart(3, '0')}`,
          }),
        );
      }
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries).toHaveLength(MAX_DELIBERATION_ENTRIES);
      // Entries are sorted by attempt ASC; the first MAX_DELIBERATION_ENTRIES survive.
      expect(result.entries[0]!.attempt).toBe(1);
      expect(result.entries[result.entries.length - 1]!.attempt).toBe(
        MAX_DELIBERATION_ENTRIES,
      );
    });
  });

  describe('thread chain', () => {
    it('preserves thread_parent pointer through the chain', () => {
      const atoms = [
        reprompt({
          id: 'head',
          created_at: '2026-05-21T11:50:00.000Z',
          attempt: 1,
          thread_parent: null,
        }),
        reprompt({
          id: 'mid',
          created_at: '2026-05-21T11:51:00.000Z',
          attempt: 2,
          thread_parent: 'head',
        }),
        reprompt({
          id: 'tail',
          created_at: '2026-05-21T11:52:00.000Z',
          attempt: 3,
          thread_parent: 'mid',
        }),
      ];
      const result = listPipelineDeliberation(atoms, PIPELINE_ID, NOW);
      expect(result.entries.map((e) => e.thread_parent)).toEqual([
        null,
        'head',
        'mid',
      ]);
    });
  });
});
