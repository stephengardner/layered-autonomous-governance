import type { Atom } from '../../substrate/types.js';
import type { Host } from '../../substrate/interface.js';

export const RADIUS_RANK = {
  none: 0,
  docs: 1,
  tooling: 2,
  framework: 3,
  'l3-canon-proposal': 4,
} as const;

export type BlastRadius = keyof typeof RADIUS_RANK;

export function isBlastRadiusWithin(planRadius: BlastRadius, envelopeMax: BlastRadius): boolean {
  return RADIUS_RANK[planRadius] <= RADIUS_RANK[envelopeMax];
}

export async function findIntentInProvenance(host: Host, plan: Atom): Promise<string | null> {
  const derived = plan.provenance?.derived_from ?? [];
  for (const id of derived) {
    const atom = await host.atoms.get(id);
    if (atom?.type === 'operator-intent') return id;
  }
  return null;
}
