/**
 * Canon service: reads L3 atoms (directives, decisions, preferences,
 * references) from the backend. Backend reads actual `.lag/atoms/`
 * JSON files.
 *
 * Components call `useQuery` hooks that call this service; they do
 * NOT call transport directly, and they do NOT fetch directly.
 */

import { transport } from './transport';

export type AtomLayer = 'L0' | 'L1' | 'L2' | 'L3';
export type AtomType =
  | 'directive'
  | 'decision'
  | 'preference'
  | 'reference'
  | 'observation'
  | 'actor-message'
  | 'plan'
  | 'question'
  | (string & {});

/*
 * Alternatives_rejected in real canon atoms shows up in two shapes:
 *   - ReadonlyArray<string>           — seed atoms, /decide short-form
 *   - ReadonlyArray<{option,reason}>  — newer structured entries
 * The frontend accepts both; renderers normalize via `asAlternative()`.
 */
export type Alternative = string | { readonly option: string; readonly reason: string };

export interface CanonAtom {
  readonly id: string;
  readonly type: AtomType;
  readonly layer: AtomLayer;
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly scope?: string;
  readonly taint?: string;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly supersedes?: ReadonlyArray<string>;
  readonly expires_at?: string | null;
  readonly last_reinforced_at?: string;
  readonly metadata?: {
    readonly alternatives_rejected?: ReadonlyArray<Alternative>;
    readonly what_breaks_if_revisited?: string;
    readonly source_plan?: string;
    readonly [k: string]: unknown;
  };
  readonly provenance?: {
    readonly kind?: string;
    readonly source?: unknown;
    readonly derived_from?: ReadonlyArray<string>;
  };
}

export function asAlternative(raw: Alternative): { option: string; reason?: string } {
  if (typeof raw === 'string') return { option: raw };
  return { option: raw.option, reason: raw.reason };
}

export interface ListCanonParams {
  readonly types?: ReadonlyArray<AtomType>;
  readonly search?: string;
}

export interface CanonStats {
  readonly total: number;
  readonly byType: Readonly<Record<string, number>>;
}

export async function listCanonAtoms(
  params?: ListCanonParams,
  signal?: AbortSignal,
): Promise<ReadonlyArray<CanonAtom>> {
  const call = transport.call<ReadonlyArray<CanonAtom>>(
    'canon.list',
    params as Record<string, unknown> | undefined,
    signal ? { signal } : undefined,
  );
  return call;
}

export async function getCanonStats(signal?: AbortSignal): Promise<CanonStats> {
  const call = transport.call<CanonStats>(
    'canon.stats',
    undefined,
    signal ? { signal } : undefined,
  );
  return call;
}
