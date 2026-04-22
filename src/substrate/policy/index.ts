/**
 * L3 policy primitive: match a tool-use attempt against canon policy
 * atoms and return an allow / deny / escalate decision.
 *
 * Policy atom shape (convention, not a new atom type):
 *   type: 'directive'
 *   layer: 'L3'
 *   metadata.policy: {
 *     subject: 'tool-use',
 *     tool:      string | '*' | '^<regex>',
 *     origin:    string | '*' | '^<regex>',
 *     principal: PrincipalId | '*' | '^<regex>',
 *     action:    'allow' | 'deny' | 'escalate',
 *     reason?:   string,
 *     priority?: number,
 *   }
 *
 * Matching:
 *   - Candidate policies = L3 atoms with metadata.policy.subject
 *     === 'tool-use' that are clean (not tainted) and not superseded.
 *   - A policy matches when its tool/origin/principal fields each
 *     match the context (literal equality, '*' wildcard, or regex
 *     pattern starting with '^').
 *   - Specificity score = tool + origin + principal field scores
 *     (exact literal 4, regex 2, wildcard 1). Highest wins; ties
 *     broken by metadata.policy.priority, then atom.created_at desc.
 *   - Fallback (no policy at all, or no matching policy) is
 *     configurable via options.fallbackDecision. Default is
 *     `'escalate'` (fail-closed): a governance gap surfaces as an
 *     HIL prompt rather than silently allowing the action.
 */

import type { Host } from '../interface.js';
import type { Atom, AtomId, PrincipalId } from '../types.js';

export type PolicyDecision = 'allow' | 'deny' | 'escalate';

export interface PolicyContext {
  readonly tool: string;
  readonly origin: string;
  readonly principal: PrincipalId;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PolicyResult {
  readonly decision: PolicyDecision;
  readonly reason: string;
  /** The matched policy atom id, if any. */
  readonly matchedAtomId?: AtomId;
  /** Specificity score of the matched policy; 0 when fallback. */
  readonly specificity: number;
}

export interface CheckToolPolicyOptions {
  readonly maxPolicies?: number;
  readonly pageSize?: number;
  /**
   * Decision returned when no matching, clean, unsuperseded policy
   * atom is found in canon. Defaults to `'escalate'` so a governance
   * gap fails closed (surfaced to HIL) rather than silently allowing.
   * Callers that want permissive behavior must opt in explicitly.
   */
  readonly fallbackDecision?: PolicyDecision;
}

interface ParsedPolicy {
  readonly atom: Atom;
  readonly subject: string;
  readonly tool: string;
  readonly origin: string;
  readonly principal: string;
  readonly action: PolicyDecision;
  readonly reason: string;
  readonly priority: number;
}

/**
 * Look up the effective tool-use policy for a given context and
 * return the decision. Pure read against the atom store; no mutation.
 */
export async function checkToolPolicy(
  host: Host,
  context: PolicyContext,
  options: CheckToolPolicyOptions = {},
): Promise<PolicyResult> {
  const fallbackDecision: PolicyDecision = options.fallbackDecision ?? 'escalate';
  // Paginate through ALL L3 atoms. Partial pagination would mean a
  // more-specific policy sitting beyond the first page could be silently
  // missed, producing an incorrect authorization decision. The loop
  // terminates on nextCursor = null OR when maxPolicies is reached
  // (defence against unbounded atom stores).
  // Validate pagination options up-front so a caller-supplied
  // Number.NaN / Infinity / non-positive value fails fast with a
  // clear message instead of breaking the paged query silently.
  const max = options.maxPolicies ?? Number.POSITIVE_INFINITY;
  if (
    options.maxPolicies !== undefined
    && (typeof options.maxPolicies !== 'number'
      || !Number.isFinite(options.maxPolicies)
      || !Number.isInteger(options.maxPolicies)
      || options.maxPolicies <= 0)
  ) {
    throw new Error('[policy] maxPolicies must be a finite positive integer');
  }
  const pageSize = options.pageSize ?? 200;
  if (
    typeof pageSize !== 'number'
    || !Number.isFinite(pageSize)
    || !Number.isInteger(pageSize)
    || pageSize <= 0
  ) {
    throw new Error('[policy] pageSize must be a finite positive integer');
  }
  const policies: ParsedPolicy[] = [];
  let cursor: string | undefined = undefined;
  let totalSeen = 0;
  while (true) {
    const page = await host.atoms.query({ layer: ['L3'] }, pageSize, cursor);
    for (const atom of page.atoms) {
      totalSeen++;
      // In-code taint + superseded guards: a compromised or superseded
      // policy atom must not participate in the winning decision. Do not
      // rely on AtomFilter predicates; enforcement varies across adapters.
      if (atom.taint !== 'clean') {
        if (totalSeen >= max) break;
        continue;
      }
      if (atom.superseded_by.length > 0) {
        if (totalSeen >= max) break;
        continue;
      }
      const parsed = parsePolicy(atom);
      if (parsed && parsed.subject === 'tool-use') {
        policies.push(parsed);
      }
      if (totalSeen >= max) break;
    }
    if (totalSeen >= max) break;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  if (policies.length === 0) {
    return {
      decision: fallbackDecision,
      reason: `No clean, unsuperseded tool-use policies in canon; fallback=${fallbackDecision}.`,
      specificity: 0,
    };
  }

  let best: { policy: ParsedPolicy; specificity: number } | null = null;
  for (const p of policies) {
    const s = matchSpecificity(p, context);
    if (s === null) continue;
    if (best === null) {
      best = { policy: p, specificity: s };
      continue;
    }
    // Higher specificity wins; tie-break by priority, then created_at desc.
    if (s > best.specificity) {
      best = { policy: p, specificity: s };
    } else if (s === best.specificity) {
      if (p.priority > best.policy.priority) {
        best = { policy: p, specificity: s };
      } else if (
        p.priority === best.policy.priority
        && p.atom.created_at > best.policy.atom.created_at
      ) {
        best = { policy: p, specificity: s };
      }
    }
  }

  if (best === null) {
    return {
      decision: fallbackDecision,
      reason: `No policy matched context (tool=${context.tool}, origin=${context.origin}, principal=${String(context.principal)}); fallback=${fallbackDecision}.`,
      specificity: 0,
    };
  }
  return {
    decision: best.policy.action,
    reason: best.policy.reason,
    matchedAtomId: best.policy.atom.id,
    specificity: best.specificity,
  };
}

/**
 * Pure helper: extract a parsed policy from an atom. Returns null if
 * the atom does not carry a valid `metadata.policy` shape.
 */
export function parsePolicy(atom: Atom): ParsedPolicy | null {
  const policy = atom.metadata.policy;
  if (!policy || typeof policy !== 'object') return null;
  const p = policy as Record<string, unknown>;
  const subject = typeof p.subject === 'string' ? p.subject : null;
  const tool = typeof p.tool === 'string' ? p.tool : null;
  // Reject malformed matcher fields instead of silently widening to
  // wildcards. A policy that ships `origin: 123` (number) or
  // `principal: null` is a canon authoring bug; widening it to `*`
  // means the policy matches MORE contexts than the author intended,
  // which is the exact failure mode to avoid in a deny/escalate rule.
  // Missing (`undefined`) -> wildcard is fine (explicit intent);
  // wrong-type -> null -> atom fails to parse -> policy skipped.
  if (p.origin !== undefined && typeof p.origin !== 'string') return null;
  if (p.principal !== undefined && typeof p.principal !== 'string') return null;
  const origin = typeof p.origin === 'string' ? p.origin : '*';
  const principal = typeof p.principal === 'string' ? p.principal : '*';
  const action = typeof p.action === 'string' ? p.action : null;
  const reason = typeof p.reason === 'string'
    ? p.reason
    : `policy atom ${String(atom.id)}`;
  // `typeof === 'number'` alone admits Infinity / -Infinity / NaN. A
  // policy carrying `priority: Infinity` would always win tie-breaks,
  // and NaN produces undefined ordering. Require finite to fall back
  // to the default 0 for non-finite inputs.
  const priority = typeof p.priority === 'number' && Number.isFinite(p.priority) ? p.priority : 0;
  if (!subject || !tool || !action) return null;
  if (action !== 'allow' && action !== 'deny' && action !== 'escalate') return null;
  return { atom, subject, tool, origin, principal, action, reason, priority };
}

/**
 * Pure helper: score how specifically a policy matches a context.
 * Returns null when the policy does not match at all.
 *
 * Score breakdown (per field, summed):
 *   exact literal match : 4
 *   regex match (prefix '^'): 2
 *   wildcard '*'        : 1
 *   no match            : reject
 */
export function matchSpecificity(
  policy: ParsedPolicy,
  context: PolicyContext,
): number | null {
  const toolScore = fieldScore(policy.tool, context.tool);
  if (toolScore === null) return null;
  const originScore = fieldScore(policy.origin, context.origin);
  if (originScore === null) return null;
  const principalScore = fieldScore(policy.principal, String(context.principal));
  if (principalScore === null) return null;
  return toolScore + originScore + principalScore;
}

// Upper bound on policy regex pattern length. Chosen to cover every
// realistic tool/origin/principal matcher (Bash, Edit, ^Write\b, ^lag-.*,
// etc.) with plenty of headroom, while keeping the worst-case regex
// compilation and matching cost bounded. Canon-authored patterns past
// this length are almost certainly a typo or an attempted ReDoS payload.
const MAX_REGEX_SPEC_LENGTH = 200;

// Heuristic safety check for policy regex patterns. A policy atom lives
// in canon (L3, signed) and is not user-controllable at runtime, but
// LAG's substrate thesis includes 'canon can be wrong'; a bad pattern
// here (catastrophic backtracking) would DoS the policy check for every
// subsequent tool call.
//
// Conservative constraints:
//   1. Length cap (see MAX_REGEX_SPEC_LENGTH).
//   2. Must begin with '^' (we already require that for regex specs).
//   3. Reject the two classical catastrophic-backtracking shapes:
//      a) nested quantifiers: `(x+)+`, `(x*)*`, `(x+)*`, `(x*)+`, `(x?)+`
//      b) overlapping alternation with trailing quantifier:
//         `(a|a)*`, `(a|ab)+` and similar
//   4. Reject backreferences `\1`..`\9` (unbounded work potential).
// A pattern that fails any check is rejected at match time (returns
// null from fieldScore) instead of being compiled. This keeps the
// substrate deterministic even when canon authors ship unsafe regex.
export function isRegexSpecSafe(spec: string): boolean {
  if (spec.length > MAX_REGEX_SPEC_LENGTH) return false;
  if (!spec.startsWith('^')) return false;
  // Nested quantifier: a group whose body ends in a quantifier, and the
  // group itself is followed by a quantifier. Covers `(x+)+`, `(x*)*`,
  // `(x+)*`, `(x?)+`, `(x?)?`, etc.
  if (/\([^()]*[*+?][^()]*\)[*+?]/.test(spec)) return false;
  // Alternation with trailing quantifier - the classic `(a|a)*` family
  // AND variants like `(a|ab)+` where prefixes overlap.
  if (/\([^()|]*\|[^()]*\)[*+?]/.test(spec)) return false;
  // Backreferences with unbounded-work potential.
  if (/\\[1-9]/.test(spec)) return false;
  return true;
}

function fieldScore(spec: string, value: string): number | null {
  if (spec === '*') return 1;
  if (spec === value) return 4;
  if (spec.startsWith('^')) {
    if (!isRegexSpecSafe(spec)) return null;
    try {
      // Auto-wrap a trailing `$` when the spec doesn't already carry
      // one. Without this a pattern like `^Bash` silently matches
      // `Bashful` and any other prefix; the JSDoc shape-examples
      // (`^Write\b`, `^lag-.*`) all read as full-value matches, and
      // canon authors who want prefix behavior can still opt in by
      // writing `^Bash.*` (trailing `.*` makes the `$` harmless) or
      // including an explicit `$`. Test fixtures and bootstrap scripts
      // already use explicit `$` on all exact matchers.
      const anchored = spec.endsWith('$') ? spec : `${spec}$`;
      const re = new RegExp(anchored);
      return re.test(value) ? 2 : null;
    } catch {
      return null;
    }
  }
  return null;
}
