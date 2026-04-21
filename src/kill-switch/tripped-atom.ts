/**
 * Atom builder for the kill-switch-tripped observation.
 *
 * Written by the actor runner when a kill-switch trip halts the
 * loop. L1 observation, discriminated by metadata.kind so the
 * AtomType surface does not grow for every new observation
 * subtype. Distinct per trip: each trip is a fresh observation,
 * the id encodes a timestamp, multiple trips on the same
 * (actor, principal) tuple land as separate atoms.
 *
 * The actor loop is the caller, not a generic consumer - the
 * atom carries the exact runtime state at trip time (iteration,
 * phase, in-flight tool) so an auditor can reconstruct what was
 * interrupted without joining against the audit log.
 */

import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../types.js';

export type KillSwitchTripPhase =
  | 'observe'
  | 'classify'
  | 'propose'
  | 'apply'
  | 'between-iterations';

export type KillSwitchTripTrigger =
  | 'stop-sentinel'
  | 'parent-signal'
  | 'deadline';

export interface MkKillSwitchTrippedAtomInputs {
  readonly actor: string;
  readonly principalId: PrincipalId;
  readonly trigger: KillSwitchTripTrigger;
  readonly trippedAt: Time;
  readonly iteration: number;
  readonly phase: KillSwitchTripPhase;
  readonly sessionId: string;
  readonly inFlightTool?: string;
  readonly revocationNotes?: string;
}

/**
 * Deterministic id that distinguishes every trip. Includes the
 * ISO timestamp verbatim so no two trips on the same (actor,
 * principal) collide - a repeated trip creates a new atom, not
 * an accidental duplicate-key conflict.
 */
export function mkKillSwitchTrippedAtomId(
  actor: string,
  principalId: PrincipalId,
  trippedAt: Time,
): AtomId {
  return `kill-switch-tripped-${actor}-${String(principalId)}-${trippedAt}` as AtomId;
}

export function mkKillSwitchTrippedAtom(
  inputs: MkKillSwitchTrippedAtomInputs,
): Atom {
  const {
    actor,
    principalId,
    trigger,
    trippedAt,
    iteration,
    phase,
    sessionId,
    inFlightTool,
    revocationNotes,
  } = inputs;

  const metadata: Record<string, unknown> = {
    kind: 'kill-switch-tripped',
    actor,
    principal_id: String(principalId),
    tripped_by: trigger,
    tripped_at: trippedAt,
    iteration,
    phase,
  };
  if (inFlightTool !== undefined) metadata['in_flight_tool'] = inFlightTool;
  if (revocationNotes !== undefined) metadata['revocation_notes'] = revocationNotes;

  return {
    schema_version: 1,
    id: mkKillSwitchTrippedAtomId(actor, principalId, trippedAt),
    content: renderKillSwitchTrippedContent(inputs),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(principalId),
        tool: 'kill-switch-revocation',
        session_id: sessionId,
      },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: trippedAt,
    last_reinforced_at: trippedAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: principalId,
    taint: 'clean',
    metadata,
  };
}

function renderKillSwitchTrippedContent(
  inputs: MkKillSwitchTrippedAtomInputs,
): string {
  const lines: string[] = [];
  lines.push(`kill-switch tripped for ${inputs.actor} (principal ${String(inputs.principalId)})`);
  lines.push(`trigger: ${inputs.trigger}`);
  lines.push(`tripped_at: ${inputs.trippedAt}`);
  lines.push(`iteration: ${inputs.iteration}`);
  lines.push(`phase: ${inputs.phase}`);
  if (inputs.inFlightTool !== undefined) {
    lines.push(`in_flight_tool: ${inputs.inFlightTool}`);
  }
  if (inputs.revocationNotes !== undefined) {
    lines.push('');
    lines.push(inputs.revocationNotes);
  }
  return lines.join('\n');
}
