#!/usr/bin/env node
/**
 * Migration: add LAG-auditor as a required status check on main.
 * Idempotent. Operator runs once POST-MERGE of the autonomous-intent PR.
 *
 * Usage:
 *   node scripts/migrations/2026-04-24-add-lag-auditor-status-check.mjs
 *
 * Requires: gh CLI with admin on the repo.
 */
import { execa } from 'execa';

const REPO = 'stephengardner/layered-autonomous-governance';
const BRANCH = 'main';
const CONTEXT = 'LAG-auditor';

async function main() {
  const cur = await execa('gh', ['api', `repos/${REPO}/branches/${BRANCH}/protection`]);
  const protection = JSON.parse(cur.stdout);
  const contexts = protection.required_status_checks?.contexts ?? [];
  if (contexts.includes(CONTEXT)) {
    console.log(`[migration] ${CONTEXT} already in required_status_checks.contexts; no change.`);
    return;
  }
  const next = [...contexts, CONTEXT];
  const body = JSON.stringify({ contexts: next, strict: protection.required_status_checks?.strict ?? true });
  await execa('gh', [
    'api', `repos/${REPO}/branches/${BRANCH}/protection/required_status_checks`,
    '-X', 'PATCH',
    '--input', '-',
  ], { input: body });
  console.log(`[migration] added ${CONTEXT} to required_status_checks. Now: ${next.join(', ')}`);
}
main().catch((err) => { console.error(err); process.exit(1); });
