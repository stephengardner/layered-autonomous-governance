/**
 * Reaper TTL canon-policy reader.
 *
 * Promotes the warn / abandon TTL knobs from CLI flags + env vars to a
 * canon policy atom so deployments can tune the cadence at scope
 * boundaries without a framework release. The knobs are tuning data,
 * not code; tunable thresholds belong in canon, not constants.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for `metadata.policy.subject === 'reaper-ttls'`,
 * matching the read shape of `readApprovalCycleTickIntervalMs` and
 * `readPrObservationFreshnessMs` so future maintainers see one
 * pattern, not three.
 *
 * Resolution chain at the call site (LoopRunner):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. `LoopOptions.reaperWarnMs` / `reaperAbandonMs`: env / CLI fallback
 *   3. `DEFAULT_REAPER_TTLS`: hardcoded floor (24h / 72h)
 *
 * Loud-fail at the layer boundary: when a policy atom EXISTS but its
 * payload is malformed (non-integer, inverted pair, missing field),
 * the reader logs a warning to stderr and returns `null` so the caller
 * falls through to the env / hardcoded path. The operator sees the
 * warning rather than a silent default substitution.
 */

import type { Host } from '../../interface.js';
import type { ReaperTtls } from '../plans/reaper.js';

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * other tunable dials (`approval-cycle-tick-interval-ms`,
 * `pr-observation-freshness-threshold-ms`).
 */
const POLICY_SUBJECT = 'reaper-ttls';

/**
 * Read the configured reaper TTLs from canon. Returns the validated
 * pair when a clean, non-superseded policy atom with
 * subject='reaper-ttls' exists and carries a well-formed payload.
 * Returns `null` when:
 *   - no policy atom exists (caller falls through to env / defaults)
 *   - the policy atom exists but its payload is malformed (caller logs
 *     and falls through; the warning is emitted by this reader so the
 *     operator sees the boundary-failure signal)
 *
 * Validation rules match `validateReaperTtls`:
 *   - both fields present
 *   - both positive integer ms
 *   - abandonMs strictly greater than warnMs
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state; failing
 * the boot would leave the loop offline because someone fat-fingered a
 * JSON value. Falling through to env / defaults keeps the loop alive
 * while surfacing the error.
 */
export async function readReaperTtlsFromCanon(host: Host): Promise<ReaperTtls | null> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== POLICY_SUBJECT) continue;
      // Named fields are canonical. Reject unknown shapes loud-but-
      // recoverable: stderr warning + return null so the caller falls
      // through to env / hardcoded defaults. The operator sees the
      // warning rather than a silent substitution.
      const warnRaw = policy['warn_ms'];
      const abandonRaw = policy['abandon_ms'];
      const warn = typeof warnRaw === 'number' ? warnRaw : Number.NaN;
      const abandon = typeof abandonRaw === 'number' ? abandonRaw : Number.NaN;
      if (
        !Number.isInteger(warn)
        || warn <= 0
        || !Number.isInteger(abandon)
        || abandon <= 0
        || abandon <= warn
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `[reaper-ttls] WARN: reaper-ttls policy atom '${atom.id}' has malformed payload `
          + `(warn_ms=${String(warnRaw)} abandon_ms=${String(abandonRaw)}); falling through `
          + 'to env / hardcoded defaults. Both must be positive integer ms with abandon > warn.',
        );
        return null;
      }
      return { staleWarnMs: warn, staleAbandonMs: abandon };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
