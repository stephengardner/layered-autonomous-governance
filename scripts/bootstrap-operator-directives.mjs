#!/usr/bin/env node
/**
 * Canon bootstrap for operator-authored directives captured via the
 * decide skill / scripts/decide.mjs.
 *
 * This file is the canonical, committed home for operator directives
 * that governance relies on: "CR is non-negotiable", "no real-name
 * comments on automation artifacts", etc. The decide CLI writes
 * atoms directly to .lag/ on capture (fast, local, per-session);
 * THIS script re-seeds them on fresh checkouts / CI runs so the
 * atoms survive outside the operator's laptop.
 *
 * When the operator captures a new directive with `/decide`, the
 * follow-up PR should append its spec to the ATOMS array below so
 * the capture is durable across environments. A directive that
 * lives only in one operator's local .lag/ is not really canon.
 *
 * Idempotent per atom id; drift against stored shape fails loud
 * (same pattern as bootstrap-decisions-canon.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-operator-directives] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-principal-id>\n',
  );
  process.exit(2);
}

const ATOMS = [
  {
    id: 'dev-coderabbit-required-status-check-non-negotiable',
    type: 'directive',
    content:
      'CodeRabbit is a required status check for the main branch of this repo. It is '
      + 'non-negotiable. Branch-protection changes that remove CodeRabbit from '
      + 'required_status_checks.contexts are rejected. Workarounds that preserve the gate '
      + '(operator-proxy comment triggers, auto-review reliability, machine-user accounts) '
      + 'are acceptable; workarounds that remove the gate (marking CR advisory, path-scoped '
      + 'conditional required checks that drop CR for bot-opened PRs, dropping the check '
      + 'entirely for a subset of PRs) are not. If the gate is temporarily waived for a '
      + 'specific merge due to an emergency, the waiver must itself produce a decision '
      + 'atom and a follow-up that restores the gate.',
    alternatives_rejected: [
      {
        option: 'Drop CodeRabbit from required_status_checks.contexts entirely',
        reason: 'Loses the merge-quality gate for all PRs; CR findings become advisory only; weakens the governance story this repo sells.',
      },
      {
        option: 'Path-scoped conditional required-check via ruleset (CR required only for human-authored PRs)',
        reason: 'Still removes the gate for exactly the PRs (bot-opened) most in need of independent review; gate-weakening by class, not per-decision.',
      },
      {
        option: 'Accept CR as optional when bot-opened PRs outnumber human-opened PRs in a given week',
        reason: 'Couples merge gate to throughput; at scale the threshold would always be crossed. Merge quality is not a throughput-tunable property.',
      },
    ],
    what_breaks_if_revisited:
      'Merge quality gate weakens; CR findings become advisory only; the repo\'s three-layer '
      + 'governance story loses its third-party-review layer.',
    derived_from: ['inv-governance-before-autonomy', 'dev-forward-thinking-no-regrets'],
  },
  {
    id: 'dev-operator-personal-account-no-automation-comments',
    type: 'directive',
    content:
      'The operator\'s personal GitHub account (stephengardner) does not comment on PRs '
      + 'as part of automation flows in this repo. All automation-originated PR comments, '
      + 'review replies, status updates, and merge actions route through provisioned bot '
      + 'identities (lag-ceo as the operator-proxy, lag-cto for decision-bearing work, '
      + 'lag-pr-landing for review handling). The only exception is extreme circumstances '
      + 'where the lag-ceo bot identity itself has broken (installation revoked, token flow '
      + 'dead, App disabled) AND autonomous recovery has failed; in that case the operator '
      + 'may comment from the personal account as a last-resort bootstrap to restore the '
      + 'bot flow, and a follow-up decision atom must capture the breakage + recovery so the '
      + 'bypass is auditable. A human-authored PR review on a PR the operator is personally '
      + 'reviewing as a reviewer (not as automation) is not covered by this directive.',
    alternatives_rejected: [
      {
        option: 'Operator comments permitted on any PR whenever convenient',
        reason: 'Collapses the bot-identity audit trail; breaks the three-layer attribution guarantee (credential isolation + repo-local git identity + PreToolUse hook) by giving the operator a silent second channel.',
      },
      {
        option: 'Operator comments forbidden entirely with no exception',
        reason: 'No escape hatch when the bot-identity flow itself breaks; operator becomes locked out of their own repo on a partial-outage scenario.',
      },
      {
        option: 'Operator comments allowed only when explicitly self-labeled [operator-bypass]',
        reason: 'Labelling discipline is eventually forgotten; the exception label gets reused for convenience over time, eroding into option 1.',
      },
    ],
    what_breaks_if_revisited:
      "Bot-identity abstraction leaks; the three-layer attribution guarantee weakens; future "
      + "audits of 'who did what' lose their clean operator->bot->action chain.",
    derived_from: ['arch-bot-identity-per-actor', 'inv-provenance-every-write'],
  },
];

function atomFromSpec(spec) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: spec.type,
    layer: 'L3',
    provenance: {
      kind: 'human-asserted',
      source: {
        tool: 'decide-cli',
        agent_id: OPERATOR_ID,
      },
      derived_from: spec.derived_from ?? [],
    },
    confidence: 1.0,
    created_at: now,
    last_reinforced_at: now,
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
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata: {
      alternatives_rejected: spec.alternatives_rejected,
      what_breaks_if_revisited: spec.what_breaks_if_revisited,
      source: 'decide-cli',
    },
  };
}

function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  for (const k of Object.keys(xm)) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored vs expected differ`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(`provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} expected=${JSON.stringify(expected.provenance.kind)}`);
  }
  if (JSON.stringify(existing.provenance?.source ?? null) !== JSON.stringify(expected.provenance.source)) {
    diffs.push('provenance.source differs');
  }
  if (JSON.stringify(existing.provenance?.derived_from ?? []) !== JSON.stringify(expected.provenance.derived_from)) {
    diffs.push('provenance.derived_from differs');
  }
  return diffs;
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of ATOMS) {
    const expected = atomFromSpec(spec);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-operator-directives] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-operator-directives] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-operator-directives] done. ${written} written, ${ok} already in sync.`);
}

await main();
