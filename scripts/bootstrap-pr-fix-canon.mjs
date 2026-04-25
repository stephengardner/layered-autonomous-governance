#!/usr/bin/env node
/**
 * Canon bootstrap for the pr-fix autonomous role.
 *
 * Run from repo root (after `npm run build`):
 *   node scripts/bootstrap-pr-fix-canon.mjs
 *
 * Creates:
 *   1. A `pr-fix-actor` Principal, signed_by `claude-agent` (depth 2
 *      from the operator root). Role = 'agent'. Permitted layers
 *      read across L0..L3; write L0..L1 only (cannot promote to L3).
 *   2. L3 policy atoms that scope what the pr-fix-actor may do,
 *      matched by checkToolPolicy inside runActor:
 *        - agent-loop-dispatch     -> allow   (primary job: fixes)
 *        - pr-escalate             -> allow   (ci-failure / architectural)
 *        - pr-thread-resolve       -> allow   (after touched-paths fix)
 *        - ^pr-merge-.*            -> deny    (no auto-merge)
 *        - ^canon-write-l3.*       -> deny    (L3 promotion stays human-gated)
 *        - *                       -> deny    (default-deny catch-all
 *                                              scoped to this principal)
 *
 * The Layer-A canon table here gates the actor's OWN proposed actions
 * via runActor's checkToolPolicy. Layer-B (sub-agent disallowedTools)
 * is enforced by the AgentLoopAdapter wired in the driver script
 * and is NOT seeded as canon -- the floor is hard-coded in the actor
 * so a missing canon entry cannot accidentally widen sub-agent reach.
 *
 * Idempotent per atom id: re-running skips atoms whose id already
 * exists. To refresh a policy shape, change its id here or use the
 * atom-update path explicitly (not exercised here).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-25T00:00:00.000Z';

const PR_FIX_AGENT = 'pr-fix-actor';

/**
 * Policy atom shape matches checkToolPolicy's parsePolicy contract:
 *   metadata.policy = { subject, tool, origin, principal, action, reason, priority }
 *
 * Priority breaks specificity ties. Catch-all default-deny stays at
 * priority 0 so the specific allows + the explicit denies dominate.
 */
const POLICIES = [
  {
    id: 'pol-pr-fix-agent-loop-dispatch',
    tool: 'agent-loop-dispatch',
    action: 'allow',
    priority: 10,
    reason: 'pr-fix-actor may dispatch a sub-agent loop to address review findings on the PR HEAD branch.',
  },
  {
    id: 'pol-pr-fix-pr-escalate',
    tool: 'pr-escalate',
    action: 'allow',
    priority: 10,
    reason: 'pr-fix-actor may surface CI failures and architectural findings to the operator via the existing actor-message channel.',
  },
  {
    id: 'pol-pr-fix-pr-thread-resolve',
    tool: 'pr-thread-resolve',
    action: 'allow',
    priority: 10,
    reason: 'pr-fix-actor resolves CR threads inside apply for findings whose touched-paths actually changed in the dispatched fix.',
  },
  {
    id: 'pol-pr-fix-merge-denied',
    tool: '^pr-merge-.*',
    action: 'deny',
    priority: 20,
    reason: 'No auto-merge. Merging stays operator-held.',
  },
  {
    id: 'pol-pr-fix-canon-l3-denied',
    tool: '^canon-write-l3.*',
    action: 'deny',
    priority: 20,
    reason: 'L3 canon promotion requires the human gate; raise the dial via specific allow atoms instead of widening this denial.',
  },
  {
    id: 'pol-pr-fix-default-deny',
    tool: '*',
    action: 'deny',
    priority: 0,
    reason: 'Default-deny catch-all scoped to pr-fix-actor; add an explicit allow above to enable a new tool class.',
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
      source: { session_id: 'bootstrap-pr-fix', agent_id: 'bootstrap' },
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
        principal: PR_FIX_AGENT,
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

  // Ensure parent chain exists. bootstrap.mjs normally creates these;
  // re-assert here so this script is runnable standalone.
  const existingOperator = await host.principals.get(operatorId);
  if (!existingOperator) {
    await host.principals.put({
      id: operatorId,
      name: 'Operator (human)',
      role: 'user',
      permitted_scopes: {
        read: ['session', 'project', 'user', 'global'],
        write: ['session', 'project', 'user', 'global'],
      },
      permitted_layers: {
        read: ['L0', 'L1', 'L2', 'L3'],
        write: ['L0', 'L1', 'L2', 'L3'],
      },
      goals: [],
      constraints: [],
      active: true,
      compromised_at: null,
      signed_by: null,
      created_at: BOOTSTRAP_TIME,
    });
  }

  const existingClaude = await host.principals.get(claudeAgentId);
  if (!existingClaude) {
    await host.principals.put({
      id: claudeAgentId,
      name: 'Agent (Claude Code instance)',
      role: 'agent',
      permitted_scopes: {
        read: ['session', 'project', 'user', 'global'],
        write: ['session', 'project', 'user'],
      },
      permitted_layers: {
        read: ['L0', 'L1', 'L2', 'L3'],
        write: ['L0', 'L1', 'L2'],
      },
      goals: [],
      constraints: [],
      active: true,
      compromised_at: null,
      signed_by: operatorId,
      created_at: BOOTSTRAP_TIME,
    });
  }

  // The pr-fix-actor: signed_by claude-agent (depth 2 from operator).
  // Narrow scope: project only. Layers: read L0..L3, write L0..L1 so
  // the actor can observe + record outcomes but cannot write curated
  // or canon. Goals + constraints summarize the role for human readers
  // (not enforced; the policy atoms above are the enforcement).
  await host.principals.put({
    id: PR_FIX_AGENT,
    name: 'PR-fix actor',
    role: 'agent',
    permitted_scopes: {
      read: ['session', 'project'],
      write: ['session', 'project'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1'],
    },
    goals: [
      'Drive an open PR through review feedback by dispatching agent-loop fixes and resolving threads on touched paths.',
    ],
    constraints: [
      'No merge-class actions. No L2 or L3 writes. Escalate ci-failure / architectural findings.',
    ],
    active: true,
    compromised_at: null,
    signed_by: claudeAgentId,
    created_at: BOOTSTRAP_TIME,
  });

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

  console.log(
    `[bootstrap-pr-fix] Principal '${PR_FIX_AGENT}' signed_by '${claudeAgentId}' created or refreshed.`,
  );
  console.log(`[bootstrap-pr-fix] Wrote ${written} new L3 policy atoms (${skipped} already existed, skipped).`);
  console.log('[bootstrap-pr-fix] Done.');
}

main().catch((err) => {
  console.error('[bootstrap-pr-fix] FAILED:', err);
  process.exit(1);
});
