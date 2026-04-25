// Pure helper for scripts/gh-as.mjs.
// Classifies a `gh` argv as either "write" (mutates remote state) or
// "read" (queries remote state without mutation), so the operator-
// action atom write can be gated to writes only.
//
// Why: every gh-as invocation previously wrote one observation atom
// regardless of whether the call mutated GitHub state. Polling read
// paths (pr-status, gh pr view, gh repo view, status checks) accumulate
// thousands of audit atoms per session. Those atoms are write-only-then-
// forgotten (no consumer reads them; verified via grep across src/ +
// apps/), so the audit value is governance-traceability for *writes*,
// not blanket op-tracking for everything that touches the GitHub API.
// The classifier preserves the audit chain for opens / merges / posts /
// edits and silently drops the audit for plain reads.

const MUTATING_SUBCOMMANDS = new Set([
  'create',
  'edit',
  'close',
  'reopen',
  'merge',
  'comment',
  'ready',
  'lock',
  'unlock',
  'delete',
  // Namespace-specific verbs that mutate: `gh release delete-asset`,
  // `gh repo rename / archive`, `gh workflow disable / enable`,
  // `gh run rerun / cancel`. Listed here so a sweep across the
  // namespaces enumerated in NAMESPACES_WITH_MUTATIONS catches the
  // verb and atomizes the audit chain.
  'delete-asset',
  'rename',
  'archive',
  'disable',
  'enable',
  'rerun',
  'cancel',
  // 'review' alone is read; 'review --comment'/'--approve' are write.
  // Handled in the dedicated branch below.
]);

const NAMESPACES_WITH_MUTATIONS = new Set([
  'pr',
  'issue',
  'release',
  'workflow',
  'label',
  'repo',
  'gist',
  'project',
  // `gh run` namespace: list / view / download are reads; cancel /
  // rerun / delete are writes (resolved via MUTATING_SUBCOMMANDS).
  'run',
]);

const HTTP_WRITE_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * True iff the gh argv represents a state-mutating invocation.
 * False on read-only calls and on argv shapes the classifier does
 * not understand (default-deny audit -- a future gh subcommand we
 * do not enumerate is treated as a read; if its audit chain is
 * load-bearing, opt back in via LAG_OP_ACTION_ATOMIZE=all).
 *
 * Pure: no I/O, no globals; same input -> same output.
 */
export function isGhWriteInvocation(args) {
  if (!Array.isArray(args) || args.length === 0) return false;

  const verb = args[0];

  // `gh api` is the catch-all; method is what determines mutation.
  if (verb === 'api') {
    return apiArgvIsWrite(args);
  }

  // Non-api top-level subcommands: mutation is encoded in args[1].
  if (NAMESPACES_WITH_MUTATIONS.has(verb)) {
    const sub = args[1];
    if (typeof sub !== 'string') return false;
    if (MUTATING_SUBCOMMANDS.has(sub)) return true;
    // `gh pr review --comment ...` mutates; `gh pr review` alone is read.
    if (sub === 'review') {
      return args.some((a) => a === '--approve' || a === '--request-changes' || a === '--comment');
    }
    return false;
  }

  // Anything else (auth, status, completion, etc.): read.
  return false;
}

/**
 * Detect a state-mutating `gh api` call by scanning the argv for an
 * HTTP method override (`-X`/`--method` followed by a non-GET verb,
 * or the inline `-X=POST` / `--method=POST` form). The shorthand
 * field flags (`-f`, `-F`, `--field`, `--raw-field`) imply POST when
 * no explicit method is specified, mirroring gh's own behaviour.
 *
 * Two-pass logic so an explicit `-X GET -f foo=bar` (rare but legal:
 * gh accepts field flags on a forced-GET call as a query-string
 * shorthand) is not misclassified as a write. Pass 1 records the
 * explicit method (if any) and whether any field flag was seen;
 * pass 2 -- well, there is no pass 2, the loop just records both
 * signals and decides at the end.
 */
function apiArgvIsWrite(args) {
  let explicitMethod = null;
  let fieldFlagSeen = false;

  // First positional after 'api' is the endpoint; everything else is
  // option/value pairs.
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;

    // Inline form: --method=POST, -X=POST.
    const inlineMatch = a.match(/^(?:--method|-X)=(.+)$/);
    if (inlineMatch) {
      explicitMethod = inlineMatch[1].toUpperCase();
      continue;
    }

    // Separated form: -X POST | --method POST.
    if (a === '-X' || a === '--method') {
      const next = args[i + 1];
      if (typeof next === 'string') {
        explicitMethod = next.toUpperCase();
      }
      i += 1;
      continue;
    }

    // Field flags imply POST per gh's own semantics, but only when
    // no explicit method was set; an explicit `-X GET -f` is still
    // a read.
    if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      fieldFlagSeen = true;
      continue;
    }
    if (a.startsWith('--field=') || a.startsWith('--raw-field=')) {
      fieldFlagSeen = true;
      continue;
    }
  }

  if (explicitMethod !== null) {
    return HTTP_WRITE_VERBS.has(explicitMethod);
  }
  return fieldFlagSeen;
}

/**
 * Gate the audit-atom write at the gh-as boundary. Returns true
 * iff `writeOperatorActionAtom` should run for this invocation.
 *
 * Modes (env-controlled, with safe defaults):
 *   LAG_SKIP_OPERATOR_ACTION_ATOM=1    -> always skip (existing escape hatch)
 *   LAG_OP_ACTION_ATOMIZE=all          -> write every invocation (legacy
 *                                          / debugging; restores the
 *                                          pre-fix audit-everything mode)
 *   default                            -> write only on isGhWriteInvocation
 */
export function shouldWriteOperatorActionAtom(args, env = process.env) {
  if (env.LAG_SKIP_OPERATOR_ACTION_ATOM === '1') return false;
  if (env.LAG_OP_ACTION_ATOMIZE === 'all') return true;
  return isGhWriteInvocation(args);
}
