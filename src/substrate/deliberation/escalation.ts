/**
 * Deliberation escalation emitter.
 *
 * When arbitration is indeterminate or the deliberation times out,
 * the coordinator emits an Escalation atom via `emitEscalation`. The
 * Escalation is the soft-tier human gate: downstream agents block on
 * that Question until a human writes a Resolution atom. This module
 * builds the Escalation shape only; wiring through the existing
 * kill-switch seam (`src/substrate/kill-switch/`) and Notifier is the
 * coordinator's job.
 *
 * Default `requiresHumanBy` horizon is 24h; callers with shorter
 * operator-response SLAs override via `requiresHumanByMs`.
 */

import type { Escalation } from './patterns.js';

export interface EmitEscalationArgs {
  readonly questionId: string;
  readonly reason: string;
  readonly suggestedNext: string;
  readonly authorPrincipal: string;
  /** Horizon in ms from now before human response is required. Default 24h. */
  readonly requiresHumanByMs?: number;
}

const DEFAULT_HUMAN_HORIZON_MS = 1000 * 60 * 60 * 24;

let escalationSeq = 0;

export function emitEscalation(args: EmitEscalationArgs): Escalation {
  const now = new Date();
  const horizon = args.requiresHumanByMs ?? DEFAULT_HUMAN_HORIZON_MS;
  const by = new Date(now.getTime() + horizon);
  escalationSeq += 1;
  return {
    id: `esc-${args.questionId}-${now.getTime()}-${escalationSeq}`,
    type: 'escalation',
    from: args.questionId,
    reason: args.reason,
    requiresHumanBy: by.toISOString(),
    suggestedNext: args.suggestedNext,
    authorPrincipal: args.authorPrincipal,
    created_at: now.toISOString(),
  };
}
