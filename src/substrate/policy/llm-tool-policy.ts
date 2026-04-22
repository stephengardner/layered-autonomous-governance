/**
 * Per-principal LLM tool policy loader.
 *
 * Reads the canonical policy atom (`pol-llm-tool-policy-<principal-id>`)
 * from the atom store and returns the deny-list the caller should
 * forward to the LLM implementation via `LlmOptions.disallowedTools`.
 *
 * Why this exists
 * ---------------
 * Adapter defaults provide the zero-config safety floor (typically a
 * deny-all posture). A deployment may need narrower or broader
 * per-principal deny-lists. The framework must not hardcode per-actor
 * policy; the shape of what each principal can access is a
 * governance concern, not a code-release concern.
 *
 * This loader is the seam: a caller reads the per-principal policy
 * atom, forwards the returned deny-list to the LLM as
 * `LlmOptions.disallowedTools`, and tuning is a canon edit.
 *
 * Fail-closed discipline
 * ----------------------
 * The loader mirrors the discipline applied to every other policy
 * read in this codebase (pol-judgment-fallback-ladder, the fence
 * atoms, reset-validator):
 *
 *   1. Missing atom       -> return null (caller falls back to
 *                            implementation default, which IS a
 *                            deny-all floor; not more permissive).
 *   2. Tainted atom       -> return null (caller falls back; a
 *                            compromised policy must not silently
 *                            broaden tool access).
 *   3. Superseded atom    -> return null (same reason).
 *   4. Malformed payload  -> throw, so a canon edit that produces
 *                            an un-parsable policy atom fails loud
 *                            rather than silently widening access.
 *
 * Null is "no policy found"; the caller treats it as "use the
 * adapter default." This is strictly less permissive than adding a
 * fallback policy here: we never infer permissions, only read
 * them.
 */

import type { AtomStore } from '../interface.js';
import type { AtomId, PrincipalId } from '../types.js';

/**
 * Canonical atom-id prefix. The per-principal atom lives at
 * `pol-llm-tool-policy-<principal-id>`.
 */
export const LLM_TOOL_POLICY_PREFIX = 'pol-llm-tool-policy-';

export interface LlmToolPolicy {
  readonly principalId: PrincipalId;
  readonly disallowedTools: ReadonlyArray<string>;
  /** Optional human-readable rationale; carried through for audit. */
  readonly rationale?: string;
}

export class LlmToolPolicyError extends Error {
  constructor(message: string, public readonly reasons: ReadonlyArray<string>) {
    super(`${message}:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'LlmToolPolicyError';
  }
}

export function llmToolPolicyAtomId(principalId: PrincipalId | string): AtomId {
  return `${LLM_TOOL_POLICY_PREFIX}${String(principalId)}` as AtomId;
}

/**
 * Load the per-principal LLM tool policy.
 *
 * Returns null when no policy atom is present, or when the atom is
 * tainted / superseded (fail-closed: caller uses adapter default,
 * which is deny-all). Throws `LlmToolPolicyError` on a malformed
 * payload so a canon edit that accidentally produces an unparsable
 * atom surfaces at the first call, not silently later.
 */
export async function loadLlmToolPolicy(
  atoms: AtomStore,
  principalId: PrincipalId,
): Promise<LlmToolPolicy | null> {
  const atom = await atoms.get(llmToolPolicyAtomId(principalId));
  if (!atom) return null;
  if (atom.taint !== 'clean') return null;
  if (atom.superseded_by.length > 0) return null;

  const md = atom.metadata as { policy?: Record<string, unknown> } | undefined;
  const p = md?.policy;
  if (!p || typeof p !== 'object') {
    throw new LlmToolPolicyError(
      `${atom.id}: metadata.policy missing or not an object`,
      [`stored metadata=${JSON.stringify(atom.metadata)}`],
    );
  }

  const reasons: string[] = [];
  if (p['subject'] !== 'llm-tool-policy') {
    reasons.push(`subject: expected "llm-tool-policy", got ${JSON.stringify(p['subject'])}`);
  }
  if (p['principal'] !== String(principalId)) {
    reasons.push(
      `principal: expected ${JSON.stringify(String(principalId))}, got ${JSON.stringify(p['principal'])}`,
    );
  }
  if (!isStringArray(p['disallowed_tools'])) {
    reasons.push('disallowed_tools: expected string[] (empty array is valid; a blank string entry is not)');
  }
  if (p['rationale'] !== undefined && typeof p['rationale'] !== 'string') {
    reasons.push(`rationale: expected string or undefined, got ${JSON.stringify(p['rationale'])}`);
  }
  if (reasons.length > 0) {
    throw new LlmToolPolicyError(`${atom.id}: invalid policy shape`, reasons);
  }

  return Object.freeze({
    principalId,
    disallowedTools: Object.freeze((p['disallowed_tools'] as ReadonlyArray<string>).slice()),
    ...(typeof p['rationale'] === 'string' ? { rationale: p['rationale'] } : {}),
  });
}

// Strict string-array check for policy tool names. Rejects:
//   - non-string members
//   - blank / whitespace-only members
//   - strings with leading or trailing whitespace (`" Bash "`)
//   - strings containing CR or LF
//
// A padded or newline-bearing tool token silently fails exact matching
// downstream while looking valid in the canon atom, so the symptom
// would be "deny-list ignored" with no visible error. Reject at load
// time so a malformed canon edit surfaces loudly.
function isStringArray(v: unknown): v is ReadonlyArray<string> {
  return Array.isArray(v) && v.every(
    (x) => typeof x === 'string'
      && x.trim().length > 0
      && x === x.trim()
      && !x.includes('\n')
      && !x.includes('\r'),
  );
}
