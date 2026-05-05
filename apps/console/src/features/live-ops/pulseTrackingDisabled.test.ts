import { describe, expect, it } from 'vitest';
import { isOperatorTrackingDisabled } from './pulseTrackingDisabled';
import type {
  LiveOpsHeartbeat,
  LiveOpsActiveSession,
} from '@/services/live-ops.service';

/*
 * The predicate is the load-bearing piece of the tracking-disabled
 * banner: the JSX is a thin render around the boolean. Testing the
 * predicate in isolation keeps the unit suite environment-agnostic
 * (vitest config is `environment: 'node'`, so a render-based test
 * would need jsdom + a host setup that no other unit test in this
 * tree pays for) while still pinning the contract that drives the
 * three visibility cases the operator cares about.
 */

const ZERO_HEARTBEAT: LiveOpsHeartbeat = {
  last_60s: 0,
  last_5m: 0,
  last_1h: 0,
  delta: 0,
};

const SAMPLE_SESSION: LiveOpsActiveSession = {
  session_id: 'sess-1',
  principal_id: 'sample-actor',
  started_at: '2026-05-04T00:00:00Z',
  last_turn_at: null,
};

describe('isOperatorTrackingDisabled', () => {
  it('returns true when heartbeat is fully zero and active_sessions is empty', () => {
    /*
     * Canonical "operator hooks are no-op'ing" signature. All four
     * signals point at "nothing is being tracked at all", which is
     * the strongest evidence that LAG_OPERATOR_ID is unset and the
     * SessionStart + PostToolUse hooks are silently exiting 0.
     */
    expect(isOperatorTrackingDisabled(ZERO_HEARTBEAT, [])).toBe(true);
  });

  it('returns false when heartbeat last_5m is non-zero (real activity tracked)', () => {
    /*
     * Even one atom in any window means the substrate is observing
     * SOMETHING. Banner would be a false alarm; the operator's
     * autonomous loop is firing and the silence on terminal sessions
     * is a separate (smaller) concern.
     */
    expect(
      isOperatorTrackingDisabled({ ...ZERO_HEARTBEAT, last_5m: 1 }, []),
    ).toBe(false);
  });

  it('returns false when active_sessions has any entry, even with zero heartbeat', () => {
    /*
     * Active sessions are mid-firing agent loops. The dashboard is
     * functional; the operator has just not enabled terminal-session
     * tracking specifically. We err toward not-banner-ing to avoid
     * alarming an operator whose autonomous loop is healthy.
     */
    expect(isOperatorTrackingDisabled(ZERO_HEARTBEAT, [SAMPLE_SESSION])).toBe(
      false,
    );
  });
});
