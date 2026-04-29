/**
 * PipelineRunner state machine.
 *
 * Walks a ReadonlyArray<PlanningStage> sequentially, projecting state
 * via atom writes (mirrors the intent-approve and plan-dispatch passes
 * in src/runtime/actor-message/). Pure mechanism: concrete stage logic
 * lives in stage adapters, NOT here.
 *
 * Threat-model posture (mirrors the existing actor-message passes):
 *
 * - Kill-switch absolute priority: scheduler.killswitchCheck() is
 *   polled BEFORE any write and BEFORE every stage transition. On
 *   STOP the runner returns `halted`; an in-flight stage's promise is
 *   awaited then ignored rather than left dangling.
 * - Claim-before-mutate: every transition re-reads the pipeline atom
 *   and aborts if the atom is missing or tainted, so two concurrent
 *   ticks cannot both advance the same pipeline.
 * - Per-stage budget cap: stage.budget_cap_usd, with a canon-policy
 *   fallback. A breach halts the stage with cause: 'budget-overflow'.
 * - Schema validation: stage.outputSchema?.safeParse(output.value)
 *   runs before the stage's output is treated as valid. A schema-fail
 *   halts the stage; the LLM-emitted payload outside the schema NEVER
 *   reaches a downstream stage.
 * - Auditor wiring: stage.audit?(value, ctx) runs after run(); each
 *   finding produces a pipeline-audit-finding atom. A 'critical'
 *   finding halts the stage. Default-deny: a stage with NO auditor
 *   cannot auto-advance past an `on-critical-finding` HIL gate; that
 *   forces the runner into hil-paused.
 * - HIL pause flow: when the resolved policy says 'always' or
 *   'on-critical-finding', the runner transitions the pipeline atom
 *   to 'hil-paused' and writes a pipeline-stage-event with
 *   transition: 'hil-pause'. Resume happens via a pipeline-resume
 *   atom signed by an allowed_resumers principal (validated by the
 *   resume entrypoint, not the runner).
 * - Bounded loop: MAX_STAGES bounds runaway stage lists with cycles
 *   in dependsOn (forward-compat seam).
 */

import type { Host } from '../../substrate/interface.js';
import type { AtomId, PrincipalId, Time } from '../../substrate/types.js';
import type {
  AuditFinding,
  PlanningStage,
  StageInput,
  StageOutput,
} from './types.js';
import {
  mkPipelineAtom,
  mkPipelineAuditFindingAtom,
  mkPipelineFailedAtom,
  mkPipelineStageEventAtom,
} from './atom-shapes.js';
import {
  readPipelineStageCostCapPolicy,
  readPipelineStageHilPolicy,
} from './policy.js';

/**
 * Bound on the number of stages a single pipeline run may walk.
 * Mechanism constant: a malformed stages list with a cycle in the
 * forward-compat dependsOn seam cannot infinite-loop here.
 */
const MAX_STAGES = 64;

export type PipelineResult =
  | { readonly kind: 'completed'; readonly pipelineId: AtomId }
  | {
      readonly kind: 'failed';
      readonly pipelineId: AtomId;
      readonly failedStageName: string;
      readonly cause: string;
    }
  | {
      readonly kind: 'hil-paused';
      readonly pipelineId: AtomId;
      readonly stageName: string;
    }
  | { readonly kind: 'halted'; readonly pipelineId?: AtomId };

export interface RunPipelineOptions {
  readonly principal: PrincipalId;
  readonly correlationId: string;
  readonly seedAtomIds: ReadonlyArray<AtomId>;
  readonly stagePolicyAtomId: string;
  readonly mode: 'single-pass' | 'substrate-deep';
  readonly now?: () => Time;
  readonly resumeFromStage?: string;
  /**
   * Optional priorOutput hydration for the resumeFromStage path. When
   * resuming mid-pipeline, the caller supplies the prior stage's
   * StageOutput.value so the named stage's StageInput.priorOutput is
   * not silently `null`. Stage output persistence as typed atoms is a
   * forward follow-up (see plan "Out of scope"); until that lands, the
   * resume entrypoint passes priorOutput explicitly.
   */
  readonly priorOutput?: unknown;
}

export async function runPipeline(
  stages: ReadonlyArray<PlanningStage>,
  host: Host,
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  if (stages.length > MAX_STAGES) {
    throw new Error(
      `runPipeline: stage count ${stages.length} exceeds MAX_STAGES ${MAX_STAGES}`,
    );
  }

  // Kill-switch absolute priority: poll BEFORE any reads or writes.
  if (host.scheduler.killswitchCheck()) {
    return { kind: 'halted' };
  }

  const now = options.now ?? (() => new Date().toISOString() as Time);

  const pipelineId = `pipeline-${options.correlationId}` as AtomId;
  const pipelineAtom = mkPipelineAtom({
    pipelineId,
    principalId: options.principal,
    correlationId: options.correlationId,
    now: now(),
    seedAtomIds: options.seedAtomIds,
    stagePolicyAtomId: options.stagePolicyAtomId,
    mode: options.mode,
  });
  await host.atoms.put(pipelineAtom);

  const startIdx =
    options.resumeFromStage === undefined
      ? 0
      : stages.findIndex((s) => s.name === options.resumeFromStage);
  if (startIdx < 0) {
    return await failPipeline(
      host,
      pipelineId,
      options,
      now,
      'unknown-stage',
      'resume-from-stage not found in stages list',
      0,
    );
  }

  // Resume path may hydrate priorOutput from caller; the runner does not
  // re-query a prior stage's exit-success event because stage output
  // persistence as typed atoms is a forward follow-up. Without caller
  // hydration the resumed stage observes priorOutput=null, which is the
  // documented fallback.
  let priorOutput: unknown =
    options.resumeFromStage !== undefined && options.priorOutput !== undefined
      ? options.priorOutput
      : null;
  let totalCostUsd = 0;

  for (let i = startIdx; i < stages.length; i++) {
    const stage = stages[i]!;

    // Kill-switch poll before each stage transition. STOP is an operator
    // halt, NOT a stage failure: per the file-header contract
    // ("polled BEFORE any write"), the runner returns halted without
    // emitting an exit-failure event. Misclassifying a STOP as a
    // failure would pollute the audit chain and trigger downstream
    // failure-recovery flows that should not fire on a clean halt.
    if (host.scheduler.killswitchCheck()) {
      return { kind: 'halted', pipelineId };
    }

    // Claim-before-mutate: re-read pipeline atom to prevent double-advance
    // under concurrent ticks. Halt if the atom is missing, tainted, or
    // already in a terminal state (completed, failed) which would mean
    // another tick raced ahead.
    const fresh = await host.atoms.get(pipelineId);
    if (fresh === null) return { kind: 'halted', pipelineId };
    if (fresh.taint !== 'clean') return { kind: 'halted', pipelineId };
    const currentState = fresh.pipeline_state;
    if (
      currentState !== undefined
      && currentState !== 'pending'
      && currentState !== 'running'
      && currentState !== 'hil-paused'
    ) {
      return { kind: 'halted', pipelineId };
    }
    // Stage-level claim: a peer tick that already advanced past index
    // i is ahead of us; halt rather than re-execute. The peer marks
    // its progress via current_stage_index on the pipeline atom. The
    // AtomStore lacks true compare-and-swap so the claim is
    // best-effort: file/memory adapters serialise calls in practice
    // and avoid the race; a multi-process adapter must add a native
    // conditional update.
    const freshMeta = (fresh.metadata as Record<string, unknown>) ?? {};
    const peerIndex = freshMeta.current_stage_index;
    if (typeof peerIndex === 'number' && peerIndex > i) {
      return { kind: 'halted', pipelineId };
    }

    await host.atoms.update(pipelineId, {
      pipeline_state: 'running',
      metadata: { current_stage: stage.name, current_stage_index: i },
    });
    // Re-read after write to confirm we still hold the claim. If a
    // concurrent tick clobbered current_stage_index above our value
    // between our update and this read, halt rather than proceed.
    const claimed = await host.atoms.get(pipelineId);
    const claimedMeta = (claimed?.metadata as Record<string, unknown>) ?? {};
    const claimedIndex = claimedMeta.current_stage_index;
    if (typeof claimedIndex !== 'number' || claimedIndex !== i) {
      return { kind: 'halted', pipelineId };
    }
    await host.atoms.put(
      mkPipelineStageEventAtom({
        pipelineId,
        stageName: stage.name,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition: 'enter',
        durationMs: 0,
        costUsd: 0,
      }),
    );

    const t0 = Date.now();
    let output: StageOutput<unknown>;
    try {
      const stageInput: StageInput<unknown> = {
        host,
        principal: options.principal,
        correlationId: options.correlationId,
        priorOutput,
        pipelineId,
        seedAtomIds: options.seedAtomIds,
      };
      output = await stage.run(stageInput);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      // Even when the stage threw, re-check the kill switch before
      // post-run writes: if STOP flipped while the promise was in
      // flight, we honour the absolute-priority guarantee from the
      // file header and halt without writing the failure event /
      // pipeline-failed atom.
      if (host.scheduler.killswitchCheck()) {
        return { kind: 'halted', pipelineId };
      }
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs: Date.now() - t0,
          costUsd: 0,
        }),
      );
      return await failPipeline(host, pipelineId, options, now, stage.name, cause, i);
    }
    // Re-check the kill switch on the success path before any post-run
    // writes. Without this, a STOP that flipped while stage.run was
    // in flight still produces schema-failure atoms, audit findings,
    // exit-success events, and pipeline_state='completed' downstream;
    // that would break the absolute-priority guarantee.
    if (host.scheduler.killswitchCheck()) {
      return { kind: 'halted', pipelineId };
    }
    const durationMs = Date.now() - t0;

    // Schema validation. Run before persistence so an LLM-emitted
    // payload outside the schema NEVER becomes the priorOutput of a
    // downstream stage.
    if (stage.outputSchema !== undefined) {
      const parsed = stage.outputSchema.safeParse(output.value);
      if (!parsed.success) {
        await host.atoms.put(
          mkPipelineStageEventAtom({
            pipelineId,
            stageName: stage.name,
            principalId: options.principal,
            correlationId: options.correlationId,
            now: now(),
            transition: 'exit-failure',
            durationMs,
            costUsd: output.cost_usd,
          }),
        );
        return await failPipeline(
          host,
          pipelineId,
          options,
          now,
          stage.name,
          `schema-validation-failed: ${parsed.error.message}`,
          i,
        );
      }
    }

    // Per-stage budget enforcement. Stage-supplied cap takes precedence;
    // canon policy is the fallback. A null cap means "no limit at this
    // layer" -- the per-pipeline total is a forward-compat fence.
    const stageCap =
      stage.budget_cap_usd
      ?? (await readPipelineStageCostCapPolicy(host, stage.name)).cap_usd;
    if (
      stageCap !== null
      && stageCap !== undefined
      && output.cost_usd > stageCap
    ) {
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs,
          costUsd: output.cost_usd,
        }),
      );
      return await failPipeline(
        host,
        pipelineId,
        options,
        now,
        stage.name,
        `budget-overflow: cost ${output.cost_usd} > cap ${stageCap}`,
        i,
      );
    }
    totalCostUsd += output.cost_usd;

    // Auditor wiring. Each finding produces a pipeline-audit-finding
    // atom; a 'critical' finding halts the stage.
    let findings: ReadonlyArray<AuditFinding> = [];
    if (stage.audit !== undefined) {
      findings = await stage.audit(output.value, {
        host,
        principal: options.principal,
        correlationId: options.correlationId,
        pipelineId,
        stageName: stage.name,
      });
      for (const finding of findings) {
        await host.atoms.put(
          mkPipelineAuditFindingAtom({
            pipelineId,
            stageName: stage.name,
            principalId: options.principal,
            correlationId: options.correlationId,
            now: now(),
            severity: finding.severity,
            category: finding.category,
            message: finding.message,
            citedAtomIds: finding.cited_atom_ids,
            citedPaths: finding.cited_paths,
          }),
        );
      }
    }

    const hasCritical = findings.some((f) => f.severity === 'critical');
    if (hasCritical) {
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'exit-failure',
          durationMs,
          costUsd: output.cost_usd,
        }),
      );
      return await failPipeline(
        host,
        pipelineId,
        options,
        now,
        stage.name,
        'critical-audit-finding',
        i,
      );
    }

    // HIL gate. Default-deny: a stage with NO auditor cannot pass an
    // 'on-critical-finding' gate, since the runner cannot prove the
    // absence of critical findings without an auditor signal.
    const hil = await readPipelineStageHilPolicy(host, stage.name);
    const auditorAbsent = stage.audit === undefined;
    const shouldPause =
      hil.pause_mode === 'always'
      || (hil.pause_mode === 'on-critical-finding'
        && (hasCritical || auditorAbsent));
    if (shouldPause) {
      await host.atoms.update(pipelineId, { pipeline_state: 'hil-paused' });
      await host.atoms.put(
        mkPipelineStageEventAtom({
          pipelineId,
          stageName: stage.name,
          principalId: options.principal,
          correlationId: options.correlationId,
          now: now(),
          transition: 'hil-pause',
          durationMs,
          costUsd: output.cost_usd,
        }),
      );
      return { kind: 'hil-paused', pipelineId, stageName: stage.name };
    }

    await host.atoms.put(
      mkPipelineStageEventAtom({
        pipelineId,
        stageName: stage.name,
        principalId: options.principal,
        correlationId: options.correlationId,
        now: now(),
        transition: 'exit-success',
        durationMs,
        costUsd: output.cost_usd,
        ...(output.atom_id !== undefined ? { outputAtomId: output.atom_id } : {}),
      }),
    );

    priorOutput = output.value;
  }

  await host.atoms.update(pipelineId, {
    pipeline_state: 'completed',
    metadata: { completed_at: now(), total_cost_usd: totalCostUsd },
  });
  return { kind: 'completed', pipelineId };
}

async function failPipeline(
  host: Host,
  pipelineId: AtomId,
  options: RunPipelineOptions,
  now: () => Time,
  stageName: string,
  cause: string,
  failedIndex: number,
): Promise<PipelineResult> {
  // Build the provenance chain by paginating ALL pipeline-stage-event
  // atoms and filtering on metadata.pipeline_id. A single first-page
  // query is unsafe under load: a busy store with many peer pipelines
  // could push this pipeline's events past the first page, leaving
  // the failed-atom chain partial and non-deterministic. Pagination
  // walks until nextCursor=null OR a hard MAX is reached.
  const PAGE_SIZE = 200;
  const MAX_CHAIN_PAGES = 64;
  const chain: AtomId[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAX_CHAIN_PAGES; page++) {
    const result = await host.atoms.query(
      { type: ['pipeline-stage-event'] },
      PAGE_SIZE,
      cursor,
    );
    for (const atom of result.atoms) {
      const meta = atom.metadata as Record<string, unknown> | undefined;
      if (meta?.pipeline_id === pipelineId) {
        chain.push(atom.id);
      }
    }
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  await host.atoms.put(
    mkPipelineFailedAtom({
      pipelineId,
      principalId: options.principal,
      correlationId: options.correlationId,
      now: now(),
      failedStageName: stageName,
      failedStageIndex: failedIndex,
      cause,
      chain,
      recoveryHint: `re-run from stage '${stageName}' after addressing the failure cause`,
    }),
  );
  await host.atoms.update(pipelineId, { pipeline_state: 'failed' });
  return {
    kind: 'failed',
    pipelineId,
    failedStageName: stageName,
    cause,
  };
}
