/**
 * Shared helper: resolve the (owner, repo) tuple a downstream gh
 * invocation needs. Centralizes the lookup so multiple sibling
 * scripts (bin/lag-run-loop.js, scripts/invokers/autonomous-dispatch
 * variants, scripts/run-pr-* helpers) share one canonical resolution
 * shape rather than each carrying a near-duplicate copy.
 *
 * Resolution order (first match wins):
 *
 *   1. The optional `slug` argument (e.g. parsed from a CLI flag).
 *      Lets a caller pin the value explicitly without an env hop.
 *   2. The `GH_REPO` env var. The conventional cross-script
 *      override; spelled the same way as the gh CLI's own slug.
 *   3. `gh repo view --json owner,name` against the cwd. The
 *      zero-config path for callers running inside a clone.
 *
 * Returns `{ owner, repo }` on success, `null` when nothing matched
 * (no env, no slug, no gh, or gh returned a malformed payload). The
 * caller decides whether a null is fatal (autonomous-dispatch throws)
 * or silent-skip (the LoopRunner orphan reconcile pass logs once).
 *
 * Substrate purity: the helper is mechanism-only. It never imports a
 * GitHub adapter, never enforces a specific bot identity, and never
 * caches across calls; each call is self-contained so a deployment
 * that changes its `GH_REPO` mid-run picks up the new value on the
 * next call.
 */

import { execa } from 'execa';

/**
 * Parse a `<owner>/<repo>` slug into an `{ owner, repo }` tuple.
 * Returns `null` for empty / malformed input. Tolerant of trailing
 * whitespace (operators paste this into shell rc files; a stray
 * newline shouldn't break resolution).
 *
 * @param {unknown} raw
 * @returns {{owner: string, repo: string} | null}
 */
export function parseRepoSlug(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Resolve `(owner, repo)` from the explicit slug, env, or
 * `gh repo view`. Returns `null` on failure; the caller chooses how
 * to react.
 *
 * @param {{
 *   slug?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   ghBin?: string,
 * }} [options]
 * @returns {Promise<{owner: string, repo: string} | null>}
 */
export async function resolveOwnerRepo(options = {}) {
  const env = options.env ?? process.env;
  const fromSlug = parseRepoSlug(options.slug);
  if (fromSlug) return fromSlug;
  const fromEnv = parseRepoSlug(env['GH_REPO']);
  if (fromEnv) return fromEnv;
  const ghBin = options.ghBin ?? 'gh';
  // reject:false suppresses non-zero exits; execa still throws ENOENT
  // when the binary is absent (gh not installed). Both paths produce
  // a null return so callers see one canonical "not resolvable"
  // signal and choose their own response (silent-skip vs. throw).
  try {
    const result = await execa(
      ghBin,
      ['repo', 'view', '--json', 'owner,name'],
      { reject: false, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
    );
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    if (!parsed?.owner?.login || !parsed?.name) return null;
    return { owner: parsed.owner.login, repo: parsed.name };
  } catch {
    return null;
  }
}
