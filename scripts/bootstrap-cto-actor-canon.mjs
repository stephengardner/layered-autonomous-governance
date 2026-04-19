#!/usr/bin/env node
/**
 * Canon bootstrap for the cto-actor role (Phase 55b).
 *
 * Creates:
 *   1. cto-actor Principal, signed_by claude-agent (depth 2 from the
 *      operator root). Role = 'agent'. Narrow scope: project-only;
 *      read L0..L3, write L0..L1 (cannot promote to L3 directly).
 *
 *   2. L3 policy atoms scoping the cto-actor's tool-use authority
 *      per checkToolPolicy's canon convention:
 *        - plan-propose           -> allow   (its primary job)
 *        - plan-research          -> allow   (read-only judgment)
 *        - plan-escalate          -> allow   (surface HIL via notifier)
 *        - plan-approve           -> deny    (approval is the operator's)
 *        - plan-execute-direct    -> escalate (55c wires sub-actor
 *                                              delegation; direct
 *                                              execution without an
 *                                              approved plan is a bug)
 *        - ^canon-write-l3.*      -> deny    (L3 promotion requires
 *                                              human gate by inv-l3-requires-human)
 *        - ^pr-merge-.*           -> deny    (echo pr-landing-agent's
 *                                              no-auto-merge until the
 *                                              medium-tier kill switch ships)
 *        - *                      -> deny    (default-deny scoped to
 *                                              this principal; new tool
 *                                              classes require explicit
 *                                              allow atoms)
 *
 * This bootstrap IS the PlanningActor's "soul" as canon: identity
 * via Principal, authority via L3 policy atoms. The framework
 * primitive (src/actors/planning/) ships vendor-neutral; this file
 * ships the specific cto-actor role under which we deploy it.
 *
 * Idempotent per atom id; re-running skips existing.
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-19T00:00:00.000Z';

const CTO_ACTOR = 'cto-actor';

const POLICIES = [
  {
    id: 'pol-cto-plan-propose',
    tool: 'plan-propose',
    action: 'allow',
    priority: 10,
    reason: 'cto-actor may propose plans (its primary job). validatePlan gates actual execution.',
  },
  {
    id: 'pol-cto-plan-research',
    tool: 'plan-research',
    action: 'allow',
    priority: 10,
    reason: 'cto-actor may do read-only research across atoms, canon, and external docs.',
  },
  {
    id: 'pol-cto-plan-escalate',
    tool: 'plan-escalate',
    action: 'allow',
    priority: 10,
    reason: 'cto-actor may surface plans to the operator via Notifier for HIL approval.',
  },
  {
    id: 'pol-cto-plan-approve-denied',
    tool: 'plan-approve',
    action: 'deny',
    priority: 20,
    reason: 'Plan approval is held with the operator. cto-actor surfaces; operator approves.',
  },
  {
    id: 'pol-cto-plan-execute-direct-escalated',
    tool: 'plan-execute-direct',
    action: 'escalate',
    priority: 20,
    reason: 'Direct plan execution without an approved plan atom is a bug. Phase 55c wires sub-actor delegation properly; until then, escalate.',
  },
  {
    id: 'pol-cto-no-l3-writes',
    tool: '^canon-write-l3.*',
    action: 'deny',
    priority: 30,
    reason: 'L3 promotion requires the human gate per inv-l3-requires-human. cto-actor cannot bypass.',
  },
  {
    id: 'pol-cto-no-merge',
    tool: '^pr-merge-.*',
    action: 'deny',
    priority: 30,
    reason: 'Echoes pr-landing-agent policy: no auto-merge until the medium-tier kill switch ships (D13).',
  },
  {
    id: 'pol-cto-default-deny',
    tool: '*',
    action: 'deny',
    priority: 0,
    reason: 'Default-deny catch-all scoped to cto-actor. Add an explicit allow above to enable a new tool class.',
  },
];

function policyAtom(spec) {
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.reason,
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-cto-actor', agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: BOOTSTRAP_TIME,
    last_reinforced_at: BOOTSTRAP_TIME,
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
    principal_id: process.env.LAG_OPERATOR_ID || 'stephen-human',
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'tool-use',
        tool: spec.tool,
        origin: '*',
        principal: CTO_ACTOR,
        action: spec.action,
        reason: spec.reason,
        priority: spec.priority,
      },
    },
  };
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });

  const operatorId = process.env.LAG_OPERATOR_ID || 'stephen-human';
  const claudeAgentId = process.env.LAG_AGENT_ID || 'claude-agent';

  // Parent chain: operator -> claude-agent -> cto-actor.
  for (const [pid, name, role, signedBy, writeLayers] of [
    [operatorId, 'Operator (human)', 'user', null, ['L0', 'L1', 'L2', 'L3']],
    [claudeAgentId, 'Agent (Claude Code instance)', 'agent', operatorId, ['L0', 'L1', 'L2']],
    [CTO_ACTOR, 'CTO actor (planning)', 'agent', claudeAgentId, ['L0', 'L1']],
  ]) {
    const existing = await host.principals.get(pid);
    if (existing) continue;
    await host.principals.put({
      id: pid,
      name,
      role,
      permitted_scopes: {
        read: ['session', 'project', 'user', 'global'],
        write: pid === operatorId
          ? ['session', 'project', 'user', 'global']
          : pid === CTO_ACTOR
            ? ['session', 'project']
            : ['session', 'project', 'user'],
      },
      permitted_layers: {
        read: ['L0', 'L1', 'L2', 'L3'],
        write: writeLayers,
      },
      goals: pid === CTO_ACTOR
        ? ['Draft plans grounded in canon + prior decisions. Escalate for operator approval. Never self-approve.']
        : [],
      constraints: pid === CTO_ACTOR
        ? ['No L2/L3 writes. No merges. No approvals. Plan execution via sub-actor delegation (Phase 55c), not direct.']
        : [],
      active: true,
      compromised_at: null,
      signed_by: signedBy,
      created_at: BOOTSTRAP_TIME,
    });
  }

  let written = 0;
  let skipped = 0;
  for (const spec of POLICIES) {
    const existing = await host.atoms.get(spec.id);
    if (existing) {
      skipped++;
      continue;
    }
    await host.atoms.put(policyAtom(spec));
    written++;
  }

  console.log(`[bootstrap-cto-actor] Principal chain: ${operatorId} -> ${claudeAgentId} -> ${CTO_ACTOR}`);
  console.log(`[bootstrap-cto-actor] Wrote ${written} new L3 policy atoms (${skipped} already existed, skipped).`);
  console.log('[bootstrap-cto-actor] Done.');
}

main().catch((err) => {
  console.error('[bootstrap-cto-actor] FAILED:', err);
  process.exit(1);
});
