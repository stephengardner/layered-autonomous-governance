/**
 * Stage Context service: fetches the soul + upstream-chain + canon-at-
 * runtime projection for a single pipeline-stage atom. Backs the
 * Stage Context panel in the plan-detail and deliberation-trail views.
 *
 * Per canon arch-canonical-http-api-surface, the UI never reads
 * .lag/atoms/ directly; every projection ships through the API surface.
 * The endpoint lives at POST /api/atoms.stage-context.
 */

import { transport } from './transport';

export interface StageContextChainEntry {
  readonly id: string;
  readonly type: string;
  readonly content_preview: string;
}

export interface StageContextCanonEntry {
  readonly id: string;
  readonly type: string;
  readonly content_preview: string;
  /** 'metadata' (recorded at run-time) or 'policy' (resolved as fallback). */
  readonly source: 'metadata' | 'policy';
}

export interface StageContext {
  /** Canonical stage name; null when the atom is not a pipeline-stage output. */
  readonly stage: string | null;
  /** The agent principal id that ran the stage; null when stage is null. */
  readonly principal_id: string | null;
  /** The vendored skill-bundle name; null when stage is null. */
  readonly skill_bundle: string | null;
  /** Full markdown of the soul prompt; null when stage is null or the bundle is absent. */
  readonly soul: string | null;
  /** Earliest -> latest provenance ancestors of the atom (deduped). */
  readonly upstream_chain: ReadonlyArray<StageContextChainEntry>;
  /** Canon directives that governed this stage at run-time. */
  readonly canon_at_runtime: ReadonlyArray<StageContextCanonEntry>;
}

/**
 * Fetch the stage context for an atom. Returns `null` when the atom
 * is unknown to the substrate (404 atom-not-found); other transport
 * failures rethrow so React Query surfaces them as errors.
 *
 * NOTE: an atom that exists but is not a pipeline-stage output returns
 * a 200 with a fully-populated empty shape (stage:null,
 * upstream_chain:[], canon_at_runtime:[]) -- the panel renders an
 * empty-state in that case rather than treating it as a hard failure.
 */
export async function getStageContext(
  atomId: string,
  signal?: AbortSignal,
): Promise<StageContext | null> {
  try {
    return await transport.call<StageContext>(
      'atoms.stage-context',
      { atom_id: atomId },
      signal ? { signal } : undefined,
    );
  } catch (err) {
    const e = err as Error;
    if (e.name === 'atom-not-found' || e.message.startsWith('atom-not-found')) {
      return null;
    }
    throw err;
  }
}
