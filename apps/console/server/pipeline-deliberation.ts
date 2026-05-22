/**
 * Pure projection: pipeline_id -> cross-stage deliberation thread.
 *
 * The substrate's planning-pipeline runner emits one
 * `pipeline-cross-stage-reprompt` atom per cross-stage re-prompt event.
 * Each atom carries a finding + thread_parent pointer + attempt counter
 * so the Console can reconstruct the chain as a deliberation thread
 * (FROM_STAGE -> TO_STAGE handoffs).
 *
 * This module is pure (no I/O, no globals, no time): the handler in
 * server/index.ts feeds the full atom array; this module filters,
 * sorts, and projects into the wire shape.
 *
 * Read-only by construction. Mirrors the pure-helper pattern used by
 * pipelines.ts, pipeline-lifecycle.ts, and plan-state-lifecycle.ts so
 * the projections compose cleanly in the request handler.
 *
 * The atom is dormant unless `pol-cross-stage-reprompt-default` is
 * seeded; this projection still renders whatever atoms exist regardless
 * of policy state (per the spec's Phase 2 PR5 contract).
 */
import type {
  PipelineDeliberationEntry,
  PipelineDeliberationFinding,
  PipelineDeliberationResult,
  PipelineDeliberationSeverity,
  PipelineDeliberationSourceAtom,
} from './pipeline-deliberation-types.js';
import { readObject, readString } from './projection-helpers.js';

/**
 * Hard cap on the number of deliberation entries returned for a single
 * pipeline. The substrate caps `pol-cross-stage-reprompt-default`
 * max_attempts so a runaway loop cannot fire forever; this cap is the
 * substrate-floor x 2 plus headroom so a malformed or pre-cap-aware
 * atom set still bounds the wire payload. Renderers truncate visually
 * if more entries land, never silently.
 */
export const MAX_DELIBERATION_ENTRIES = 100;

/**
 * Live-atom filter mirroring the sibling projections. A tainted or
 * superseded atom is excluded from the deliberation thread; the
 * operator should see the canonical event chain, not a forensic
 * archive.
 */
function isCleanLive(atom: PipelineDeliberationSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Read a finite integer from metadata; returns null when the value is
 * absent, non-numeric, NaN, infinite, or fractional. Strict because
 * attempt is a 1-based positive counter and a bad value would
 * misorder the chain.
 */
function readPositiveInteger(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const v = meta[key];
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 1) return null;
  return v;
}

/**
 * Coerce an unknown metadata value to a string array of non-empty
 * entries. Drops empty / non-string entries silently so a malformed
 * atom does not crash the projection.
 */
function readStringArray(
  meta: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/**
 * Materialize a `pipeline-cross-stage-reprompt` atom into the wire
 * `PipelineDeliberationEntry` shape. Returns null when the atom is
 * malformed (missing required fields, wrong shapes) so the projection
 * skips it rather than surfacing a partial entry.
 *
 * Required fields per the substrate mint contract
 * (`mkPipelineCrossStageRepromptAtom`):
 *   - metadata.pipeline_id           (matches the requested pipeline)
 *   - metadata.correlation_id        (string)
 *   - metadata.from_stage            (non-empty string)
 *   - metadata.to_stage              (non-empty string, != from_stage)
 *   - metadata.attempt               (positive integer)
 *   - metadata.thread_parent         (atom id string OR null)
 *   - metadata.verified_cited_atom_ids_origin (string)
 *   - metadata.finding               (object with severity/category/
 *                                     message/cited_atom_ids/cited_paths/
 *                                     reprompt_target)
 *
 * `thread_parent` is the only field where the substrate explicitly
 * writes `null` (first re-prompt in a chain). We honor that distinction
 * because the renderer uses it to detect the head of the thread.
 */
function entryFromAtom(
  atom: PipelineDeliberationSourceAtom,
): PipelineDeliberationEntry | null {
  const meta = (atom.metadata ?? {}) as Record<string, unknown>;
  const pipelineId = readString(meta, 'pipeline_id');
  const correlationId = readString(meta, 'correlation_id');
  const fromStage = readString(meta, 'from_stage');
  const toStage = readString(meta, 'to_stage');
  const attempt = readPositiveInteger(meta, 'attempt');
  const verifiedOrigin = readString(meta, 'verified_cited_atom_ids_origin');
  const findingObj = readObject(meta, 'finding');
  if (
    !pipelineId
    || !correlationId
    || !fromStage
    || !toStage
    || attempt === null
    || !verifiedOrigin
    || !findingObj
  ) {
    return null;
  }
  // thread_parent is allowed to be null (first re-prompt) OR a non-empty
  // string (subsequent re-prompts). Anything else is malformed.
  const threadParentRaw = meta['thread_parent'];
  let threadParent: string | null;
  if (threadParentRaw === null) {
    threadParent = null;
  } else if (typeof threadParentRaw === 'string' && threadParentRaw.length > 0) {
    threadParent = threadParentRaw;
  } else {
    return null;
  }
  // Validate the finding shape inline so a malformed inner field drops
  // the whole entry rather than surfacing partial data.
  const finding = projectFinding(findingObj);
  if (!finding) return null;
  return {
    atom_id: atom.id,
    pipeline_id: pipelineId,
    correlation_id: correlationId,
    from_stage: fromStage,
    to_stage: toStage,
    attempt,
    thread_parent: threadParent,
    verified_cited_atom_ids_origin: verifiedOrigin,
    finding,
    principal_id: atom.principal_id,
    created_at: atom.created_at,
  };
}

/**
 * Project the inner finding object. Returns null on any field
 * violation. Severity is constrained to the canonical bucket set per
 * the substrate's `CrossStageRepromptFindingShape`.
 */
function projectFinding(
  obj: Readonly<Record<string, unknown>>,
): PipelineDeliberationFinding | null {
  const severityRaw = obj['severity'];
  if (
    severityRaw !== 'critical'
    && severityRaw !== 'major'
    && severityRaw !== 'minor'
  ) {
    return null;
  }
  const severity: PipelineDeliberationSeverity = severityRaw;
  const categoryRaw = obj['category'];
  if (typeof categoryRaw !== 'string' || categoryRaw.length === 0) return null;
  const messageRaw = obj['message'];
  if (typeof messageRaw !== 'string' || messageRaw.length === 0) return null;
  const repromptTargetRaw = obj['reprompt_target'];
  if (typeof repromptTargetRaw !== 'string' || repromptTargetRaw.length === 0) {
    return null;
  }
  return {
    severity,
    category: categoryRaw,
    message: messageRaw,
    cited_atom_ids: readStringArray(obj, 'cited_atom_ids'),
    cited_paths: readStringArray(obj, 'cited_paths'),
    reprompt_target: repromptTargetRaw,
  };
}

/**
 * Build the deliberation result for one pipeline.
 *
 * Filtering rules:
 *   - atom.type === 'pipeline-cross-stage-reprompt'
 *   - clean-live filter
 *   - metadata.pipeline_id === requested pipelineId
 *   - structural validity (every required field projects cleanly)
 *
 * Ordering rules:
 *   - PRIMARY: attempt ascending (the unified pipeline attempt counter
 *     is monotonic across re-prompt walks, so this is the canonical
 *     chain order).
 *   - SECONDARY: created_at ascending (tiebreaker on equal attempts;
 *     should never fire under the substrate contract but defends
 *     against malformed atoms).
 *   - TERTIARY: atom_id ascending (deterministic stable sort for
 *     malformed-tie cases).
 */
export function listPipelineDeliberation(
  atoms: ReadonlyArray<PipelineDeliberationSourceAtom>,
  pipelineId: string,
  now: number,
): PipelineDeliberationResult {
  const entries: PipelineDeliberationEntry[] = [];
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-cross-stage-reprompt') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    const entry = entryFromAtom(atom);
    if (!entry) continue;
    entries.push(entry);
  }
  entries.sort((a, b) => {
    if (a.attempt !== b.attempt) return a.attempt - b.attempt;
    const aTs = Date.parse(a.created_at);
    const bTs = Date.parse(b.created_at);
    if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
      return aTs - bTs;
    }
    return a.atom_id.localeCompare(b.atom_id);
  });
  return {
    pipeline_id: pipelineId,
    entries: entries.slice(0, MAX_DELIBERATION_ENTRIES),
    computed_at: new Date(now).toISOString(),
  };
}
