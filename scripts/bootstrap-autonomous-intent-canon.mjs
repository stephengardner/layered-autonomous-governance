#!/usr/bin/env node
/**
 * Canon bootstrap for three L3 atoms that form the autonomous-intent
 * substrate governance layer, ratified via this PR-gate.
 *
 * Each atom's content is drawn from the corresponding section of the
 * spec (docs/superpowers/specs/2026-04-24-autonomous-intent-substrate-design.md):
 *   - pol-operator-intent-creation (section 4): whitelist of principals
 *     allowed to author operator-intent atoms that the autonomous-intent
 *     approval tick honors.
 *   - pol-plan-autonomous-intent-approve (section 4): policy governing
 *     intent-based auto-approval of plans.
 *   - dev-autonomous-intent-substrate-shape (section 8): directive
 *     describing the authorization model for operator-intent atoms.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-dev-canon-proposals.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');
const BOOTSTRAP_TIME = '2026-04-24T00:00:00.000Z';

const OPERATOR_ID = process.env.LAG_OPERATOR_ID;
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-autonomous-intent-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
    + '  export LAG_OPERATOR_ID=<your-operator-id>\n',
  );
  process.exit(2);
}

const ATOMS = [
  {
    id: 'pol-operator-intent-creation',
    type: 'decision',
    content:
      'Whitelist of principals allowed to author operator-intent atoms that the '
      + 'autonomous-intent approval tick honors. Non-whitelisted authors can still '
      + 'write atoms of type operator-intent (for audit), but the tick treats them as '
      + 'non-authorizing observations. v1 ships with operator-principal only; adding '
      + 'a bot or delegated-human principal is a conscious canon-edit moment that '
      + 'broadens the authorization surface. Do NOT widen without an explicit operator '
      + 'decision atom citing the broadening rationale.',
    subject: 'operator-intent-creation',
    fields: {
      allowed_principal_ids: ['operator-principal'],
      max_expires_in_hours: 72,
      required_trust_envelope_fields: [
        'max_blast_radius',
        'allowed_sub_actors',
      ],
    },
    alternatives_rejected: [
      'Allow any signed principal (not just operator-principal) to author authorizing intents in v1',
      'Enforce principal constraint only at approval-tick time without a canon policy atom',
      'Use a transitive signed_by chain walk instead of a flat allowlist in v1',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: operator-principal-only authorship is the most restrictive '
      + 'safe default; widening is additive and requires only a canon edit plus a '
      + 'derived decision atom. Narrowing below operator-principal would break intend.mjs '
      + 'for any operator. The flat allowlist is upgraded to chain-walk in a follow-up '
      + 'without changing this atom\'s semantics.',
    derived_from: [
      'inv-l3-requires-human',
      'inv-governance-before-autonomy',
      'inv-kill-switch-first',
      'inv-provenance-every-write',
      'arch-atomstore-source-of-truth',
      'dev-forward-thinking-no-regrets',
      'dev-indie-floor-org-ceiling',
    ],
  },
  {
    id: 'pol-plan-autonomous-intent-approve',
    type: 'decision',
    content:
      'Plans that derive_from a fresh (non-expired) operator-intent atom with a '
      + 'matching trust envelope auto-transition proposed -> approved without a multi-reviewer '
      + 'vote cycle. The intent IS the authorization. This policy enforces envelope match: '
      + 'plan confidence >= intent.min_plan_confidence, plan blast_radius <= intent.max_blast_radius, '
      + 'plan.delegation.sub_actor_principal_id in intent.allowed_sub_actors. Intent must be fresh '
      + '(now < intent.expires_at) and uncompromised (taint=clean). Empty allowlist = no intent path; '
      + 'removing this policy disables autonomous-intent flow without breaking manual paths.',
    subject: 'plan-autonomous-intent-approve',
    fields: {
      allowed_sub_actors: ['code-author', 'auditor-actor'],
      require_intent_fresh: true,
      require_intent_clean: true,
      require_intent_principal_allowlist: 'pol-operator-intent-creation',
    },
    alternatives_rejected: [
      'Extend pol-plan-auto-approve-low-stakes to handle intent-based approval instead of a separate policy atom',
      'Require multi-reviewer vote even when operator-intent provides explicit authorization',
      'Embed allowed_sub_actors list directly in the approval-tick code rather than in a canon policy atom',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: the empty-allowlist short-circuit means the policy is a feature '
      + 'flag; setting allowed_sub_actors to [] disables autonomous-intent without any code '
      + 'change. Adding new sub-actor types (deploy-actor, security-reviewer) is additive. '
      + 'The require_intent_principal_allowlist reference to pol-operator-intent-creation '
      + 'creates a deliberate two-atom dependency so that tightening the principal list '
      + 'automatically tightens autonomous approval.',
    derived_from: [
      'inv-l3-requires-human',
      'inv-governance-before-autonomy',
      'inv-kill-switch-first',
      'inv-provenance-every-write',
      'arch-atomstore-source-of-truth',
      'dev-forward-thinking-no-regrets',
      'dev-indie-floor-org-ceiling',
      'pol-operator-intent-creation',
    ],
  },
  {
    id: 'dev-autonomous-intent-substrate-shape',
    type: 'directive',
    content:
      'Operator-authored operator-intent atoms with a trust_envelope authorize autonomous plan-approval; '
      + 'non-operator-authored operator-intent atoms are ignored by the autonomous path. Do not add '
      + 'non-operator principals to pol-operator-intent-creation.allowed_principal_ids without a prior '
      + 'operator-signed decision atom citing the broadening rationale.',
    alternatives_rejected: [
      'Encode this as a process note in a skill file rather than a canon directive',
      'Merge into pol-operator-intent-creation content rather than issuing a separate directive',
    ],
    what_breaks_if_revisit:
      'Sound at 3 months: the two-sentence invariant is the load-bearing safety property '
      + 'of the entire autonomous-intent design. Weakening the first sentence without a '
      + 'principal-delegation-chain mechanism in place would allow bot-authored intents to '
      + 'self-approve plans, collapsing the human-in-the-loop gate. The second sentence '
      + 'is a process guard that survives any future extension to the allowlist.',
    derived_from: [
      'inv-l3-requires-human',
      'inv-governance-before-autonomy',
      'inv-kill-switch-first',
      'arch-atomstore-source-of-truth',
      'dev-flag-structural-concerns',
      'dev-right-over-easy',
      'pol-operator-intent-creation',
      'pol-plan-autonomous-intent-approve',
    ],
  },
];

function atomFromSpec(spec) {
  const metadata = {
    alternatives_rejected: spec.alternatives_rejected,
    // Canonical spelling matches the PlanningActor plan-shape
    // contract (src/actors/planning/*). bootstrap-decisions-canon.mjs
    // uses the past-tense variant; that is a pre-existing drift handled
    // separately, not something this script inherits.
    what_breaks_if_revisit: spec.what_breaks_if_revisit,
  };
  // Policy atoms carry a subject + fields block alongside the standard
  // alternatives_rejected / what_breaks_if_revisit entries.
  if (spec.subject !== undefined) {
    metadata.subject = spec.subject;
  }
  if (spec.fields !== undefined) {
    metadata.fields = spec.fields;
  }
  return {
    schema_version: 1,
    id: spec.id,
    content: spec.content,
    type: spec.type,
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { session_id: 'bootstrap-autonomous-intent-canon', agent_id: 'bootstrap' },
      derived_from: spec.derived_from,
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
    principal_id: OPERATOR_ID,
    taint: 'clean',
    metadata,
  };
}

// Drift-check pattern mirrors bootstrap-decisions-canon.mjs +
// bootstrap-dev-canon-proposals.mjs. Identity + provenance integrity
// are load-bearing: a rewritten provenance under unchanged content
// would silently re-attribute authorship, which violates
// inv-provenance-every-write.
function diffAtom(existing, expected) {
  const diffs = [];
  for (const k of ['type', 'layer', 'content', 'principal_id', 'taint']) {
    if (existing[k] !== expected[k]) {
      diffs.push(`${k}: stored=${JSON.stringify(existing[k])} expected=${JSON.stringify(expected[k])}`);
    }
  }
  const em = existing.metadata ?? {};
  const xm = expected.metadata;
  // Symmetric key comparison: a stored atom with an EXTRA key (stale
  // key left over from a prior version of the script, or post-seed
  // injection) must surface as drift. One-sided comparison would
  // silently accept legacy/injected metadata, which is exactly the
  // class of tampering the drift check exists to catch.
  const allKeys = new Set([...Object.keys(xm), ...Object.keys(em)]);
  for (const k of allKeys) {
    if (JSON.stringify(em[k]) !== JSON.stringify(xm[k])) {
      diffs.push(`metadata.${k}: stored vs expected differ`);
    }
  }
  if (existing.provenance?.kind !== expected.provenance.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(existing.provenance?.kind)} `
      + `expected=${JSON.stringify(expected.provenance.kind)}`,
    );
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
      console.log(`[bootstrap-autonomous-intent-canon] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(`[bootstrap-autonomous-intent-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(`[bootstrap-autonomous-intent-canon] done. ${written} written, ${ok} already in sync.`);
}

await main();
