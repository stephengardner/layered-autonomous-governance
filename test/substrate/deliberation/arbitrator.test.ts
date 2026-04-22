/**
 * Deliberation arbitrator.
 *
 * `shouldConclude` signals when the coordinator's round loop can stop
 * emitting new rounds; `decide` invokes the existing source-rank
 * primitive to pick a winner from the posted positions and counters.
 *
 * These tests pin down:
 *   - shouldConclude returns true when only one unrebutted position
 *     remains, false otherwise.
 *   - decide returns a valid Decision when a clear winner exists
 *     (higher-hierarchy principal wins ties).
 *   - decide returns null when indeterminate (no positions), signaling
 *     the caller to escalate.
 *   - Decision carries arbitrationTrace referencing the winning position.
 */
import { describe, expect, it } from 'vitest';

import {
  decide,
  shouldConclude,
} from '../../../src/substrate/deliberation/arbitrator.js';
import type {
  Counter,
  Position,
} from '../../../src/substrate/deliberation/patterns.js';

function pos(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p-default',
    type: 'position',
    inResponseTo: 'q1',
    answer: 'answer',
    rationale: 'rationale',
    derivedFrom: [],
    authorPrincipal: 'cto',
    created_at: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

function ctr(overrides: Partial<Counter> = {}): Counter {
  return {
    id: 'c-default',
    type: 'counter',
    inResponseTo: 'p1',
    objection: 'objection',
    derivedFrom: [],
    authorPrincipal: 'code-author',
    created_at: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldConclude
// ---------------------------------------------------------------------------

describe('shouldConclude', () => {
  it('returns false with zero positions', () => {
    expect(shouldConclude([], [])).toBe(false);
  });

  it('returns true with a single unrebutted position', () => {
    const p1 = pos({ id: 'p1' });
    expect(shouldConclude([p1], [])).toBe(true);
  });

  it('returns false with two unrebutted positions (still deliberating)', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto' });
    const p2 = pos({ id: 'p2', authorPrincipal: 'code-author' });
    expect(shouldConclude([p1, p2], [])).toBe(false);
  });

  it('returns true when only one position is left unrebutted after counters', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto' });
    const p2 = pos({ id: 'p2', authorPrincipal: 'code-author' });
    const c1 = ctr({ id: 'c1', inResponseTo: 'p2', authorPrincipal: 'cto' });
    expect(shouldConclude([p1, p2], [c1])).toBe(true);
  });

  it('returns false when every position is rebutted (indeterminate)', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto' });
    const p2 = pos({ id: 'p2', authorPrincipal: 'code-author' });
    const c1 = ctr({ id: 'c1', inResponseTo: 'p1', authorPrincipal: 'code-author' });
    const c2 = ctr({ id: 'c2', inResponseTo: 'p2', authorPrincipal: 'cto' });
    expect(shouldConclude([p1, p2], [c1, c2])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

describe('decide', () => {
  it('returns null when no positions were posted', () => {
    expect(decide('q1', [], [], 'cto')).toBeNull();
  });

  it('returns a Decision with a single-position winner', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto', answer: 'use arg-array' });
    const d = decide('q1', [p1], [], 'cto');
    expect(d).not.toBeNull();
    expect(d!.type).toBe('decision');
    expect(d!.resolving).toBe('q1');
    expect(d!.answer).toBe('use arg-array');
    expect(d!.arbitrationTrace).toContain('p1');
    expect(d!.authorPrincipal).toBe('cto');
  });

  it('breaks ties via principal depth when provided', () => {
    // Both positions are equal layer/provenance/confidence; lower depth wins.
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto', answer: 'A' });
    const p2 = pos({ id: 'p2', authorPrincipal: 'code-author', answer: 'B' });
    const d = decide('q1', [p1, p2], [], 'cto', {
      principalDepths: { cto: 1, 'code-author': 2 },
    });
    expect(d).not.toBeNull();
    expect(d!.answer).toBe('A');
    expect(d!.arbitrationTrace).toContain('p1');
  });

  it('rebutted positions lose to unrebutted when all else equal', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto', answer: 'A' });
    const p2 = pos({ id: 'p2', authorPrincipal: 'code-author', answer: 'B' });
    const c1 = ctr({ id: 'c1', inResponseTo: 'p1', authorPrincipal: 'code-author' });
    const d = decide('q1', [p1, p2], [c1], 'cto', {
      principalDepths: { cto: 1, 'code-author': 1 },
    });
    expect(d).not.toBeNull();
    expect(d!.answer).toBe('B');
    expect(d!.arbitrationTrace).toContain('p2');
  });

  it('Decision id is deterministic for a given questionId', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto', answer: 'A' });
    const d1 = decide('q1', [p1], [], 'cto');
    const d2 = decide('q1', [p1], [], 'cto');
    expect(d1!.id).toBe(d2!.id);
  });

  it('arbitrationTrace enumerates positions and counters by id', () => {
    const p1 = pos({ id: 'p1', authorPrincipal: 'cto' });
    const p2 = pos({ id: 'p2', authorPrincipal: 'code-author' });
    const c1 = ctr({ id: 'c1', inResponseTo: 'p1' });
    const d = decide('q1', [p1, p2], [c1], 'cto');
    expect(d!.arbitrationTrace).toContain('p1');
    expect(d!.arbitrationTrace).toContain('p2');
    expect(d!.arbitrationTrace).toContain('c1');
  });
});
