/**
 * Pure assembler: pipeline_id (or plan_id) to chronological
 * conversation thread.
 *
 * The substrate captures the full conversation already: agent-turn
 * atoms (llm_input + llm_output + tool_calls), pipeline-stage-event
 * atoms, pipeline-cross-stage-reprompt atoms, pipeline-audit-finding
 * atoms, brainstorm/spec/plan/review/dispatch-output atoms,
 * actor-message atoms, code-author-invoked observation atoms. All link
 * back to the pipeline_id via provenance.derived_from chains and the
 * common metadata.pipeline_id field.
 *
 * This module walks the atom set, normalizes each kind into the
 * `ConversationEvent` discriminated-union wire shape, and sorts by ts
 * ascending so the renderer paints a top-down chronological feed.
 *
 * Read-only by construction. No I/O, no globals, no time (the
 * `now` parameter feeds `computed_at`). Mirrors the pure-helper
 * pattern in `pipeline-deliberation.ts`, `pipeline-lifecycle.ts`,
 * `plan-state-lifecycle.ts`.
 *
 * Substrate purity (canon `arch-atomstore-source-of-truth`): no new
 * atom types. The view is a projection.
 */
import type {
  ConversationContentBody,
  ConversationDeliberationResult,
  ConversationDispatchOutcome,
  ConversationEvent,
  ConversationEventSeverity,
  ConversationPipelineResult,
  ConversationSourceAtom,
} from './conversation-types.js';
import { readObject, readString } from './projection-helpers.js';

/**
 * Hard cap on the size of an inline-content body sent over the wire.
 * Long llm_input prompts or large stage-output payloads are truncated
 * to this length and the `content_truncated` flag is set; the renderer
 * surfaces a "Show more" affordance that calls
 * /api/conversation.expand-blob for the full payload (BlobStore seam;
 * v1 has no atoms with a BlobRef on disk, so the endpoint returns 404
 * for now).
 *
 * 4000 chars covers >95% of llm_input previews observed in the wild
 * without ballooning the response on a long-running pipeline with
 * dozens of turns. Tunable as a canon edit if an org-ceiling
 * deployment needs more headroom in the inline payload.
 */
export const MAX_INLINE_CONTENT_CHARS = 4000;

/**
 * Hard cap on the number of events returned in a single conversation
 * envelope. A long-running agentic stage can mint hundreds of
 * agent-turn atoms; capping at 500 keeps the wire payload bounded
 * even before the renderer applies its own virtualization. Tunable as
 * a canon edit; deep traces beyond the cap surface a stable
 * truncation marker (the renderer flags when length === cap).
 */
export const MAX_CONVERSATION_EVENTS = 500;

/**
 * Stage-output atom types this projection knows about. The order
 * mirrors the substrate-deep default 5-stage composition per canon
 * `dev-deep-planning-pipeline`. Add a new stage by appending here
 * AND by registering the stage in canon `dev-default-pipeline-stages`.
 */
const STAGE_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  'brainstorm-output',
  'spec-output',
  'plan-output',
  'review-report',
  'dispatch-record',
]);

/**
 * Atom types that resolve to dispatch-result events. The substrate
 * writes `code-author-invoked` observation atoms (type='observation',
 * metadata.kind='code-author-invoked'); this projection also accepts
 * the direct 'code-author-invoked' type if a future substrate revision
 * narrows the schema.
 */
const DISPATCH_OBSERVATION_KINDS: ReadonlySet<string> = new Set([
  'code-author-invoked',
]);

/**
 * Live-atom filter mirroring sibling projections. A tainted or
 * superseded atom is excluded from the conversation; the operator
 * should see the canonical chain, not a forensic archive.
 */
function isCleanLive(atom: ConversationSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Truncate a string to MAX_INLINE_CONTENT_CHARS and emit the
 * standard content-body envelope. content_truncated is true when the
 * substrate value exceeded the cap.
 */
function bodyFromInline(raw: string): ConversationContentBody {
  if (raw.length <= MAX_INLINE_CONTENT_CHARS) {
    return {
      content: raw,
      content_truncated: false,
      blob_ref: null,
    };
  }
  return {
    content: raw.slice(0, MAX_INLINE_CONTENT_CHARS),
    content_truncated: true,
    blob_ref: null,
  };
}

/**
 * Normalize a substrate-side severity string into the projection's
 * 4-band severity enum. Unknown values fall back to 'info' so an
 * atom-schema drift does not break the renderer's switch.
 */
function normalizeSeverity(raw: unknown): ConversationEventSeverity {
  if (raw === 'critical' || raw === 'major' || raw === 'minor' || raw === 'info') {
    return raw;
  }
  return 'info';
}

/**
 * Read provenance.derived_from as a string array; tolerates a missing
 * provenance object or a non-array value (some legacy atoms have
 * provenance: undefined).
 */
function readDerivedFrom(atom: ConversationSourceAtom): ReadonlyArray<string> {
  const prov = atom.provenance ?? {};
  const raw = (prov as Record<string, unknown>)['derived_from'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/**
 * Read a metadata.pipeline_id field, falling back to walking
 * provenance.derived_from for an id starting with 'pipeline-'.
 * Several atom kinds (agent-turn, agent-session) tie back to a
 * pipeline only via the chain, not via a top-level pipeline_id field;
 * this helper unifies the lookup.
 */
function resolvePipelineId(
  atom: ConversationSourceAtom,
  validPipelineIds: ReadonlySet<string>,
): string | null {
  const meta = (atom.metadata ?? {}) as Record<string, unknown>;
  const direct = readString(meta, 'pipeline_id');
  if (direct && validPipelineIds.has(direct)) return direct;
  for (const id of readDerivedFrom(atom)) {
    if (validPipelineIds.has(id)) return id;
  }
  return null;
}

/**
 * Stringify an unknown tool-call args / result value. Strings pass
 * through; objects + arrays JSON-stringify. Null, undefined, and
 * non-object scalars (numbers, booleans) JSON-stringify so the wire
 * shape is a uniform string regardless of substrate-side variance.
 */
function stringifyToolValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Pull a one-line summary from a stage-output / dispatch-record body.
 * Mirrors the firstLine helper in pipelines.ts: strip leading markdown
 * heading marker, return the first non-empty line, cap at 240 chars
 * so the conversation row stays scannable.
 *
 * Stage-output atoms in practice often carry a JSON-stringified body
 * (e.g. brainstorm-output stores a JSON blob whose first non-empty
 * line is literally "{"). When the content parses as a JSON object,
 * prefer a human-readable string field (summary, title, message,
 * decision, intent_summary) over the bare "{" first line. Falls back
 * to the markdown-style firstLine extraction when the content is
 * either non-JSON or lacks a recognized summary field.
 */
function firstLine(text: string): string {
  if (text.length === 0) return '';
  const trimmedHead = text.trimStart();
  if (trimmedHead.startsWith('{') || trimmedHead.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmedHead) as unknown;
      const summary = extractJsonSummary(parsed);
      if (summary) {
        return summary.length > 240 ? `${summary.slice(0, 239)}…` : summary;
      }
      // JSON parsed but no recognized summary field. Emit a key-list
      // hint so the conversation row says something useful instead of
      // the bare "{" the markdown-style fallback would otherwise pick.
      const hint = summarizeJsonKeys(parsed);
      if (hint) return hint;
    } catch {
      // fall through to markdown-style extraction
    }
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^#{1,6}\s+/, '').trim();
    if (trimmed.length > 0) {
      return trimmed.length > 240 ? `${trimmed.slice(0, 239)}…` : trimmed;
    }
  }
  return text.slice(0, 240);
}

/**
 * Try to extract a one-line human-readable summary from a JSON-shaped
 * stage-output payload. Walks a small ordered preference list of
 * common summary-bearing field names; returns null when none resolve
 * to a non-empty string. Arrays + nested objects are not flattened on
 * purpose: a verbose nested payload should fall back to firstLine's
 * markdown extraction rather than risk a misleading deep value.
 */
function extractJsonSummary(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const candidateFields = [
    'summary',
    'title',
    'decision',
    'intent_summary',
    'one_line_summary',
    'message',
    'description',
  ];
  for (const field of candidateFields) {
    const v = obj[field];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Render a JSON payload as a "{ key1, key2, key3 }" hint when no
 * recognized summary field surfaces. Caps at 3 keys + ellipsis when
 * the object has more, so the row stays scannable while still telling
 * the operator what shape the payload has. Returns null for an empty
 * object so the caller falls back to firstLine's markdown path.
 */
function summarizeJsonKeys(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) {
    return parsed.length > 0 ? `[array of ${parsed.length}]` : null;
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length === 0) return null;
  const head = keys.slice(0, 3).join(', ');
  const suffix = keys.length > 3 ? `, +${keys.length - 3} more` : '';
  return `{ ${head}${suffix} }`;
}

/**
 * Map a code-author-invoked observation's executor_result.kind into
 * the canonical dispatch-outcome enum. The substrate may write a
 * variety of substrings; this maps them to the 5-band outcome the
 * renderer + the trueOutcome surface agree on.
 */
function mapDispatchResult(
  executorResult: Readonly<Record<string, unknown>> | null,
  prUrl: string | null,
): ConversationDispatchOutcome {
  if (prUrl) return 'pr-opened';
  if (!executorResult) return 'no-op';
  const kind = readString(executorResult, 'kind');
  if (!kind) return 'no-op';
  const reason = readString(executorResult, 'reason') ?? '';
  if (kind === 'ok' || kind === 'opened' || kind === 'merged') return 'pr-opened';
  if (kind === 'silent-skip' || kind === 'refused' || reason.includes('refus')) return 'silent-skip';
  if (kind === 'empty-diff' || reason.includes('empty')) return 'empty-diff';
  if (kind === 'error' || kind === 'failed') return 'failed';
  return 'no-op';
}

/**
 * Project one source atom into zero or more conversation events.
 * Returns the array (possibly empty) rather than a single event because
 * an agent-turn atom can fan out into prompt + response + N tool-call
 * events from a single source row.
 */
function projectAtom(
  atom: ConversationSourceAtom,
  ctx: { pipelineIds: ReadonlySet<string> },
): ReadonlyArray<ConversationEvent> {
  const meta = (atom.metadata ?? {}) as Record<string, unknown>;
  const events: ConversationEvent[] = [];

  switch (atom.type) {
    case 'operator-intent': {
      events.push({
        kind: 'operator-intent',
        atom_id: atom.id,
        ts: atom.created_at,
        principal_id: atom.principal_id,
        body: bodyFromInline(atom.content),
      });
      break;
    }

    case 'pipeline-stage-event': {
      const stage = readString(meta, 'stage_name');
      const transition = readString(meta, 'transition');
      if (stage && transition === 'enter') {
        events.push({
          kind: 'stage-started',
          atom_id: atom.id,
          ts: atom.created_at,
          principal_id: atom.principal_id,
          stage,
        });
      }
      break;
    }

    case 'agent-turn': {
      const turnMeta = readObject(meta, 'agent_turn');
      if (!turnMeta) break;
      const sessionAtomId = readString(turnMeta, 'session_atom_id');
      const turnIndexRaw = turnMeta['turn_index'];
      const turnIndex = typeof turnIndexRaw === 'number' && Number.isFinite(turnIndexRaw)
        ? turnIndexRaw
        : null;
      if (!sessionAtomId || turnIndex === null) break;
      const stage = readString(meta, 'stage_name') ?? undefined;
      const llmInput = readObject(turnMeta, 'llm_input');
      const llmOutput = readObject(turnMeta, 'llm_output');
      const promptInline = llmInput ? readString(llmInput, 'inline') : null;
      const responseInline = llmOutput ? readString(llmOutput, 'inline') : null;
      const latencyRaw = turnMeta['latency_ms'];
      const latencyMs = typeof latencyRaw === 'number' && Number.isFinite(latencyRaw)
        ? latencyRaw
        : 0;
      if (promptInline) {
        events.push({
          kind: 'agent-prompt',
          atom_id: atom.id,
          ts: atom.created_at,
          principal_id: atom.principal_id,
          ...(stage ? { stage } : {}),
          turn_index: turnIndex,
          session_atom_id: sessionAtomId,
          body: bodyFromInline(promptInline),
        });
      }
      if (responseInline) {
        events.push({
          kind: 'agent-response',
          atom_id: atom.id,
          ts: atom.created_at,
          principal_id: atom.principal_id,
          ...(stage ? { stage } : {}),
          turn_index: turnIndex,
          session_atom_id: sessionAtomId,
          body: bodyFromInline(responseInline),
          latency_ms: latencyMs,
        });
      }
      const toolCallsRaw = turnMeta['tool_calls'];
      if (Array.isArray(toolCallsRaw)) {
        toolCallsRaw.forEach((entry, callIndex) => {
          if (!entry || typeof entry !== 'object') return;
          const e = entry as Record<string, unknown>;
          const name = readString(e, 'name') ?? readString(e, 'tool') ?? null;
          if (!name) return;
          const argsRaw = e['args'] ?? e['arguments'] ?? null;
          const resultRaw = e['result'] ?? e['output'] ?? null;
          const argsStr = stringifyToolValue(argsRaw);
          const resultStrFull = stringifyToolValue(resultRaw);
          const resultStr = resultStrFull.length > MAX_INLINE_CONTENT_CHARS
            ? resultStrFull.slice(0, MAX_INLINE_CONTENT_CHARS)
            : resultStrFull;
          events.push({
            kind: 'tool-call',
            atom_id: `${atom.id}:tool-${callIndex}`,
            ts: atom.created_at,
            principal_id: atom.principal_id,
            ...(stage ? { stage } : {}),
            parent_turn_index: turnIndex,
            session_atom_id: sessionAtomId,
            tool_name: name,
            args: argsStr,
            result: resultStr,
            result_truncated: resultStrFull.length > MAX_INLINE_CONTENT_CHARS,
          });
        });
      }
      break;
    }

    case 'actor-message': {
      const message = readObject(meta, 'message');
      if (!message) break;
      const recipient = readString(message, 'recipient_principal_id');
      if (!recipient) break;
      const content = readString(message, 'content') ?? atom.content;
      const urgency = readString(message, 'urgency');
      events.push({
        kind: 'inter-agent-message',
        atom_id: atom.id,
        ts: atom.created_at,
        principal_id: atom.principal_id,
        recipient_principal_id: recipient,
        body: bodyFromInline(content),
        urgency: urgency ?? null,
      });
      break;
    }

    case 'pipeline-cross-stage-reprompt': {
      const fromStage = readString(meta, 'from_stage');
      const toStage = readString(meta, 'to_stage');
      const attemptRaw = meta['attempt'];
      const attempt = typeof attemptRaw === 'number' && Number.isFinite(attemptRaw)
        ? attemptRaw
        : null;
      const findingObj = readObject(meta, 'finding');
      if (!fromStage || !toStage || attempt === null || !findingObj) break;
      const severity = normalizeSeverity(findingObj['severity']);
      const category = readString(findingObj, 'category') ?? 'unknown';
      const message = readString(findingObj, 'message') ?? '';
      const citedAtoms = Array.isArray(findingObj['cited_atom_ids'])
        ? findingObj['cited_atom_ids'].filter((x): x is string => typeof x === 'string')
        : [];
      const citedPaths = Array.isArray(findingObj['cited_paths'])
        ? findingObj['cited_paths'].filter((x): x is string => typeof x === 'string')
        : [];
      const threadParentRaw = meta['thread_parent'];
      const threadParent = threadParentRaw === null
        ? null
        : (typeof threadParentRaw === 'string' && threadParentRaw.length > 0
          ? threadParentRaw
          : null);
      events.push({
        kind: 'cross-stage-reprompt',
        atom_id: atom.id,
        ts: atom.created_at,
        principal_id: atom.principal_id,
        from_stage: fromStage,
        to_stage: toStage,
        attempt,
        severity,
        category,
        message,
        cited_atom_ids: citedAtoms,
        cited_paths: citedPaths,
        thread_parent: threadParent,
      });
      break;
    }

    case 'pipeline-audit-finding': {
      const stage = readString(meta, 'stage_name') ?? undefined;
      const severity = normalizeSeverity(meta['severity']);
      const category = readString(meta, 'category') ?? 'unknown';
      const message = readString(meta, 'message') ?? atom.content;
      const citedAtoms = Array.isArray(meta['cited_atom_ids'])
        ? meta['cited_atom_ids'].filter((x): x is string => typeof x === 'string')
        : [];
      events.push({
        kind: 'audit-finding',
        atom_id: atom.id,
        ts: atom.created_at,
        principal_id: atom.principal_id,
        ...(stage ? { stage } : {}),
        severity,
        category,
        message,
        cited_atom_ids: citedAtoms,
      });
      break;
    }

    case 'observation': {
      // Dispatch result via metadata.kind='code-author-invoked'.
      const kind = readString(meta, 'kind');
      if (!kind || !DISPATCH_OBSERVATION_KINDS.has(kind)) break;
      const executorResult = readObject(meta, 'executor_result');
      const prUrl = executorResult ? readString(executorResult, 'pr_url') : null;
      const outcome = mapDispatchResult(executorResult, prUrl);
      events.push({
        kind: 'dispatch-result',
        atom_id: atom.id,
        ts: atom.created_at,
        principal_id: atom.principal_id,
        result: outcome,
        pr_url: prUrl,
        summary: firstLine(atom.content),
      });
      break;
    }

    default: {
      // Stage outputs share a common shape: type matches a known
      // STAGE_OUTPUT_TYPES entry, metadata carries stage_name +
      // pipeline_id, content carries the full payload.
      if (STAGE_OUTPUT_TYPES.has(atom.type)) {
        const stage = readString(meta, 'stage_name');
        if (!stage) break;
        events.push({
          kind: 'stage-output',
          atom_id: atom.id,
          ts: atom.created_at,
          principal_id: atom.principal_id,
          stage,
          output_type: atom.type,
          summary: firstLine(atom.content),
        });
      }
      break;
    }
  }

  // Suppress the unused-context warning by referencing it; later
  // additions (e.g. pipeline_id reconciliation per atom) reach for
  // ctx.pipelineIds.
  void ctx;
  return events;
}

/**
 * Resolve the operator-intent atom id from the pipeline atom's
 * provenance.derived_from chain. Returns the first id that matches a
 * known operator-intent atom in the set. We deliberately require the
 * intent atom to be present rather than blindly returning any
 * 'intent-' prefixed id: the conversation view shows the intent body
 * as the first row, and returning a dangling id would render an
 * orphan card with no content.
 */
function resolveIntentIdForPipeline(
  pipeline: ConversationSourceAtom,
  byId: ReadonlyMap<string, ConversationSourceAtom>,
): string | null {
  for (const derivedId of readDerivedFrom(pipeline)) {
    const candidate = byId.get(derivedId);
    if (candidate && candidate.type === 'operator-intent') {
      return candidate.id;
    }
  }
  return null;
}

/**
 * Stable chronological sort. Primary key: ts (parsed). Secondary:
 * atom_id (lexical) for deterministic ordering on equal timestamps.
 *
 * Atoms with malformed timestamps sort to the END so the operator
 * still sees the bulk of the chain in correct order; flagging them
 * is a future enhancement.
 */
function sortEvents(events: ReadonlyArray<ConversationEvent>): ReadonlyArray<ConversationEvent> {
  const sortable = [...events];
  sortable.sort((a, b) => {
    const aTs = Date.parse(a.ts);
    const bTs = Date.parse(b.ts);
    const aValid = Number.isFinite(aTs);
    const bValid = Number.isFinite(bTs);
    if (aValid && bValid && aTs !== bTs) return aTs - bTs;
    if (aValid && !bValid) return -1;
    if (!aValid && bValid) return 1;
    return a.atom_id.localeCompare(b.atom_id);
  });
  return sortable;
}

/**
 * Assemble the conversation envelope for a single pipeline_id.
 * Returns null when the pipeline atom does not exist (the caller
 * mirrors the 404 contract used by pipelines.detail).
 */
export function assembleConversationForPipeline(
  atoms: ReadonlyArray<ConversationSourceAtom>,
  pipelineId: string,
  now: number,
): ConversationPipelineResult | null {
  const liveAtoms = atoms.filter(isCleanLive);
  const pipelineAtom = liveAtoms.find(
    (a) => a.type === 'pipeline' && a.id === pipelineId,
  );
  if (!pipelineAtom) return null;
  const byId = new Map<string, ConversationSourceAtom>();
  for (const a of liveAtoms) {
    byId.set(a.id, a);
  }
  const intentId = resolveIntentIdForPipeline(pipelineAtom, byId);
  const pipelineIds = new Set<string>([pipelineId]);
  // operator-intent for the pipeline is "tied" by the pipeline itself
  // pointing at it via derived_from; include the intent in the
  // selection so it shows as the first row.
  const intentAtom = intentId ? byId.get(intentId) : null;
  const collected: ConversationEvent[] = [];
  if (intentAtom) {
    for (const ev of projectAtom(intentAtom, { pipelineIds })) collected.push(ev);
  }
  for (const atom of liveAtoms) {
    if (atom === pipelineAtom) continue;
    if (intentAtom && atom === intentAtom) continue;
    const tiedPipelineId = resolvePipelineId(atom, pipelineIds);
    if (!tiedPipelineId) continue;
    for (const ev of projectAtom(atom, { pipelineIds })) collected.push(ev);
  }
  const sorted = sortEvents(collected);
  const capped = sorted.length > MAX_CONVERSATION_EVENTS
    ? sorted.slice(0, MAX_CONVERSATION_EVENTS)
    : sorted;
  return {
    pipeline_id: pipelineId,
    intent_id: intentId,
    events: capped,
    computed_at: new Date(now).toISOString(),
  };
}

/**
 * Resolve the linked pipeline_id from a plan atom. Tries metadata
 * first (substrate-deep plans carry pipeline_id explicitly), then
 * walks provenance.derived_from for a pipeline-shaped id. Returns
 * null when neither resolves.
 */
function resolvePipelineIdForPlan(
  plan: ConversationSourceAtom,
  byId: ReadonlyMap<string, ConversationSourceAtom>,
): string | null {
  const meta = (plan.metadata ?? {}) as Record<string, unknown>;
  const fromMeta = readString(meta, 'pipeline_id');
  if (fromMeta) {
    const candidate = byId.get(fromMeta);
    if (candidate && candidate.type === 'pipeline') return fromMeta;
    if (fromMeta.startsWith('pipeline-')) return fromMeta;
  }
  for (const derivedId of readDerivedFrom(plan)) {
    const candidate = byId.get(derivedId);
    if (candidate && candidate.type === 'pipeline') return derivedId;
  }
  for (const derivedId of readDerivedFrom(plan)) {
    if (derivedId.startsWith('pipeline-')) return derivedId;
  }
  return null;
}

/**
 * Resolve the operator-intent id from a plan atom. Tries the plan's
 * provenance.derived_from chain; if a pipeline is resolved, falls
 * back to the pipeline's own intent chain (some substrate revisions
 * only stamp intent on the pipeline, not on the plan).
 */
function resolveIntentIdForPlan(
  plan: ConversationSourceAtom,
  pipelineId: string | null,
  byId: ReadonlyMap<string, ConversationSourceAtom>,
): string | null {
  for (const derivedId of readDerivedFrom(plan)) {
    const candidate = byId.get(derivedId);
    if (candidate && candidate.type === 'operator-intent') return candidate.id;
  }
  if (pipelineId) {
    const pipelineAtom = byId.get(pipelineId);
    if (pipelineAtom) return resolveIntentIdForPipeline(pipelineAtom, byId);
  }
  return null;
}

/**
 * Assemble the conversation envelope for a single plan_id. Returns
 * null when the plan atom does not exist. When the plan's pipeline_id
 * resolves, events for that pipeline are folded in; when not, the
 * envelope ships an empty events array and `pipeline_id: null` so the
 * renderer can show a graceful empty-state.
 */
export function assembleConversationForPlan(
  atoms: ReadonlyArray<ConversationSourceAtom>,
  planId: string,
  now: number,
): ConversationDeliberationResult | null {
  const liveAtoms = atoms.filter(isCleanLive);
  const planAtom = liveAtoms.find(
    (a) => a.type === 'plan' && a.id === planId,
  );
  if (!planAtom) return null;
  const byId = new Map<string, ConversationSourceAtom>();
  for (const a of liveAtoms) {
    byId.set(a.id, a);
  }
  const pipelineId = resolvePipelineIdForPlan(planAtom, byId);
  const intentId = resolveIntentIdForPlan(planAtom, pipelineId, byId);
  let events: ReadonlyArray<ConversationEvent> = [];
  if (pipelineId) {
    const pipelineResult = assembleConversationForPipeline(liveAtoms, pipelineId, now);
    if (pipelineResult) {
      events = pipelineResult.events;
    }
  }
  return {
    plan_id: planId,
    intent_id: intentId,
    pipeline_id: pipelineId,
    events,
    computed_at: new Date(now).toISOString(),
  };
}
