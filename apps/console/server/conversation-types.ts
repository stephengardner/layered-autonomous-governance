/**
 * Wire-shape definitions for the conversation-thread surface.
 *
 * The /pipelines/<id>/conversation and /deliberation/<id>/conversation
 * views render the FULL chronological conversation behind a pipeline
 * or a plan: literal LLM prompts + responses, tool calls with args +
 * outputs, inter-agent messages, cross-stage handoffs, stage outputs,
 * audit findings, dispatch results. The substrate captures everything
 * already; this surface assembles those atoms into a discriminated
 * timeline.
 *
 * Read-only by construction. The assembler is pure; the substrate
 * writes the atoms.
 *
 * Substrate purity: NO new atom types. The view is a projection over
 * what the planning pipeline + agent loops + actor inbox already
 * write today per `arch-atomstore-source-of-truth`. The wire shape
 * narrows + normalizes; it never widens the atom schema.
 *
 * Mirrors the wire-shape split used by `pipeline-deliberation-types.ts`
 * and `pipeline-lifecycle-types.ts`: the frontend service imports types
 * from here without dragging server code into the browser bundle.
 */

/**
 * Narrow atom shape the assembler consumes. Mirrors the
 * `PipelineDeliberationSourceAtom` pattern: elide fields the helper
 * does not touch (confidence, signals, scope, layer, expires_at,
 * supersedes) so test fixtures stay tight.
 */
export interface ConversationSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
}

/**
 * Severity buckets surfaced on audit-finding + cross-stage-reprompt
 * events. Mirrors `PipelineDeliberationSeverity` but adds 'info' for
 * benign / advisory entries the assembler may project.
 */
export type ConversationEventSeverity = 'critical' | 'major' | 'minor' | 'info';

/**
 * Outcome bucket for a dispatch-result event. Mirrors the
 * dispatch_summary-driven trueOutcome buckets the rest of the Console
 * uses; restated here so the wire shape is self-contained.
 *   - pr-opened       : code-author-invoked recorded a non-null pr_url
 *   - silent-skip     : dispatcher refused to draft (canon-cited refusal)
 *   - empty-diff      : drafter returned a no-op diff
 *   - no-op           : dispatcher resolved to no action
 *   - failed          : executor errored out before producing a result
 */
export type ConversationDispatchOutcome =
  | 'pr-opened'
  | 'silent-skip'
  | 'empty-diff'
  | 'no-op'
  | 'failed';

/**
 * Body-payload truncation envelope. The assembler caps inline bodies
 * at MAX_INLINE_CONTENT_CHARS so the wire response stays bounded; when
 * truncation fires, `content_truncated` is true and the renderer
 * surfaces a "Show more" affordance that opens the full atom in the
 * existing detail viewer (no separate blob-expansion endpoint in v1
 * per canon `arch-atomstore-source-of-truth`: the atoms ARE the
 * source of truth; the detail viewer already renders the full body).
 */
export interface ConversationContentBody {
  /** The truncated-or-full inline content, ready to render. */
  readonly content: string;
  /** True when the substrate inline content exceeded the cap. */
  readonly content_truncated: boolean;
}

/**
 * Base envelope shared across every event variant. The discriminated
 * union below adds the per-kind payload.
 */
interface ConversationEventBase {
  /** Atom id that minted this event. */
  readonly atom_id: string;
  /** ISO timestamp used for chronological sort. */
  readonly ts: string;
  /** Principal that wrote the source atom. */
  readonly principal_id: string;
  /**
   * Stage-name tag when the source atom carries
   * `metadata.stage_name`. Optional because operator-intent,
   * inter-agent-message, and generic observation atoms have no stage
   * binding.
   */
  readonly stage?: string;
}

/**
 * The operator's seed intent: the first row in every conversation.
 * Always emitted when the assembler resolves an
 * operator-intent atom for the pipeline or plan.
 */
export interface ConversationOperatorIntentEvent extends ConversationEventBase {
  readonly kind: 'operator-intent';
  readonly body: ConversationContentBody;
}

/**
 * Stage entered. One per stage-enter pipeline-stage-event atom.
 * Surfaces as a banner-shaped row in the UI to anchor the segments.
 */
export interface ConversationStageStartedEvent extends ConversationEventBase {
  readonly kind: 'stage-started';
  /** Stage name, e.g. 'brainstorm-stage'. Always present. */
  readonly stage: string;
}

/**
 * Inbound LLM prompt for one agent-turn. One per agent-turn atom
 * whose `metadata.agent_turn.llm_input.inline` is non-empty.
 */
export interface ConversationAgentPromptEvent extends ConversationEventBase {
  readonly kind: 'agent-prompt';
  readonly turn_index: number;
  /** Parent agent-session atom id from `metadata.agent_turn.session_atom_id`. */
  readonly session_atom_id: string;
  readonly body: ConversationContentBody;
}

/**
 * Outbound LLM response for one agent-turn. Paired with its
 * agent-prompt event by `session_atom_id` + `turn_index`.
 */
export interface ConversationAgentResponseEvent extends ConversationEventBase {
  readonly kind: 'agent-response';
  readonly turn_index: number;
  readonly session_atom_id: string;
  readonly body: ConversationContentBody;
  /** Latency in milliseconds from `metadata.agent_turn.latency_ms`; 0 when missing. */
  readonly latency_ms: number;
}

/**
 * One tool call emitted by the agent during a turn. Sourced from
 * `metadata.agent_turn.tool_calls[i]`. The args + result are JSON-
 * encoded strings (the substrate may store either a string or an
 * object; the assembler normalizes to a string so the wire shape is
 * uniform).
 */
export interface ConversationToolCallEvent extends ConversationEventBase {
  readonly kind: 'tool-call';
  readonly parent_turn_index: number;
  readonly session_atom_id: string;
  readonly tool_name: string;
  /** JSON-stringified args; '' when the substrate did not record any. */
  readonly args: string;
  /** True when the substrate args exceeded the inline cap; the args field is truncated. */
  readonly args_truncated: boolean;
  /** JSON-stringified or text result; '' when missing. */
  readonly result: string;
  readonly result_truncated: boolean;
}

/**
 * Inter-actor message (Inbox V1). One per actor-message atom whose
 * metadata.message carries content + recipient + urgency.
 */
export interface ConversationInterAgentMessageEvent extends ConversationEventBase {
  readonly kind: 'inter-agent-message';
  readonly recipient_principal_id: string;
  readonly body: ConversationContentBody;
  /** Urgency band when the substrate stamped one; otherwise null. */
  readonly urgency: string | null;
}

/**
 * Cross-stage re-prompt: an upstream stage gets called again with a
 * finding payload. One per pipeline-cross-stage-reprompt atom for the
 * pipeline. Surfaces as a divider-shaped row with FROM/TO arrow.
 */
export interface ConversationCrossStageRepromptEvent extends ConversationEventBase {
  readonly kind: 'cross-stage-reprompt';
  readonly from_stage: string;
  readonly to_stage: string;
  readonly attempt: number;
  readonly severity: ConversationEventSeverity;
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<string>;
  readonly cited_paths: ReadonlyArray<string>;
  readonly thread_parent: string | null;
}

/**
 * Stage output: brainstorm/spec/plan/review/dispatch-output atom. The
 * body is the stage's full content payload; the UI typically renders
 * a chip + AtomRef plus a short summary line, with the full prose one
 * click away in the existing atom-detail viewer.
 */
export interface ConversationStageOutputEvent extends ConversationEventBase {
  readonly kind: 'stage-output';
  readonly stage: string;
  /** Output atom type, e.g. 'brainstorm-output', 'spec-output'. */
  readonly output_type: string;
  /** First-line summary pulled from the atom content. */
  readonly summary: string;
}

/**
 * Audit finding (pipeline-audit-finding atom) emitted during a stage.
 * Severity, category, message, plus the cited-atom-ids the auditor
 * tied the finding to.
 */
export interface ConversationAuditFindingEvent extends ConversationEventBase {
  readonly kind: 'audit-finding';
  readonly severity: ConversationEventSeverity;
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<string>;
}

/**
 * Dispatch result: code-author-invoked observation marking what the
 * dispatched executor produced. result enum is the substrate-canonical
 * outcome bucket per dec-true-outcome-bucket.
 */
export interface ConversationDispatchResultEvent extends ConversationEventBase {
  readonly kind: 'dispatch-result';
  readonly result: ConversationDispatchOutcome;
  /** Full URL of the opened PR when result === 'pr-opened'; otherwise null. */
  readonly pr_url: string | null;
  /** First-line summary of the executor result for the conversation row. */
  readonly summary: string;
}

/**
 * Discriminated-union of every event variant the conversation thread
 * renders. The renderer switches on `kind`. Add a new kind by adding a
 * new variant + a new branch in the assembler; existing consumers stay
 * stable.
 */
export type ConversationEvent =
  | ConversationOperatorIntentEvent
  | ConversationStageStartedEvent
  | ConversationAgentPromptEvent
  | ConversationAgentResponseEvent
  | ConversationToolCallEvent
  | ConversationInterAgentMessageEvent
  | ConversationCrossStageRepromptEvent
  | ConversationStageOutputEvent
  | ConversationAuditFindingEvent
  | ConversationDispatchResultEvent;

/**
 * Discriminator type literal for ConversationEvent. Exported so
 * renderers can write exhaustive switches and TypeScript catches a
 * missing branch at compile time.
 */
export type ConversationEventKind = ConversationEvent['kind'];

/**
 * Result envelope for POST /api/pipelines.conversation. Carries the
 * resolved intent atom id (when found) so the renderer can chip-link
 * back to the seed without a second round-trip.
 */
export interface ConversationPipelineResult {
  readonly pipeline_id: string;
  /** Seed operator-intent atom id when the pipeline derived_from one; otherwise null. */
  readonly intent_id: string | null;
  readonly events: ReadonlyArray<ConversationEvent>;
  readonly computed_at: string;
}

/**
 * Result envelope for POST /api/deliberations.conversation. Includes
 * the linked pipeline_id when the plan derives_from a pipeline; the
 * renderer subscribes to that pipeline's SSE stream so the
 * conversation re-fetches when new atoms land.
 */
export interface ConversationDeliberationResult {
  readonly plan_id: string;
  /** Seed operator-intent atom id when the plan derived_from one; otherwise null. */
  readonly intent_id: string | null;
  /** Pipeline atom id the plan was minted by, when resolvable; otherwise null. */
  readonly pipeline_id: string | null;
  readonly events: ReadonlyArray<ConversationEvent>;
  readonly computed_at: string;
}

