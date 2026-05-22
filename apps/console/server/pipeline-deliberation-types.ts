/**
 * Wire-shape definitions for the pipeline cross-stage deliberation
 * thread surface.
 *
 * The substrate runner emits one `pipeline-cross-stage-reprompt` atom
 * per cross-stage re-prompt event (e.g. dispatch-stage refuses to draft
 * a PR and the runner walks back to plan-stage with the finding). The
 * /api/pipeline.deliberation surface projects the chain of these atoms
 * for a given pipeline so the Console can render the deliberation
 * thread as a sequence of FROM_STAGE -> TO_STAGE handoffs.
 *
 * Read-only by construction; the substrate writes the atoms, this
 * projection reads them.
 *
 * Mirrors the wire-shape split used by `pipeline-lifecycle-types.ts`
 * and `pipelines-types.ts`: the frontend service imports types from
 * here without dragging server code into the bundle.
 */

/**
 * Narrow atom shape the projection consumes. Mirrors the in-server
 * Atom interface but elides fields the deliberation helpers do not
 * touch (confidence, signals, scope, layer, expires_at). Same pattern
 * `PipelineLifecycleSourceAtom` uses so a handler can downcast once
 * and pass the same array to multiple projection helpers without
 * widening the read contract.
 */
export interface PipelineDeliberationSourceAtom {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
}

/**
 * Severity bucket for the finding payload carried on each cross-stage
 * re-prompt atom. Mirrors `PipelineAuditSeverity` from the audit
 * findings surface; restated here so the deliberation wire shape is
 * self-contained.
 */
export type PipelineDeliberationSeverity = 'critical' | 'major' | 'minor';

/**
 * Finding payload preserved verbatim on each cross-stage re-prompt
 * atom's metadata.finding. Mirrors the substrate
 * `CrossStageRepromptFindingShape` interface in
 * `src/runtime/planning-pipeline/atom-shapes.ts`; restated here so the
 * console wire shape is self-contained and a future substrate-side
 * field-rename does not silently change the projection contract.
 */
export interface PipelineDeliberationFinding {
  readonly severity: PipelineDeliberationSeverity;
  readonly category: string;
  readonly message: string;
  readonly cited_atom_ids: ReadonlyArray<string>;
  readonly cited_paths: ReadonlyArray<string>;
  /** The upstream stage the runner is about to re-invoke. */
  readonly reprompt_target: string;
}

/**
 * One entry in the deliberation thread: a single cross-stage re-prompt
 * event. The runner emits one atom per re-prompt; this row pins the
 * fields the Console renders.
 */
export interface PipelineDeliberationEntry {
  readonly atom_id: string;
  readonly pipeline_id: string;
  readonly correlation_id: string;
  /** Auditing stage that emitted the finding. */
  readonly from_stage: string;
  /** Upstream stage the runner is about to re-invoke. */
  readonly to_stage: string;
  /**
   * 1-based attempt counter from the runner's unified attempt index.
   * Mirrors the cap semantics: max_attempts caps the number of WALKS
   * across the chain, not the number of stage attempts.
   */
  readonly attempt: number;
  /**
   * Atom id of the previous cross-stage re-prompt in this thread, or
   * null for the first re-prompt. The Console walks this pointer to
   * render the chain as a sequence.
   */
  readonly thread_parent: string | null;
  /**
   * Annotation per the citation-drift design: which upstream-run the
   * verified citations were resolved against. The substrate writes
   * 'pipeline-seed' for the first re-prompt and 'latest-upstream' for
   * subsequent re-prompts.
   */
  readonly verified_cited_atom_ids_origin: string;
  readonly finding: PipelineDeliberationFinding;
  readonly principal_id: string;
  readonly created_at: string;
}

/**
 * `/api/pipeline.deliberation` payload. Returns a flat list of
 * deliberation entries sorted by attempt ascending (chronological
 * order across the chain). Empty array when the pipeline has no
 * cross-stage re-prompt atoms; the client renders nothing rather than
 * an empty-state when the array is empty (the surface is dormant
 * unless the substrate has fired at least one cross-stage walk).
 */
export interface PipelineDeliberationResult {
  readonly pipeline_id: string;
  readonly entries: ReadonlyArray<PipelineDeliberationEntry>;
  readonly computed_at: string;
}
