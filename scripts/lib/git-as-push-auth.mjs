// Pure helpers for git-as.mjs push auth routing. Extracted into
// their own shebang-free module so the test can static-import them
// (PR #123 landed the same pattern after observing vitest's Windows
// transformer rejecting shebang-headed .mjs imports; we adopt it
// here defensively without re-running that diagnosis).
//
// The CLI wrapper (scripts/git-as.mjs) composes these helpers with
// spawnSync-style side effects.

/**
 * Parse a `git push` arg list to find the positional remote.
 * Returns { remoteIndex, remote } where remoteIndex is the 0-based
 * position inside gitArgs, or null if no remote is specified (bare
 * `git push` -- git falls back to the branch's upstream in that
 * case and the caller uses the Bearer path).
 *
 * git push option grammar (what we need to skip correctly):
 *   push [<options>] [<remote> [<refspec>...]]
 *
 * Options can be:
 *   - boolean: --force, --tags, --atomic, -u, -f, ...
 *   - value-taking-separate: --repo <name>, --receive-pack <cmd>, ...
 *   - value-inline: --repo=<name>, --receive-pack=<cmd>, ...
 *
 * Only the two value-taking options that consume the next arg need
 * explicit handling; inline `--flag=val` forms are a single token.
 */
const PUSH_VALUE_OPTIONS = new Set(['--repo', '--receive-pack', '--exec']);

export function findRemoteArg(gitArgs) {
  let i = gitArgs.indexOf('push') + 1;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (a === '--') return { remoteIndex: i + 1, remote: gitArgs[i + 1] ?? null };
    if (a.startsWith('-')) {
      if (PUSH_VALUE_OPTIONS.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return { remoteIndex: i, remote: a };
  }
  return null;
}

/**
 * Git-level (pre-subcommand) flags that consume the next argv entry.
 * Used by isPushCommand to skip over flag values when locating the
 * subcommand. Inline `--flag=value` forms are a single token and
 * already pass through the .startsWith('-') branch.
 *
 * `-c name=value` is included even though the value is `name=value`
 * (a single token) because git's grammar still treats it as a
 * separate argument; missing it would mis-classify
 * `git -c http.proxy=... push origin foo` as a non-push command.
 */
const GIT_LEVEL_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--list-cmds',
]);

/**
 * True if gitArgs' first positional is `push`. Matches bare `push`
 * and skips preceding git-level options including value-taking
 * flags like `-C <dir>`. Inline forms (`--git-dir=path`) are single
 * tokens and don't need the value-skip path.
 */
export function isPushCommand(gitArgs) {
  let i = 0;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (a === 'push') return true;
    if (a.startsWith('-')) {
      if (GIT_LEVEL_VALUE_OPTIONS.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Match an `https://github.com/<owner>/<repo>(.git)?(/)?` URL and
 * return its canonical owner/repo. Returns null for SSH, enterprise
 * hosts, or malformed URLs so the caller falls through to the
 * Bearer extraHeader path for those shapes.
 *
 * Owner + repo char set matches GitHub's documented allowed chars
 * (letters, digits, hyphens, underscores, periods). Strictness stays
 * useful without over-fitting to edge cases.
 */
const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export function parseGithubHttps(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(GITHUB_HTTPS_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function buildTransientPushUrl({ owner, repo, token }) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Compute the gitArgs to actually spawn for a push. If the remote
 * resolves to an https://github.com/... URL, the remote arg position
 * is replaced with the transient x-access-token URL. Otherwise
 * returns null to signal "fall through to the Bearer path".
 *
 * Pure: no side effects. The test drives it with a table of
 * (gitArgs, resolvedRemoteUrl, token) without shelling out to git.
 */
export function buildPushSpawnArgs(gitArgs, resolvedRemoteUrl, token) {
  const remoteInfo = findRemoteArg(gitArgs);
  if (remoteInfo === null) return null;
  const parsed = parseGithubHttps(resolvedRemoteUrl ?? '');
  if (parsed === null) return null;
  const transient = buildTransientPushUrl({
    owner: parsed.owner,
    repo: parsed.repo,
    token,
  });
  const next = gitArgs.slice();
  next[remoteInfo.remoteIndex] = transient;
  return next;
}

/**
 * Detect `-u` / `--set-upstream` in a `git push` arg list and return
 * a plan for replacing the user's intent without leaking the
 * transient x-access-token URL into `.git/config`.
 *
 * Why this exists
 * ---------------
 * `buildPushSpawnArgs` substitutes the remote NAME (e.g. `origin`)
 * with a transient URL `https://x-access-token:<token>@github.com/...`
 * so the receive-pack endpoint accepts our Basic auth. Git's `-u`
 * flag (alias of `--set-upstream`) tells git to record the remote
 * as the branch's upstream. With the URL substituted into argv, git
 * records the FULL URL  --  including the embedded token  --  into
 * `branch.<name>.remote` of `.git/config`. The token then persists
 * on disk for hours past the push, in a file the operator's editor
 * + IDE + linter all read.
 *
 * The fix this helper enables: strip `-u` from the spawn argv and
 * record (remoteName, branchHint) so the wrapper can set the upstream
 * AFTER a successful push using `git config branch.<name>.remote
 * <remote-name>`  --  which references the named remote rather than the
 * transient URL.
 *
 * Returns null when `-u` is absent. Otherwise:
 *   { strippedArgs, remoteName, branchHint }
 *
 * `branchHint` is the source side of the first refspec after the
 * remote (the form `<src>:<dst>` is split on `:`), or null if no
 * refspec was provided. The wrapper resolves a null hint via
 * `git rev-parse --abbrev-ref HEAD` (the current branch).
 */
const SET_UPSTREAM_FLAGS = new Set(['-u', '--set-upstream']);

export function extractSetUpstreamPlan(gitArgs) {
  if (!Array.isArray(gitArgs)) return null;
  const remoteInfoBefore = findRemoteArg(gitArgs);
  if (remoteInfoBefore === null) return null;
  const stripped = [];
  let hadFlag = false;
  for (const arg of gitArgs) {
    if (SET_UPSTREAM_FLAGS.has(arg)) {
      hadFlag = true;
      continue;
    }
    stripped.push(arg);
  }
  if (!hadFlag) return null;
  // After strip, indices shift left; re-find the remote slot.
  const remoteInfoAfter = findRemoteArg(stripped);
  if (remoteInfoAfter === null) return null;
  const refspec = stripped[remoteInfoAfter.remoteIndex + 1] ?? null;
  // Source side of the refspec (before `:`). Strip a leading `+` so a
  // force-refspec like `+feat/x:release-x` yields `feat/x` (not
  // `+feat/x`, which would interpolate into an invalid config key
  // `branch.+feat/x.remote`).
  let branchHint = null;
  let mergeRef = null;
  if (typeof refspec === 'string' && refspec.length > 0) {
    const colonIdx = refspec.indexOf(':');
    const rawSrc = colonIdx >= 0 ? refspec.slice(0, colonIdx) : refspec;
    const rawDst = colonIdx >= 0 ? refspec.slice(colonIdx + 1) : null;
    const srcStripped = rawSrc.startsWith('+') ? rawSrc.slice(1) : rawSrc;
    branchHint = srcStripped.length > 0 ? srcStripped : null;
    // Destination side: if the refspec was `src:dst`, capture `dst`
    // so the wrapper can write `branch.<src>.merge = refs/heads/<dst>`
    // -- matching what native `-u` would do. If `dst` already starts
    // with `refs/heads/` use it verbatim; otherwise wrap it. If no
    // `:` was present, leave mergeRef null and the wrapper falls
    // back to `refs/heads/<branchHint>`.
    if (rawDst !== null && rawDst.length > 0) {
      mergeRef = rawDst.startsWith('refs/') ? rawDst : `refs/heads/${rawDst}`;
    }
  }
  return {
    strippedArgs: stripped,
    remoteName: remoteInfoAfter.remote,
    branchHint,
    mergeRef,
  };
}

/**
 * Produce the child-env overrides for the READ-ONLY verbs (fetch,
 * pull, clone, ls-remote, ...). GitHub accepts Bearer on these
 * endpoints, so the token flows via `http.extraHeader` and never
 * touches argv.
 *
 * The empty `GIT_ASKPASS` / `SSH_ASKPASS` fields neutralize ambient
 * askpass helpers some shells inherit (notably MSYS git-bash, which
 * exports `SSH_ASKPASS` pointing at a GUI helper that hangs ~30s
 * waiting for a TTY when invoked from a non-interactive child).
 * Empty strings make git skip both helpers, then `GIT_TERMINAL_PROMPT=0`
 * fails fast instead of hanging on a prompt that never arrives.
 */
export function buildReadOnlyEnv(token) {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

/**
 * Produce the child-env overrides for PUSH. GitHub rejects Bearer
 * on receive-pack, so extraHeader is intentionally absent; the
 * token reaches git via the transient URL argv position (see
 * buildPushSpawnArgs). credential.helper= still clears the ambient
 * helper, and GIT_TERMINAL_PROMPT=0 still fails fast on misconfig.
 *
 * `GIT_ASKPASS` / `SSH_ASKPASS` are neutralized for the same reason
 * as buildReadOnlyEnv: prevent inherited helper scripts from hanging
 * on a TTY that the wrapper's child never has.
 */
export function buildPushEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };
}

/**
 * Verbs that talk to a remote and consume credentials but do NOT
 * write to the server. Subset of git-as.mjs's "read-only" routing
 * branch. `push` is intentionally absent  --  push has its own
 * dedicated buildPushSpawnArgs path because the receive-pack
 * endpoint requires Basic auth from day one.
 *
 * `clone` is included for verb-recognition (the wrapper still
 * surfaces a clear error for clone-on-401) but buildFetchUrlAuthArgs
 * returns null for clone because the URL is persisted into the new
 * repo's .git/config (PR #169 leak shape).
 */
const READ_ONLY_REMOTE_VERBS = new Set([
  'fetch',
  'pull',
  'ls-remote',
  'clone',
]);

/**
 * True if gitArgs' first positional verb (after walking git-level
 * options including value-taking flags like `-C <dir>`) is one of
 * fetch / pull / ls-remote / clone.
 *
 * Mirrors the isPushCommand parse path so the two routing checks
 * agree on what counts as "the verb". `push` is intentionally not
 * matched here  --  push routes through buildPushSpawnArgs.
 */
export function isReadOnlyRemoteVerb(gitArgs) {
  if (!Array.isArray(gitArgs)) return false;
  let i = 0;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (typeof a !== 'string') return false;
    if (READ_ONLY_REMOTE_VERBS.has(a)) return true;
    if (a.startsWith('-')) {
      if (GIT_LEVEL_VALUE_OPTIONS.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Subcommand-level options for the read-only verbs that consume the
 * NEXT argv token as their value. Without explicit skipping the
 * remote-arg locator would mistake the value token (e.g. the `1` in
 * `git fetch --depth 1 origin`) for the remote positional.
 *
 * Sourced from `git fetch --help`, `git pull --help`, `git ls-remote
 * --help`, `git clone --help`. Inline forms (`--depth=1`,
 * `--upload-pack=/path`) are a single argv token and pass through
 * the `.startsWith('-')` branch already; only the separate-arg form
 * needs explicit skip handling.
 *
 * Short aliases (-b for --branch, -o for --origin, etc.) are
 * intentionally included because callers like `git clone -b main
 * origin` rely on them.
 */
const READ_ONLY_VERB_VALUE_OPTIONS = new Set([
  // fetch / pull
  '--depth',
  '--deepen',
  '--shallow-since',
  '--shallow-exclude',
  '--negotiation-tip',
  '--negotiator',
  '--server-option',
  '-o',
  '--upload-pack',
  '--refmap',
  '-j',
  '--jobs',
  '--filter',
  // pull-only extras (merge options)
  '--strategy',
  '-s',
  '--strategy-option',
  '-X',
  // clone extras
  '--origin',
  '--branch',
  '-b',
  '--template',
  '--config',
  '-c',
  '--reference',
  '--reference-if-able',
  // ls-remote extras
  '--sort',
]);

/**
 * Find the read-only verb's index plus the index of the first
 * positional after it (the remote arg slot, when present). Returns
 * null when no read-only verb is present or no remote arg follows.
 *
 * Internal helper for buildFetchUrlAuthArgs; matches the verb
 * recognition in isReadOnlyRemoteVerb so the two stay in sync.
 *
 * Public form for the wrapper to look up the remote name without
 * re-implementing the verb-skipping grammar is findReadOnlyRemoteArg
 * below.
 *
 * Grammar quirks handled:
 *   - Git-level options before the verb (handled in the first loop):
 *     `-C <dir>`, `-c k=v`, `--git-dir <path>`, etc.
 *   - Subcommand-level value-taking flags after the verb (handled in
 *     the second loop via READ_ONLY_VERB_VALUE_OPTIONS): `--depth N`,
 *     `--upload-pack <path>`, `-b <branch>`, etc. Without this the
 *     value token would be mistaken for the remote.
 *   - Inline forms (`--depth=N`, `-j=4`) are single argv tokens and
 *     pass through the `.startsWith('-')` branch unchanged.
 *   - `--` end-of-options marker: the next token is the remote
 *     positional regardless of whether it begins with `-`.
 */
function findReadOnlyRemoteSlot(gitArgs) {
  if (!Array.isArray(gitArgs)) return null;
  let i = 0;
  let verbIndex = -1;
  let verb = null;
  while (i < gitArgs.length) {
    const a = gitArgs[i];
    if (typeof a !== 'string') return null;
    if (READ_ONLY_REMOTE_VERBS.has(a)) {
      verbIndex = i;
      verb = a;
      break;
    }
    if (a.startsWith('-')) {
      if (GIT_LEVEL_VALUE_OPTIONS.has(a)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    return null;
  }
  if (verbIndex < 0) return null;
  // First positional after the verb is the remote slot. Skip any
  // verb-level flags AND skip the value of known value-taking flags
  // (e.g. `--depth 1`, `--upload-pack /path`) so we do not mistake
  // the value token for the remote.
  let j = verbIndex + 1;
  while (j < gitArgs.length) {
    const a = gitArgs[j];
    if (typeof a !== 'string') {
      j += 1;
      continue;
    }
    if (a === '--') {
      // End-of-options. The next token is the remote regardless of
      // its leading character.
      if (j + 1 < gitArgs.length && typeof gitArgs[j + 1] === 'string') {
        return { verbIndex, verb, remoteIndex: j + 1 };
      }
      return null;
    }
    if (a.startsWith('-')) {
      if (READ_ONLY_VERB_VALUE_OPTIONS.has(a)) {
        j += 2;
        continue;
      }
      j += 1;
      continue;
    }
    return { verbIndex, verb, remoteIndex: j };
  }
  return null;
}

/**
 * Public companion to findRemoteArg, scoped to the read-only remote
 * verbs (fetch / pull / ls-remote / clone). Returns the same shape
 * findRemoteArg returns (`{ remoteIndex, remote }`) or null when no
 * read-only verb is present or there is no remote positional.
 *
 * The wrapper (scripts/git-as.mjs) uses this to look up the remote
 * NAME so it can resolve the URL via `git remote get-url` before
 * calling buildFetchUrlAuthArgs.
 */
export function findReadOnlyRemoteArg(gitArgs) {
  const slot = findReadOnlyRemoteSlot(gitArgs);
  if (slot === null) return null;
  const remote = gitArgs[slot.remoteIndex];
  if (typeof remote !== 'string') return null;
  return { remoteIndex: slot.remoteIndex, remote };
}

/**
 * Extract the git-level context flags (`-C <dir>`, `--git-dir <path>`,
 * `--work-tree <path>`, and their inline `--flag=value` forms) from
 * an argv so they can be propagated to subsidiary `git` invocations
 * (e.g. `git remote get-url`) that need to target the same working
 * tree as the primary spawn.
 *
 * Why this matters
 * ----------------
 * `git-as <role> -C /other/repo fetch origin` resolves the remote
 * URL via `git remote get-url origin` -- if that lookup runs without
 * the same `-C` it reads from the wrong .git/config and returns the
 * wrong URL (or null). The same shape applies to `--git-dir` and
 * `--work-tree`. Returns a fresh argv prefix in the same order the
 * flags appeared so callers can compose it with the rest of their
 * argv unchanged.
 *
 * Both inline (`--git-dir=/path`) and separate (`--git-dir /path`)
 * forms are recognised. Unrecognised git-level flags are ignored
 * because they have no impact on `git remote get-url`'s repo
 * resolution.
 */
const REPO_CONTEXT_VALUE_FLAGS = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
]);

const REPO_CONTEXT_INLINE_PREFIXES = [
  '--git-dir=',
  '--work-tree=',
];

export function extractRepoContextFlags(gitArgs) {
  if (!Array.isArray(gitArgs)) return [];
  const out = [];
  for (let i = 0; i < gitArgs.length; i++) {
    const a = gitArgs[i];
    if (typeof a !== 'string') continue;
    if (REPO_CONTEXT_VALUE_FLAGS.has(a)) {
      const v = gitArgs[i + 1];
      if (typeof v === 'string') {
        out.push(a, v);
        i += 1;
      }
      continue;
    }
    for (const prefix of REPO_CONTEXT_INLINE_PREFIXES) {
      if (a.startsWith(prefix)) {
        out.push(a);
        break;
      }
    }
  }
  return out;
}

/**
 * Detect when a "remote" positional in a `git fetch` / `git pull` /
 * `git ls-remote` / `git clone` invocation is already an HTTPS URL
 * pointing at github.com, rather than a configured remote NAME (like
 * `origin`). Returns the canonical URL form (with .git suffix
 * normalised) when it is, or null otherwise.
 *
 * Used by the wrapper's retry path so that
 * `git-as lag-ceo fetch https://github.com/o/r.git main` can build
 * the x-access-token retry URL directly instead of trying to look
 * up "https://github.com/o/r.git" as a remote name (which `git
 * remote get-url` would treat as a literal name and fail to
 * resolve).
 *
 * Scope: github.com HTTPS only. SSH (`git@github.com:...`),
 * enterprise hosts, and protocol-less shortcuts (`o/r`) all return
 * null so the caller falls through to `git remote get-url`.
 */
export function detectGithubHttpsRemoteUrl(remoteCandidate) {
  if (typeof remoteCandidate !== 'string') return null;
  const parsed = parseGithubHttps(remoteCandidate);
  if (parsed === null) return null;
  // Re-emit in the canonical .git form so downstream URL builders
  // get a uniform shape.
  return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
}

/**
 * Compute the gitArgs to spawn for the URL-auth retry of a fetch /
 * pull / ls-remote that hit a 401 on the Bearer path. Returns null
 * when:
 *
 *   - The verb is not a read-only remote verb (caller routes through
 *     buildPushSpawnArgs or stays on the Bearer path).
 *   - The verb is `clone`  --  the URL is persisted into the new
 *     repo's `.git/config` so substituting an x-access-token URL
 *     would leak the token on disk (PR #169 fix invariant).
 *   - The resolved remote URL is not an https://github.com/... URL
 *     (SSH, enterprise, or unresolvable  --  the x-access-token form
 *     only authenticates against github.com per GitHub App contract).
 *   - There is no remote positional in the argv (bare `git fetch`
 *     relies on the configured upstream of the current branch; the
 *     wrapper surfaces a clear error rather than rewriting the
 *     wrong thing).
 *
 * Pure: no side effects. Mirrors the buildPushSpawnArgs contract so
 * the two URL-rewrite paths share one test-shape.
 */
export function buildFetchUrlAuthArgs(gitArgs, resolvedRemoteUrl, token) {
  const slot = findReadOnlyRemoteSlot(gitArgs);
  if (slot === null) return null;
  // clone persists the remote URL into the new repo's .git/config
  // as remote.origin.url. Substituting an x-access-token URL on
  // argv would leak the token on disk (PR #169 leak shape).
  // Fall through to the Bearer path  --  clone on Bearer works
  // because GitHub accepts Bearer on upload-pack for the initial
  // clone; the 401-only-on-fetch failure mode this helper exists
  // to handle does not apply to clone.
  if (slot.verb === 'clone') return null;
  const parsed = parseGithubHttps(resolvedRemoteUrl ?? '');
  if (parsed === null) return null;
  const transient = buildTransientPushUrl({
    owner: parsed.owner,
    repo: parsed.repo,
    token,
  });
  const next = gitArgs.slice();
  next[slot.remoteIndex] = transient;
  return next;
}

/**
 * Detect git's stderr signature for "Bearer auth was rejected by
 * github.com" so the wrapper knows whether to retry with x-access-
 * token URL auth.
 *
 * Why this is a separate helper
 * -----------------------------
 * GitHub's smart-HTTP receive-pack and upload-pack endpoints
 * reject `Authorization: Bearer <token>` with HTTP 401 plus a
 * `www-authenticate: Basic realm="GitHub"` challenge. Git surfaces
 * this to stderr in one of several shapes depending on whether
 * GIT_TRACE / GIT_CURL_VERBOSE are set and which fallback path
 * git tried after the 401:
 *
 *   Direct 401 shapes (visible without GIT_TRACE on some git
 *   versions, always visible with GIT_CURL_VERBOSE=1):
 *     - `fatal: unable to access ...: The requested URL returned error: 401`
 *     - `remote: error: 401 ...`
 *     - `fatal: unable to access ... www-authenticate: Basic realm="GitHub"`
 *
 *   Indirect shapes (silent 401, git falls through to credential
 *   helper which we've disabled, then to askpass which we've
 *   neutralized, and finally surfaces as the helper-fallback
 *   failure):
 *     - `fatal: could not read Username for 'https://github.com':
 *        terminal prompts disabled`
 *     - `fatal: Authentication failed for 'https://github.com/...'`
 *
 * The indirect shape is what production usually sees: the wrapper
 * already disables credential.helper and askpass to prevent the
 * 30s helper-stall on Cursor-managed Windows hosts, which means a
 * 401 that would otherwise prompt the operator surfaces as the
 * helper-disabled error instead. Either shape is the same signal
 * "the primary Bearer path failed against github.com auth".
 *
 * Scope
 * -----
 *   - Only matches signals scoped to github.com. A 401 against an
 *     enterprise host is real; retrying with our github.com
 *     installation token would (a) fail anyway and (b) ship the
 *     token to a host outside its grant scope.
 *   - A 403, 404, or network timeout is NOT a Bearer rejection;
 *     the retry would fail identically and waste a request budget.
 *   - Case-insensitive on the auth-keyword (real reproductions
 *     have mixed cases depending on git's transport layer).
 */
const BEARER_401_HINTS = [
  /\bHTTP\s*\/?\d*\.?\d*\s+401\b/i,
  /\breturned\s+error:\s*401\b/i,
  /\berror:\s*401\b/i,
  /\b401\s+Unauthorized\b/i,
  /www-authenticate:\s*Basic/i,
];

// Indirect helper-disabled signature: git falls through to the
// credential helper after a 401, the helper is disabled, askpass is
// neutralized, and git surfaces the failure as "could not read
// Username" or "Authentication failed". Scoped to a github.com URL
// in the message so an enterprise-host equivalent does not trigger
// the github.com retry path.
const HELPER_DISABLED_GITHUB_RE = /(?:could\s+not\s+read\s+(?:Username|Password)\s+for\s+'https?:\/\/(?:[^'@]+@)?github\.com|Authentication\s+failed\s+for\s+'https?:\/\/(?:[^'@]+@)?github\.com)/i;

const NON_GITHUB_HOST_RE = /\bhttps?:\/\/(?!github\.com\b)[A-Za-z0-9.-]+/i;

export function isBearerRejection401(stderrText) {
  if (typeof stderrText !== 'string' || stderrText.length === 0) return false;
  // Indirect helper-disabled signature is unambiguous on its own
  // because the URL pattern in the regex is anchored to github.com.
  // Check it BEFORE the non-github reject so an unrelated mention
  // of an enterprise URL elsewhere in the stderr does not gate the
  // genuine github.com auth failure out.
  if (HELPER_DISABLED_GITHUB_RE.test(stderrText)) return true;
  // Reject 401s from non-github hosts. The token is a GitHub App
  // installation token; retrying an enterprise-host fetch with the
  // x-access-token form would (a) fail anyway and (b) ship the
  // token to a host outside its grant scope.
  if (NON_GITHUB_HOST_RE.test(stderrText)) return false;
  // www-authenticate: Basic is itself the smoking gun  --  it means
  // a server returned a Basic challenge in response to our Bearer.
  if (/www-authenticate:\s*Basic/i.test(stderrText)) return true;
  // Otherwise require an explicit 401 marker. The non-github host
  // filter above already scoped us to github.com URLs (or a 401
  // with no URL context, which on this code path is also a github
  // call because the wrapper only auths against github.com). A
  // github-scoped 401 alone is sufficient signal to attempt the
  // x-access-token retry  --  the retry is safe (it tries a different
  // auth scheme against the same host) and the AUTH_KEYWORD_RE
  // check that previously sat here was a no-op next to hasAny401.
  if (BEARER_401_HINTS.some((re) => re.test(stderrText))) return true;
  // Tertiary signal: explicit "Authorization" / "Authentication"
  // keyword without a 401 marker is too generic to act on (covers
  // permission errors, scope rejections, etc. that x-access-token
  // would not fix). Require either the explicit 401 or the helper-
  // disabled fallback shape captured above.
  return false;
}

