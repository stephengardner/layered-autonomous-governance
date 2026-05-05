/**
 * Pure predicate: should the "operator session tracking is off" hint
 * render above the Pulse heartbeat tile?
 *
 * The SessionStart + PostToolUse hooks at `.claude/hooks/operator-
 * session-{start,heartbeat}.mjs` only mint atoms when LAG_OPERATOR_ID
 * is set in the operator's shell. Unconfigured deployments produce a
 * permanently flat heartbeat with no signal as to why. This predicate
 * detects the symptom (zero heartbeat AND zero active sessions) so the
 * UI can surface the cause.
 *
 * Returns false when ANY of these are true:
 *   - The substrate is firing atoms in any of the three windows
 *     (last_60s, last_5m, last_1h). Even one atom means tracking
 *     somewhere is working, so the banner would be a false alarm.
 *   - At least one active agent session exists. LAG actor loops mint
 *     agent-session atoms via the substrate; if any are visible, the
 *     dashboard is functioning and the operator just hasn't enabled
 *     terminal-session tracking specifically. We err toward
 *     not-banner-ing in that case to avoid alarming an operator
 *     whose autonomous loop is healthy.
 *
 * Returns true ONLY when all four signals point at "nothing is being
 * tracked at all": the strongest evidence that the operator's hooks
 * are no-op'ing because LAG_OPERATOR_ID is unset.
 */

import type {
  LiveOpsHeartbeat,
  LiveOpsActiveSession,
} from '@/services/live-ops.service';

export function isOperatorTrackingDisabled(
  heartbeat: LiveOpsHeartbeat,
  active_sessions: ReadonlyArray<LiveOpsActiveSession>,
): boolean {
  const heartbeatFlat =
    heartbeat.last_60s === 0 &&
    heartbeat.last_5m === 0 &&
    heartbeat.last_1h === 0;
  const noActiveSessions = active_sessions.length === 0;
  return heartbeatFlat && noActiveSessions;
}
