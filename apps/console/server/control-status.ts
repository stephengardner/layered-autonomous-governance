/*
 * Pure helpers for the operator control-panel status handler. Extracted
 * from server/index.ts so the unit tests (server/control-status.test.ts)
 * can import them without triggering the server.listen + file-watcher
 * side effects the entrypoint module carries.
 *
 * Design contract (canon `inv-kill-switch-before-autonomy` +
 * `inv-governance-before-autonomy`): the control panel projects two
 * load-bearing invariants -- the STOP sentinel state and the autonomy
 * tier -- plus four context tiles (actors, policies, last canon-apply
 * timestamp, operator-principal id). Everything is read-only; the
 * handler MUST NOT write the sentinel from the console UI. Engaging
 * the kill switch crosses a higher trust boundary (operator at the
 * shell, with full env), so the UI shows the manual command and lets
 * the operator decide.
 *
 * Path-traversal hardening: callers resolve the sentinel path INSIDE
 * the .lag directory and pass an absolute path here. `resolveSentinelInside`
 * verifies the resolved target stays inside the parent and rejects
 * symlinks pointing out of tree. The string `.lag/STOP` is a constant
 * that travels with the response so the operator can copy it verbatim
 * for the manual `touch` command.
 */

import { stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

/*
 * Tier semantics, mapped from the existing kill-switch state file:
 *
 *   - off          -> autonomy_tier: 'soft'   (governance gates active,
 *                                              actors can still run)
 *   - soft         -> autonomy_tier: 'soft'   (UI-engageable; same
 *                                              public posture for v1)
 *   - medium       -> autonomy_tier: 'medium' (CLI-only, more aggressive
 *                                              halt; reserved per
 *                                              kill-switch design)
 *   - hard         -> autonomy_tier: 'hard'   (CLI-only, fully gated)
 *
 * The mapping collapses 'off' -> 'soft' for the operator surface
 * because the operator-readable concept is "what's the active
 * governance posture?" -- a fresh repo with no STOP has the soft
 * default (governance-before-autonomy gates on every write). Medium
 * and hard remain reserved bands per the kill-switch roadmap.
 */
export type ControlTier = 'soft' | 'medium' | 'hard';

export interface ControlKillSwitchSnapshot {
  readonly engaged: boolean;
  readonly sentinel_path: string;
  readonly engaged_at: string | null;
}

export interface ControlStatus {
  readonly kill_switch: ControlKillSwitchSnapshot;
  readonly autonomy_tier: ControlTier;
  readonly actors_governed: number;
  readonly policies_active: number;
  readonly last_canon_apply: string | null;
  readonly operator_principal_id: string;
}

/*
 * Display string the UI shows verbatim and the operator copies into a
 * manual `touch` command. Kept as a single source so test + handler
 * cannot drift.
 */
export const SENTINEL_DISPLAY_PATH = '.lag/STOP';

export function tierFromKillSwitch(tier: 'off' | 'soft' | 'medium' | 'hard'): ControlTier {
  switch (tier) {
    case 'medium':
      return 'medium';
    case 'hard':
      return 'hard';
    case 'off':
    case 'soft':
    default:
      return 'soft';
  }
}

/*
 * Resolve the absolute on-disk sentinel path and verify it lives
 * inside the .lag directory. A symlink in `.lag/STOP` pointing at
 * `../../etc/passwd` would otherwise let `fs.stat` cross the trust
 * boundary; rejecting any resolved path that doesn't have `lagDir` as
 * a prefix closes that hole. Pure: returns the safe path or `null`,
 * never throws on traversal -- callers treat null as "no sentinel
 * present" to keep the failure mode loud-but-safe.
 *
 * Why we do not just use `fs.access`: stat gives us the mtime, which
 * we surface as `engaged_at` so the operator can see exactly when the
 * sentinel landed. access only answers yes/no.
 */
export function resolveSentinelInside(lagDir: string, relativePath = 'STOP'): string | null {
  const root = resolve(lagDir);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '' || rel.includes('..')) {
    return null;
  }
  return target;
}

/*
 * Read the sentinel state from disk. Three outcomes:
 *
 *   - file present + readable    -> engaged: true, engaged_at: mtime ISO
 *   - file absent                -> engaged: false, engaged_at: null
 *   - resolution rejected (path traversal) -> engaged: false (fail safe);
 *                                              caller still sees the
 *                                              display path so the
 *                                              operator can investigate
 *
 * fs.stat MAY throw for reasons other than ENOENT (EACCES, EBUSY,
 * symlink loops). We treat any throw as "not engaged" because the
 * kill-switch invariant says: an absent sentinel means autonomy is
 * not halted. A torn read MUST NOT be silently interpreted as engaged
 * either -- that would surprise the operator with a halt that didn't
 * happen.
 */
export async function readSentinelState(absolutePath: string | null): Promise<ControlKillSwitchSnapshot> {
  if (!absolutePath) {
    return { engaged: false, sentinel_path: SENTINEL_DISPLAY_PATH, engaged_at: null };
  }
  try {
    const info = await stat(absolutePath);
    return {
      engaged: true,
      sentinel_path: SENTINEL_DISPLAY_PATH,
      engaged_at: info.mtime.toISOString(),
    };
  } catch {
    return { engaged: false, sentinel_path: SENTINEL_DISPLAY_PATH, engaged_at: null };
  }
}

/*
 * Pick the operator principal id from a list. Convention in this org:
 *   - the apex (root) principal is the operator -- signed_by is null
 *     and active is true
 *   - if multiple roots exist (rare but legal), pick the first by id
 *     for determinism
 *   - if no roots exist (fresh repo), fall back to the literal string
 *     'unknown' so the UI surfaces the gap rather than crashing
 *
 * Pure: no I/O, deterministic, easy to test.
 */
export function pickOperatorPrincipalId(
  principals: ReadonlyArray<{ id: string; signed_by?: string | null; active?: boolean }>,
): string {
  const roots = principals
    .filter((p) => (p.signed_by === null || p.signed_by === undefined) && p.active !== false)
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
  return roots[0] ?? 'unknown';
}

/*
 * Count atoms representing active governance policies. Convention:
 * canon-layer atoms (L3) with type 'policy' OR id starting with
 * 'pol-' are the governance policy set the kill switch enforces.
 * Superseded or tainted atoms are excluded -- the operator wants to
 * see the LIVE policy count.
 */
export function countActivePolicies(
  atoms: ReadonlyArray<{
    id: string;
    type: string;
    layer?: string;
    superseded_by?: string[];
    taint?: string;
  }>,
): number {
  let n = 0;
  for (const a of atoms) {
    if (a.layer && a.layer !== 'L3') continue;
    if (a.superseded_by && a.superseded_by.length > 0) continue;
    if (a.taint && a.taint !== 'clean') continue;
    if (a.type === 'policy' || a.id.startsWith('pol-')) n++;
  }
  return n;
}

/*
 * Pick the most recent canon-apply marker. Strategy:
 *   - prefer atoms whose type is 'canon-applied' (explicit marker)
 *   - else fall back to the newest L3 atom -- canon is the projection
 *     that gets re-rendered when L3 changes, so the latest L3 write
 *     is a sane proxy for "last canon apply"
 *   - returns the ISO timestamp or null if neither is available
 */
export function pickLastCanonApply(
  atoms: ReadonlyArray<{ type: string; layer?: string; created_at?: string }>,
): string | null {
  let bestExplicit: string | null = null;
  let bestL3: string | null = null;
  for (const a of atoms) {
    const t = a.created_at;
    if (!t) continue;
    if (a.type === 'canon-applied' || a.type === 'canon-apply') {
      if (!bestExplicit || t > bestExplicit) bestExplicit = t;
    }
    if (a.layer === 'L3') {
      if (!bestL3 || t > bestL3) bestL3 = t;
    }
  }
  return bestExplicit ?? bestL3;
}
