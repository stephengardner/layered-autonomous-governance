/**
 * Deliberation escalation emitter.
 *
 * `emitEscalation` builds an Escalation atom-pattern when the
 * coordinator cannot reach a Decision. These tests pin down:
 *   - Required fields are validated into the shape.
 *   - `requiresHumanBy` defaults to 24h from now when
 *     requiresHumanByMs is omitted, honours the override otherwise.
 *   - id embeds the question id + timestamp for uniqueness.
 *   - Emitted atom passes validateEscalation().
 */
import { describe, expect, it } from 'vitest';

import { emitEscalation } from '../../../src/substrate/deliberation/escalation.js';
import { validateEscalation } from '../../../src/substrate/deliberation/patterns.js';

describe('emitEscalation', () => {
  it('produces a valid Escalation atom', () => {
    const e = emitEscalation({
      questionId: 'q1',
      reason: 'arbitration-indeterminate',
      suggestedNext: 'operator decides',
      authorPrincipal: 'cto',
    });
    expect(() => validateEscalation(e)).not.toThrow();
  });

  it('populates type=escalation and from=questionId', () => {
    const e = emitEscalation({
      questionId: 'q-abc',
      reason: 'timeout',
      suggestedNext: 'next',
      authorPrincipal: 'cto',
    });
    expect(e.type).toBe('escalation');
    expect(e.from).toBe('q-abc');
  });

  it('propagates reason, suggestedNext, authorPrincipal verbatim', () => {
    const e = emitEscalation({
      questionId: 'q1',
      reason: 'round-budget-exhausted',
      suggestedNext: 'raise budget or narrow scope',
      authorPrincipal: 'ceo',
    });
    expect(e.reason).toBe('round-budget-exhausted');
    expect(e.suggestedNext).toBe('raise budget or narrow scope');
    expect(e.authorPrincipal).toBe('ceo');
  });

  it('defaults requiresHumanBy to 24h from now', () => {
    const before = Date.now();
    const e = emitEscalation({
      questionId: 'q1',
      reason: 'x',
      suggestedNext: 'y',
      authorPrincipal: 'cto',
    });
    const after = Date.now();
    const humanBy = Date.parse(e.requiresHumanBy);
    const TWENTY_FOUR_H = 1000 * 60 * 60 * 24;
    expect(humanBy).toBeGreaterThanOrEqual(before + TWENTY_FOUR_H - 1000);
    expect(humanBy).toBeLessThanOrEqual(after + TWENTY_FOUR_H + 1000);
  });

  it('honours requiresHumanByMs override', () => {
    const e = emitEscalation({
      questionId: 'q1',
      reason: 'x',
      suggestedNext: 'y',
      authorPrincipal: 'cto',
      requiresHumanByMs: 1000 * 60 * 60, // 1h
    });
    const humanBy = Date.parse(e.requiresHumanBy);
    const delta = humanBy - Date.now();
    // Expect roughly 1 hour from now, give 5s margin.
    expect(delta).toBeGreaterThan(1000 * 60 * 59);
    expect(delta).toBeLessThan(1000 * 60 * 61);
  });

  it('id embeds questionId so it remains traceable', () => {
    const e = emitEscalation({
      questionId: 'q-specific',
      reason: 'x',
      suggestedNext: 'y',
      authorPrincipal: 'cto',
    });
    expect(e.id).toContain('q-specific');
  });

  it('distinct calls produce distinct ids', () => {
    const a = emitEscalation({
      questionId: 'q1',
      reason: 'x',
      suggestedNext: 'y',
      authorPrincipal: 'cto',
    });
    const b = emitEscalation({
      questionId: 'q1',
      reason: 'x',
      suggestedNext: 'y',
      authorPrincipal: 'cto',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('created_at is ISO-8601 parseable', () => {
    const e = emitEscalation({
      questionId: 'q1',
      reason: 'x',
      suggestedNext: 'y',
      authorPrincipal: 'cto',
    });
    expect(() => Date.parse(e.created_at)).not.toThrow();
    expect(Number.isNaN(Date.parse(e.created_at))).toBe(false);
  });
});
