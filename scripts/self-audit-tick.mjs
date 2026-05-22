#!/usr/bin/env node
/**
 * Self-audit tick driver.
 *
 * Fires a single substrate-deep pipeline run seeded with the
 * "what are we missing" meta-prompt. Each tick produces ONE PR
 * shipping ONE substrate gap; the cadence (how often the tick fires)
 * is owned by the caller, not this script. Indie deployment wires
 * this to a manual cron line; org-ceiling deployment wires it to a
 * LoopRunner pass extension (follow-up).
 *
 * Usage:
 *   node scripts/self-audit-tick.mjs [--dry-run]
 *
 * The script is a wrapper around `scripts/intend.mjs --trigger`. It
 * does NOT bypass the existing gates: the substrate-deep pipeline's
 * canon-policy ladder (HIL pause-modes, validator failure caps,
 * cross-stage re-prompt) still applies. The only thing this tick
 * adds is "the operator does not have to be the one typing the
 * intent."
 *
 * Why this lives as a separate script and not a LoopRunner pass yet:
 * - V0 ships fast and lets operators wire it however they want
 *   (Windows Task Scheduler, cron, npm script, LoopRunner pass).
 * - LoopRunner pass integration is the follow-up; it adds a canon
 *   policy reader + cadence knob + opt-in gate (default off so a
 *   solo developer on free-tier does not surprise-spend at
 *   midnight).
 * - The prompt is the load-bearing part; once that is locked the
 *   integration becomes a tunable cadence knob.
 *
 * Per canon dev-cto-bypass: this script is NOT an operator-bypass.
 * The intent atom it writes is authored by the operator-principal
 * (the script runs under the operator's identity); the trust
 * envelope still gates approval. A non-operator running this script
 * authors a non-authorizing observation per the canon.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildSelfAuditPrompt } from './lib/self-audit-prompt.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const intendPath = resolve(repoRoot, 'scripts/intend.mjs');

const prompt = buildSelfAuditPrompt(new Date().toISOString());

if (dryRun) {
  // Surface the resolved prompt without writing the atom. Useful for
  // operator sanity-check before wiring the cron line, and for
  // smoke-testing the script after a canon edit that changes the
  // dimensions list.
  console.log('=== self-audit prompt (dry-run, no intent written) ===');
  console.log(prompt);
  console.log('=== end ===');
  process.exit(0);
}

// Why these flag values:
// - --scope framework: a self-audit by definition can land framework
//   substrate; smaller scopes (tooling, docs) would foreclose the
//   substrate-fix path on a Tuesday because the cron picked 'tooling'.
// - --blast-radius framework: matches scope. The audit MAY surface a
//   l3-canon-proposal but the typical tick produces a substrate fix.
// - --sub-actors code-author: the dispatch stage hands off to the
//   code-author to actually ship the PR.
// - --min-confidence 0.75: matches the indie-floor default in the
//   trust envelope. Tighter floors (org-ceiling) flip via canon
//   policy, not a flag on this script.
const intendArgs = [
  intendPath,
  '--request', prompt,
  '--scope', 'framework',
  '--blast-radius', 'framework',
  '--sub-actors', 'code-author',
  '--min-confidence', '0.75',
  '--trigger',
];

console.log('[self-audit-tick] firing substrate-deep pipeline with self-audit prompt');
const result = spawnSync(process.execPath, intendArgs, { stdio: 'inherit' });
if (result.error) {
  console.error('[self-audit-tick] failed to spawn intend.mjs:', result.error.message);
  process.exit(2);
}
process.exit(result.status ?? 1);
