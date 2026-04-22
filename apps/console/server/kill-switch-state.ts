/*
 * Pure helpers for the kill-switch state handler. Extracted from
 * server/index.ts so the unit tests (server/kill-switch.test.ts)
 * can import them without triggering the server.listen + file-
 * watcher side effects the entrypoint module carries.
 *
 * Runtime parity: server/index.ts imports from this module and
 * uses the same exported helper for its load path, so the test
 * and the real handler agree by construction.
 */

/*
 * Clamp autonomyDial to the documented [0..1] range. Per the
 * KillSwitchState contract on the client side, autonomyDial is
 * a scalar in [0 (fully gated), 1 (fully autonomous)]. A malformed
 * state file (NaN, Infinity, negative, >1) must not be allowed to
 * escalate runtime posture past what the tier allows.
 *
 * Fallback on non-number / non-finite is 1 so the behaviour
 * matches an absent state file: "fully autonomous, no tier active".
 * In-range values pass through. Out-of-range finite values clamp
 * to the nearest bound.
 */
export function parseAutonomyDial(value: unknown): number {
  if (typeof value !== 'number') return 1;
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
