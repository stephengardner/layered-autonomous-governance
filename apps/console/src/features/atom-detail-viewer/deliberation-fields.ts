/**
 * Pure narrowing for the deliberation surface.
 *
 * Plan and canon atoms carry a heuristic-thinking trail in standard
 * fields:
 *   - metadata.alternatives_rejected   ReadonlyArray<{option,reason} | string>
 *   - metadata.principles_applied      ReadonlyArray<string>
 *   - metadata.what_breaks_if_revisit  string  (alt spelling: ..._revisited)
 *   - provenance.derived_from          ReadonlyArray<string>  (citations)
 *
 * Both surfaces that render the deliberation block (the plan renderer
 * in the atom-detail viewer + the canon card's expanded panel) need
 * to read these fields with the same defensive shape. Per canon
 * `dev-extract-at-n-equals-two`, the reader lives here, the React
 * shell lives in `Deliberation.tsx`, and consumers thread the typed
 * result through a single component.
 *
 * Substrate purity: this module narrows what the substrate already
 * writes. It introduces no new atom field, no new endpoint, no new
 * canon directive. If the substrate later widens or renames a field,
 * the narrow lands here and every consumer inherits the change.
 */

import type { AnyAtom } from '@/services/atoms.service';
import { asAlternative } from '@/services/canon.service';

export interface DeliberationAlternative {
  readonly option: string;
  readonly reason?: string;
}

export interface DeliberationFields {
  readonly principlesApplied: ReadonlyArray<string>;
  readonly alternativesRejected: ReadonlyArray<DeliberationAlternative>;
  readonly whatBreaksIfRevisit: string | null;
  readonly derivedFrom: ReadonlyArray<string>;
}

/**
 * Narrow an atom into the deliberation field set.
 *
 * Defensive at every step: a malformed metadata bag can put any shape
 * in any field (null, an object instead of an array, a number where a
 * string is expected). Each accessor checks `Array.isArray` /
 * `typeof` before iterating so a single bad atom never throws inside
 * a renderer.
 *
 * Both spellings of `what_breaks_if_revisit` (with and without the
 * trailing `ed`) are tolerated because both have appeared in canon
 * over time. The shorter form wins when both are present so a
 * deliberate rename does not double-render.
 *
 * Duplicate ids in `principles_applied` or `provenance.derived_from`
 * are deduped while preserving first-occurrence order. A planner
 * sometimes lists the same id twice (entry plus tail-anchor); the
 * UI renders these with `key={id}` which would trip React's
 * unique-key invariant on a duplicate.
 */
export function extractDeliberation(atom: AnyAtom): DeliberationFields {
  const meta = (atom.metadata ?? {}) as Readonly<Record<string, unknown>>;
  return {
    principlesApplied: readPrinciples(meta['principles_applied']),
    alternativesRejected: readAlternatives(meta['alternatives_rejected']),
    whatBreaksIfRevisit: readWhatBreaks(meta),
    derivedFrom: readDerivedFrom(atom.provenance?.derived_from),
  };
}

/**
 * Single-glance check: should the deliberation section render at all?
 * The atom-detail and canon-card surfaces use this to decide whether
 * to emit any DOM at all -- a section header that always renders with
 * an empty body would teach the operator the wrong thing about coverage.
 */
export function hasAnyDeliberation(fields: DeliberationFields): boolean {
  return (
    fields.principlesApplied.length > 0
    || fields.alternativesRejected.length > 0
    || fields.whatBreaksIfRevisit !== null
    || fields.derivedFrom.length > 0
  );
}

function readPrinciples(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function readAlternatives(raw: unknown): ReadonlyArray<DeliberationAlternative> {
  if (!Array.isArray(raw)) return [];
  const out: DeliberationAlternative[] = [];
  for (const entry of raw) {
    const norm = asAlternative(entry);
    /*
     * `asAlternative` returns `{option:''}` for fully-malformed entries
     * (null, primitives, missing-option objects). Drop those so an
     * unnamed-option card does not render with no label.
     */
    if (!norm.option || norm.option.length === 0) continue;
    if (norm.reason && norm.reason.length > 0) {
      out.push({ option: norm.option, reason: norm.reason });
    } else {
      out.push({ option: norm.option });
    }
  }
  return out;
}

function readWhatBreaks(meta: Readonly<Record<string, unknown>>): string | null {
  /*
   * Two spellings appear in canon over time. The trim is mandatory so
   * a whitespace-only metadata.what_breaks_if_revisit (an authoring slip)
   * does not paint an empty quote callout; matches the trim discipline
   * in deliberation.service.ts.
   */
  const a = meta['what_breaks_if_revisit'];
  const b = meta['what_breaks_if_revisited'];
  const raw = typeof a === 'string' ? a : typeof b === 'string' ? b : null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDerivedFrom(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
