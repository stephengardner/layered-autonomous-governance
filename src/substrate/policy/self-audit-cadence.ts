/**
 * Self-audit cadence canon-policy reader.
 *
 * Mirrors the shape of `src/runtime/loop/loop-pass-claim-reaper.ts` so
 * the two tunable substrate knobs (claim-reaper enable, self-audit
 * cadence + enable) reuse one read pattern. Promotes the self-audit
 * cadence knob the LoopRunner consumes to a canon policy atom so
 * deployments tune the cadence at scope boundaries without a framework
 * release. The knob is tuning data, not code; tunable cadence + enable
 * belongs in canon, not constants.
 *
 * Substrate purity: the reader is mechanism-only. It scans canon
 * directive atoms for `metadata.policy.subject ===
 * 'self-audit-cadence'`, matching the read shape of
 * `readLoopPassClaimReaperFromCanon` so future maintainers see one
 * pattern, not two.
 *
 * Resolution chain at the call site (LoopRunner.selfAuditPass):
 *   1. canon policy atom (this reader): preferred, deployment-tunable
 *   2. hardcoded default `{enabled: false, intervalMs: 3_600_000}`:
 *      default-off so a deployment that opted into the
 *      `runSelfAuditPass` flag without yet seeding canon does not
 *      surprise-spend on every tick.
 *
 * Loud-fail at the layer boundary: when a policy atom EXISTS but its
 * payload is malformed (`enabled` not a boolean, `intervalMs` not a
 * finite positive integer), the reader logs a warning to stderr naming
 * the bad field and returns the hardcoded default so the caller falls
 * through to default-off. The operator sees the warning rather than a
 * silent default substitution.
 */

import type { Host } from '../interface.js';

/**
 * Policy atom subject discriminator. Mirrors the convention of the
 * other tunable dials (`reaper-ttls`, `pipeline-reaper-ttls`,
 * `loop-pass-claim-reaper-default`).
 */
const POLICY_SUBJECT = 'self-audit-cadence';

/**
 * Hardcoded fallback. Default-off so a deployment that opted into the
 * `runSelfAuditPass` flag without yet seeding canon does not
 * surprise-spend on every tick. 1-hour interval matches the cadence a
 * reasonable operator-cron would choose; the field exists primarily
 * so the policy atom can carry both knobs through one read.
 */
export const DEFAULT_SELF_AUDIT_CADENCE: SelfAuditCadencePolicy = Object.freeze({
  enabled: false,
  intervalMs: 60 * 60 * 1000,
});

/**
 * Resolved self-audit cadence knob shape. A struct so future fields
 * (e.g. per-scope filter, max-ticks-per-day cap) extend the policy
 * atom without changing this reader's return type or its call site in
 * `LoopRunner.selfAuditPass`.
 */
export interface SelfAuditCadencePolicy {
  readonly enabled: boolean;
  readonly intervalMs: number;
}

/**
 * Read the configured self-audit cadence knob from canon. Returns the
 * validated struct when a clean, non-superseded policy atom with
 * subject='self-audit-cadence' exists and carries a well-formed
 * payload. Returns the hardcoded default when:
 *   - no policy atom exists (caller-level default-off posture)
 *   - the policy atom exists but its payload is malformed (caller
 *     logs and falls through; the warning is emitted by this reader
 *     so the operator sees the boundary-failure signal)
 *
 * Validation rules:
 *   - `enabled` must be a strict boolean. Coercion via `Boolean(...)`
 *     is wrong because the string `"false"` is truthy -- silently
 *     flipping an operator-typed `"false"` to `true` would lie about
 *     the configured posture.
 *   - `intervalMs` must be a finite positive integer. Zero would
 *     fire the tick every loop iteration (no cadence); negative or
 *     NaN are canon authoring bugs.
 *
 * A non-conforming field falls through to the hardcoded default with
 * a stderr warning.
 *
 * Substrate purity: the reader never throws on malformed canon. A
 * malformed policy atom is operator data, not framework state;
 * failing the boot would take the self-audit pass offline because
 * someone fat-fingered a JSON value. Falling through to the hardcoded
 * default keeps the loop alive while surfacing the error.
 */
export async function loadSelfAuditCadence(host: Host): Promise<SelfAuditCadencePolicy> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    // Constrain to L3 (canonical layer) so a same-subject non-canon
    // directive (L0/L1/L2) cannot impersonate authoritative canon.
    // Mirrors the L3-only scan in
    // `src/runtime/loop/loop-pass-claim-reaper.ts`; without this filter
    // an attacker-or-mistake L0/L1 atom with the same subject
    // discriminator could flip the cadence knob.
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      PAGE_SIZE,
      cursor,
    );
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      // Guard the metadata shape before indexing. Atom.metadata is a
      // best-effort record on the substrate side -- a JSON write that
      // dropped the field, an externally-edited atom file, or a future
      // schema migration could leave it null/undefined/non-object.
      const meta = atom.metadata;
      if (typeof meta !== 'object' || meta === null) continue;
      const policy = (meta as Record<string, unknown>)['policy'] as
        | Record<string, unknown>
        | undefined;
      if (!policy || policy['subject'] !== POLICY_SUBJECT) continue;
      // Strict-typed read: only `true` / `false` round-trip; any other
      // shape (string, number, null, missing) is a malformed payload.
      const rawEnabled = policy['enabled'];
      if (typeof rawEnabled !== 'boolean') {
        // eslint-disable-next-line no-console
        console.error(
          `[self-audit-cadence] WARN: policy atom '${atom.id}' has malformed `
          + `payload (enabled=${JSON.stringify(rawEnabled)}); falling through to hardcoded `
          + 'default. Field must be a strict boolean.',
        );
        return DEFAULT_SELF_AUDIT_CADENCE;
      }
      const rawInterval = policy['intervalMs'];
      if (
        typeof rawInterval !== 'number'
        || !Number.isFinite(rawInterval)
        || !Number.isInteger(rawInterval)
        || rawInterval <= 0
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `[self-audit-cadence] WARN: policy atom '${atom.id}' has malformed `
          + `payload (intervalMs=${JSON.stringify(rawInterval)}); falling through to hardcoded `
          + 'default. Field must be a finite positive integer (ms).',
        );
        return DEFAULT_SELF_AUDIT_CADENCE;
      }
      return { enabled: rawEnabled, intervalMs: rawInterval };
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_SELF_AUDIT_CADENCE;
}
