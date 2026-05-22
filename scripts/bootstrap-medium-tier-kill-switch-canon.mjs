#!/usr/bin/env node
/**
 * Canon bootstrap for the medium-tier kill-switch ship.
 *
 * Seeds 4 L3 decision atoms into the .lag/atoms store:
 *
 *   dec-medium-tier-kill-switch-shipped-2026-05-22
 *     The base architectural fact: interface + reference impl +
 *     runner wiring all landed on this date.
 *
 *   dec-pol-cto-no-merge-medium-tier-available-2026-05-22
 *   dec-pol-pr-landing-no-auto-merge-medium-tier-available-2026-05-22
 *   dec-inv-kill-switch-first-medium-tier-available-2026-05-22
 *     Three companion atoms, one per parent canon entry that
 *     historically cited the medium-tier kill switch as an
 *     unfulfilled gate. Parents are NOT modified
 *     (per dev-canon-atoms-immutable: an L3 atom that is published
 *     and consumed is not edited in place); the companion atoms
 *     carry the delta so arbitration can resolve the current
 *     posture without reflowing the original directive text.
 *
 * Atom shapes live in scripts/lib/medium-tier-kill-switch-canon-policies.mjs
 * so the drift test suite can drive the same builder. This wrapper
 * handles argument parsing, env discovery, the file-host write, and
 * the drift-check.
 *
 * --dry-run prints the atoms that would be written without persisting
 * them. Useful for inspecting the seed before committing.
 *
 * Idempotent per atom id; drift against the stored shape fails loud
 * (same discipline as bootstrap-self-audit-cadence-canon.mjs).
 */

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createFileHost } from '../dist/adapters/file/index.js';
import {
  buildPolicies,
  companionAtom,
} from './lib/medium-tier-kill-switch-canon-policies.mjs';
import { resolveStateDir } from './lib/resolve-state-dir.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const STATE_DIR = resolveStateDir(REPO_ROOT);

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

// Operator principal id. Every deployment picks its own; a hardcoded
// default here would leak one instance's shape into the script.
// Require explicit configuration. Trim before the empty-check so a
// whitespace-only env value does not slip through.
const OPERATOR_ID = process.env.LAG_OPERATOR_ID?.trim();
if (!OPERATOR_ID) {
  console.error(
    '[bootstrap-medium-tier-kill-switch-canon] ERROR: LAG_OPERATOR_ID is not set.\n'
      + 'Export your operator principal id before running this script, e.g.\n\n'
      + '  export LAG_OPERATOR_ID=<your-operator-id>\n\n'
      + 'The id signs each seed atom; it must match the principal already seeded\n'
      + 'in .lag/principals/.',
  );
  process.exit(2);
}

/**
 * Compare a stored companion-atom payload to the expected shape.
 * Returns a list of drift descriptors (empty = in sync). Mirrors
 * diffPolicyAtom from bootstrap-self-audit-cadence-canon.mjs so the
 * canon bootstraps share one drift-check pattern.
 */
function diffCompanionAtom(existing, expected) {
  const diffs = [];
  if (existing.type !== expected.type) diffs.push(`type: ${existing.type} -> ${expected.type}`);
  if (existing.layer !== expected.layer) diffs.push(`layer: ${existing.layer} -> ${expected.layer}`);
  if (existing.content !== expected.content) {
    diffs.push('content (rationale): stored vs expected differ; rewrite or bump id to supersede');
  }
  if (existing.principal_id !== expected.principal_id) {
    diffs.push(
      `principal_id: stored=${JSON.stringify(existing.principal_id)} `
        + `expected=${JSON.stringify(expected.principal_id)}`,
    );
  }
  const ev = existing.provenance ?? {};
  const xv = expected.provenance;
  if (ev.kind !== xv.kind) {
    diffs.push(
      `provenance.kind: stored=${JSON.stringify(ev.kind)} `
        + `expected=${JSON.stringify(xv.kind)}`,
    );
  }
  if (JSON.stringify(ev.source ?? {}) !== JSON.stringify(xv.source)) {
    diffs.push(
      `provenance.source: stored=${JSON.stringify(ev.source)} `
        + `expected=${JSON.stringify(xv.source)}`,
    );
  }
  if (JSON.stringify(ev.derived_from ?? []) !== JSON.stringify(xv.derived_from)) {
    diffs.push(
      `provenance.derived_from: stored=${JSON.stringify(ev.derived_from)} `
        + `expected=${JSON.stringify(xv.derived_from)}`,
    );
  }
  const ep = existing.metadata?.policy ?? {};
  const xp = expected.metadata.policy;
  const keys = new Set([...Object.keys(ep), ...Object.keys(xp)]);
  for (const k of keys) {
    if (JSON.stringify(ep[k]) !== JSON.stringify(xp[k])) {
      diffs.push(`policy.${k}: stored=${JSON.stringify(ep[k])} expected=${JSON.stringify(xp[k])}`);
    }
  }
  return diffs;
}

async function main() {
  const policies = buildPolicies(OPERATOR_ID);

  if (DRY_RUN) {
    console.log(
      `[bootstrap-medium-tier-kill-switch-canon] dry-run: ${policies.length} atoms would be written:`,
    );
    for (const spec of policies) {
      const expected = companionAtom(spec, OPERATOR_ID);
      console.log(
        `  - ${expected.id} (type=${expected.type} layer=${expected.layer} `
          + `policy.subject=${expected.metadata.policy.subject})`,
      );
    }
    return;
  }

  await mkdir(STATE_DIR, { recursive: true });
  const host = await createFileHost({ rootDir: STATE_DIR });
  let written = 0;
  let ok = 0;
  for (const spec of policies) {
    const expected = companionAtom(spec, OPERATOR_ID);
    const existing = await host.atoms.get(expected.id);
    if (existing === null) {
      await host.atoms.put(expected);
      written += 1;
      console.log(`[bootstrap-medium-tier-kill-switch-canon] wrote ${expected.id}`);
      continue;
    }
    const diffs = diffCompanionAtom(existing, expected);
    if (diffs.length > 0) {
      console.error(
        `[bootstrap-medium-tier-kill-switch-canon] DRIFT on ${expected.id}:\n  ${diffs.join('\n  ')}\n`
          + 'Resolve by: (a) editing buildPolicies in '
          + 'scripts/lib/medium-tier-kill-switch-canon-policies.mjs to match stored shape '
          + 'if the stored value is authoritative, or (b) bumping the atom id and '
          + 'superseding the old one if you are intentionally changing the decision.',
      );
      process.exitCode = 1;
      return;
    }
    ok += 1;
  }
  console.log(
    `[bootstrap-medium-tier-kill-switch-canon] done. ${written} written, ${ok} already in sync.`,
  );
}

main().catch((err) => {
  console.error('[bootstrap-medium-tier-kill-switch-canon] FAILED:', err);
  process.exit(1);
});
