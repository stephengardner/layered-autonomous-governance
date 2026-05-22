/**
 * Drift test for scripts/lib/cross-stage-reprompt-canon-policies.mjs.
 *
 * Pins the contract between the bootstrap script (which seeds the
 * pol-cross-stage-reprompt-default atom) and the runtime reader
 * (readCrossStageRePromptPolicy in
 * src/runtime/planning-pipeline/cross-stage-reprompt-config.ts). The
 * reader parses metadata.policy.{subject, max_attempts,
 * severities_to_reprompt, allowed_targets}; the seed builder MUST emit
 * exactly those fields under metadata.policy so a drift between seed
 * and reader is a CI failure, not a silent runtime surprise.
 *
 * Mirrors the discipline of the auditor-feedback / loop-pass-claim-reaper
 * canon bootstraps: the lib module is the single source of truth for
 * the atom shape and gets unit-test coverage; the bootstrap script
 * remains a thin CLI wrapper around it.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  DERIVE_FROM_PIPELINE_COMPOSITION,
  readCrossStageRePromptPolicy,
} from '../../src/runtime/planning-pipeline/cross-stage-reprompt-config.js';
import type { AtomId, PrincipalId, Time } from '../../src/types.js';

// Dynamic ESM import keeps the test independent of the bootstrap
// script tsconfig path resolution; the lib file is plain .mjs so the
// import has no transpile cost.
const policiesModule = await import(
  '../../scripts/lib/cross-stage-reprompt-canon-policies.mjs'
);
const { buildPolicies, policyAtom } = policiesModule as {
  buildPolicies: (operatorId: string) => ReadonlyArray<{
    readonly id: string;
    readonly subject: string;
    readonly reason: string;
    readonly fields: {
      readonly max_attempts: number;
      readonly severities_to_reprompt: ReadonlyArray<'critical' | 'major' | 'minor'>;
      readonly allowed_targets: string | ReadonlyArray<string>;
    };
  }>;
  policyAtom: (
    spec: ReturnType<typeof buildPolicies>[number],
    operatorId: string,
  ) => Record<string, unknown> & {
    readonly id: AtomId;
    readonly type: string;
    readonly layer: string;
    readonly metadata: { readonly policy: Record<string, unknown> };
  };
};

const OPERATOR_ID = 'operator-principal';

describe('cross-stage-reprompt-canon-policies', () => {
  it('buildPolicies emits a single pol-cross-stage-reprompt-default spec', () => {
    const policies = buildPolicies(OPERATOR_ID);
    expect(policies.length).toBe(1);
    expect(policies[0]?.id).toBe('pol-cross-stage-reprompt-default');
    expect(policies[0]?.subject).toBe('cross-stage-reprompt-default');
  });

  it('default fields match the runner HARDCODED_DEFAULT shape', () => {
    const policies = buildPolicies(OPERATOR_ID);
    const spec = policies[0]!;
    expect(spec.fields.max_attempts).toBe(2);
    expect(spec.fields.severities_to_reprompt).toEqual(['critical']);
    expect(spec.fields.allowed_targets).toBe(DERIVE_FROM_PIPELINE_COMPOSITION);
  });

  it('policyAtom produces an L3 directive with metadata.policy.subject and fields', () => {
    const policies = buildPolicies(OPERATOR_ID);
    const atom = policyAtom(policies[0]!, OPERATOR_ID);
    expect(atom.type).toBe('directive');
    expect(atom.layer).toBe('L3');
    expect(atom.metadata.policy.subject).toBe('cross-stage-reprompt-default');
    expect(atom.metadata.policy.max_attempts).toBe(2);
    expect(atom.metadata.policy.severities_to_reprompt).toEqual(['critical']);
    expect(atom.metadata.policy.allowed_targets).toBe(DERIVE_FROM_PIPELINE_COMPOSITION);
  });

  it('round-trips through the canon-policy reader (substrate contract)', async () => {
    // The load-bearing assertion: an atom written by the bootstrap
    // script round-trips through readCrossStageRePromptPolicy without
    // dropping to the null path. If the seed shape drifts from the
    // reader expectations the gate stays dormant after a fresh
    // bootstrap; this test catches that drift at CI time.
    const host = createMemoryHost();
    const policies = buildPolicies(OPERATOR_ID);
    const seed = policyAtom(policies[0]!, OPERATOR_ID);
    // The seed shape uses the operator id as principal_id; cast for the
    // host.atoms.put signature. The created_at/last_reinforced_at fields
    // are ISO strings from the lib module, typed as Time for the host.
    await host.atoms.put({
      ...(seed as Record<string, unknown>),
      principal_id: OPERATOR_ID as PrincipalId,
      created_at: seed.created_at as Time,
      last_reinforced_at: seed.last_reinforced_at as Time,
    } as Parameters<typeof host.atoms.put>[0]);
    const resolved = await readCrossStageRePromptPolicy(host);
    expect(resolved).not.toBeNull();
    expect(resolved?.max_attempts).toBe(2);
    expect(resolved?.severities_to_reprompt).toEqual(['critical']);
    expect(resolved?.allowed_targets).toBe(DERIVE_FROM_PIPELINE_COMPOSITION);
  });
});
