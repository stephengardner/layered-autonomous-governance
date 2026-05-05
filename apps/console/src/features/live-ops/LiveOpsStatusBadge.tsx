import { computeLiveOpsStatus } from './freshness';

/*
 * Styles are inlined via a single <style> element rather than a
 * sibling .module.css because the badge is a single-file addition
 * and a co-located CSS module would expand the change scope without
 * meaningful payoff. The selectors key off data attributes the
 * component owns, so collisions are scoped to the testid namespace.
 * No new runtime dependency (no Framer Motion); the pulse is a CSS
 * keyframe with a `prefers-reduced-motion` fallback to a static dot.
 */
const STYLES = `
@keyframes liveOpsStatusPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.45); opacity: 0.4; }
}
[data-testid="live-ops-status-badge"] {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0.65rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  background: var(--surface-2, rgba(255, 255, 255, 0.04));
  color: var(--text-2, rgba(255, 255, 255, 0.72));
  white-space: nowrap;
  user-select: none;
}
[data-testid="live-ops-status-badge"] [data-role="dot"] {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
[data-testid="live-ops-status-badge"][data-state="running"] [data-role="dot"] {
  background: var(--success, #22c55e);
  animation: liveOpsStatusPulse 1.6s ease-in-out infinite;
}
[data-testid="live-ops-status-badge"][data-state="idle"] [data-role="dot"] {
  background: var(--text-3, rgba(255, 255, 255, 0.32));
}
@media (prefers-reduced-motion: reduce) {
  [data-testid="live-ops-status-badge"][data-state="running"] [data-role="dot"] {
    animation: none;
  }
}
`;

export interface LiveOpsStatusBadgeProps {
  mostRecentAgentTurnAt: string | null;
  /** Injected for testability; defaults to wall-clock now per render. */
  now?: number;
}

/**
 * Display-only freshness badge: Running (green pulsing dot) when the
 * most recent agent-turn is within AGENT_TURN_FRESHNESS_THRESHOLD_MS,
 * Idle (muted dot, static) otherwise. Re-renders through the parent's
 * 2s snapshot refetch — no internal timer.
 */
export function LiveOpsStatusBadge({
  mostRecentAgentTurnAt,
  now = Date.now(),
}: LiveOpsStatusBadgeProps) {
  const state = computeLiveOpsStatus(mostRecentAgentTurnAt, now);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <span data-testid="live-ops-status-badge" data-state={state}>
        <span data-role="dot" aria-hidden="true" />
        {state === 'running' ? 'Running' : 'Idle'}
      </span>
    </>
  );
}
