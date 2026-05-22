// Self-audit meta-prompt template.
//
// The text seeded into substrate-deep pipeline as an operator-intent
// when the perpetual self-audit fires. Operators do not author this
// prompt; the substrate fires it on a configured cadence (manual cron,
// LoopRunner pass extension follow-up, etc.) so the system observes
// itself and surfaces gaps without requiring operator presence.
//
// Why this lives as importable data, not inline in the driver script:
// (a) the prompt structure is testable (a unit test pins the 6
// dimensions the operator's 2026-05-22 directive named) and (b) other
// scripts (LoopRunner extension, manual one-off audit, Console-side
// "audit now" button) reuse the same text so a single edit propagates.
//
// Operator's directive 2026-05-22 (verbatim, partial):
//   "What are we missing? What can we improve? If we want to be a solid
//   autonomous framework for organizations and indie developers alike,
//   in the future, what do we need? what do we need to test? continue
//   iterating on that autonomously. You do not need an operator. ...
//   Modeled and orchestrated after the best in the business. ... Dogfed
//   its own processes, and perfected. Perfection above all."
//
// The prompt translates that into a structured ask the substrate-deep
// pipeline can act on: 6 audit dimensions, concrete deliverable shape,
// time-box guidance, citation discipline. The pipeline's plan-stage
// produces a target_paths list; dispatch-stage spawns code-author; the
// PR drives to merge. Perfection-above-all.

/**
 * The six audit dimensions the self-audit prompt asks the LLM to
 * walk. Exposed as a const so the unit test pins the contract; a
 * future widening (e.g. adding "security-posture" or "cost-control")
 * is a deliberate edit that updates both the prompt and the test in
 * one PR. Order matters: indie-floor first because the operator's
 * canon (dev-indie-floor-org-ceiling) puts the solo developer
 * first-class.
 */
export const AUDIT_DIMENSIONS = Object.freeze([
  'indie-floor',
  'org-ceiling',
  'test-coverage',
  'governance-enforcement',
  'operator-readiness',
  'future-proofing',
]);

/**
 * Build the self-audit prompt text. Pure: no I/O, no side effects.
 * Returns a string the caller feeds to intend.mjs as the --request
 * value.
 *
 * The `nowIso` argument is injected (not Date.now) so the test
 * asserts deterministic output across machines. Production callers
 * pass `new Date().toISOString()`.
 */
export function buildSelfAuditPrompt(nowIso) {
  if (typeof nowIso !== 'string' || nowIso.length === 0) {
    throw new Error('buildSelfAuditPrompt: nowIso must be a non-empty ISO timestamp string');
  }
  return [
    'LAG perpetual self-audit. Fire-time: ' + nowIso + '.',
    '',
    'You are auditing the LAG framework on behalf of the operator\'s',
    'standing directive (2026-05-22): be a solid autonomous framework',
    'for BOTH organizations AND indie developers. Identify what we are',
    'missing, what we need to test, what we need to improve, and what',
    'will hurt in 3 months as the framework scales. Dogfed processes,',
    'perfected. Perfection above all.',
    '',
    'Walk these six audit dimensions. Pull evidence from current code,',
    'current canon (CLAUDE.md), recent git log, and open PR / task',
    'state. Cite file:line for every finding. No speculation.',
    '',
    AUDIT_DIMENSIONS.map((d, i) => '  ' + (i + 1) + '. ' + d).join('\n'),
    '',
    'Produce a plan that ships the single highest-leverage gap as a',
    'substrate-level PR (not docs-only, not a roadmap markdown).',
    'Indie-floor + org-ceiling: the gap you fix must articulate which',
    'consumer it serves and why this ship is right NOW vs the others.',
    '',
    'Scope discipline: one PR per self-audit tick. The next tick picks',
    'up the next gap. Bounded, dogfed iteration.',
  ].join('\n');
}
