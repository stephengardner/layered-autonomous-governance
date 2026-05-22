// Token health preflight helpers.
//
// Centralizes the "is this PAT still good?" check that every PAT-using
// script otherwise re-implements. The canonical surface is
// `checkPatHealth(token, {fetch, now})` which returns a discriminated
// status object plus an optional warning string the caller writes to
// stderr.
//
// Why this seam: 2026-05-22 session lost ~10 minutes when LAG_OPS_PAT
// silently expired. cr-trigger.mjs blew up at request time with HTTP
// 401 with no warning ahead of time. A preflight check on every PAT
// use (a) catches expired tokens before the substrate makes the
// failing request and (b) warns when the token is < N days from
// expiry so the operator can rotate without the next surprise outage.
// Cost: one `GET /user` per invocation (free, ungated by rate limits
// in practice; the PAT use that follows would have made a request
// anyway).
//
// Fine-grained PATs return the expiration via the
// `github-authentication-token-expiration` response header (per GitHub
// docs). Classic PATs do not return that header. The helper returns
// `expiresAt: null` for classic tokens and skips the days-to-expiry
// warning; the identity-check still runs.

/**
 * Default soft-warning floor for token expiration: 7 days.
 *
 * Why 7 days: gives the operator a working week to notice and rotate
 * the PAT without an outage. Tighter floors (1-2 days) miss weekend
 * gaps; wider floors (14-30 days) saturate with noise from any token
 * with a multi-month expiry. The floor is tunable via the
 * `warnDaysFromExpiry` option on `checkPatHealth` so an org-ceiling
 * deployment running with shorter-lived PATs can dial it in.
 */
export const DEFAULT_WARN_DAYS_FROM_EXPIRY = 7;

/**
 * Run the PAT health preflight.
 *
 * Returns one of three discriminated kinds:
 *   - `{kind: 'ok', identity, expiresAt, daysToExpiry, warning}` when
 *     the token authenticates against `GET /user`. `expiresAt` is the
 *     ISO string from the auth-token-expiration response header
 *     (fine-grained PATs) or null (classic PATs). `daysToExpiry` is a
 *     non-negative integer when `expiresAt` is set, otherwise null.
 *     `warning` is a human-readable string when `daysToExpiry` is set
 *     and below the warn floor, otherwise null.
 *   - `{kind: 'invalid', status, detail}` on HTTP 401 (expired or
 *     revoked token) or any other 4xx response.
 *   - `{kind: 'network-error', detail}` on fetch errors / timeouts.
 *
 * Callers act on the kind: 'ok' proceeds (writing the warning to
 * stderr when present); 'invalid' surfaces the renewal steps and
 * exits; 'network-error' is treated as transient (the caller may
 * proceed and let the downstream request fail or escalate).
 *
 * Injects `fetch` and `now` so tests can drive the helper without
 * spawning a real HTTP call or relying on system time. Production
 * callers pass nothing and the defaults (global fetch, Date.now)
 * apply.
 */
export async function checkPatHealth(token, opts = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const nowFn = opts.now ?? (() => Date.now());
  const warnDaysFromExpiry = opts.warnDaysFromExpiry ?? DEFAULT_WARN_DAYS_FROM_EXPIRY;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (typeof token !== 'string' || token.trim().length === 0) {
    return { kind: 'invalid', status: 0, detail: 'empty token' };
  }

  let response;
  try {
    response = await fetchFn('https://api.github.com/user', {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token.trim()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lag-token-health/preflight',
      },
    });
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const label = isTimeout ? `timeout after ${timeoutMs}ms` : 'fetch failed';
    return { kind: 'network-error', detail: `${label}: ${err?.message ?? err}` };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // body unreadable; status is the only signal we have left
    }
    // 5xx is a transient server outage (GitHub API down, gateway
    // hiccup), not an authentication failure. Surface it as
    // network-error so the caller treats it the same as a fetch
    // exception: proceed and let the downstream request retry. A real
    // expired-or-revoked token will surface as 401; routing 5xx to
    // 'invalid' would prompt the operator with renewal steps during a
    // GitHub outage when their PAT is fine.
    if (response.status >= 500) {
      return { kind: 'network-error', detail: `HTTP ${response.status}: ${detail}` };
    }
    return { kind: 'invalid', status: response.status, detail };
  }

  let identity = '';
  try {
    const json = await response.json();
    identity = typeof json?.login === 'string' ? json.login : '';
  } catch {
    // body unreadable; identity stays empty but kind=ok because the
    // status is 200. Downstream callers do not depend on identity for
    // correctness; it is a presentation field.
  }

  // GitHub returns `github-authentication-token-expiration` on
  // fine-grained PATs. Header lookup is case-insensitive per RFC; the
  // fetch Headers object handles that. Classic PATs omit the header,
  // in which case expiresAt stays null and daysToExpiry is not
  // computed.
  const expHeader = response.headers.get('github-authentication-token-expiration');
  let expiresAt = null;
  let daysToExpiry = null;
  let warning = null;
  if (typeof expHeader === 'string' && expHeader.length > 0) {
    const parsed = Date.parse(expHeader);
    if (Number.isFinite(parsed)) {
      expiresAt = new Date(parsed).toISOString();
      const diffMs = parsed - nowFn();
      daysToExpiry = Math.max(0, Math.floor(diffMs / 86_400_000));
      if (daysToExpiry <= warnDaysFromExpiry) {
        warning =
          `token expires in ${daysToExpiry} day(s) (at ${expiresAt}); `
          + 'rotate at https://github.com/settings/tokens before it expires '
          + 'to avoid an outage.';
      }
    }
  }

  return { kind: 'ok', identity, expiresAt, daysToExpiry, warning };
}

/**
 * Format a human-readable renewal instruction for an invalid token.
 * Separates the wording from `checkPatHealth` so callers can render
 * the same recovery steps consistently across scripts. Operators see
 * the identical message regardless of which PAT-using script
 * surfaced the 401.
 */
export function renewalInstructionsFor(envVarName, machineUser = 'layered-autonomous-governance') {
  return (
    `${envVarName} authentication failed (HTTP 401). The token is expired or revoked.\n`
    + `\n`
    + `Renewal steps:\n`
    + `  1. Log in to GitHub as the ${machineUser} machine user (NOT your personal account).\n`
    + `  2. Open https://github.com/settings/tokens and click "Generate new token".\n`
    + `  3. Grant the minimum scope the wrapper needs (Pull requests: Read and write\n`
    + `     for cr-trigger; broader scopes only if a different script needs them).\n`
    + `  4. Set expiration to 90 days so the next preflight catches drift early.\n`
    + `  5. Paste the new token into .env at the existing ${envVarName}= line.\n`
    + `  6. Re-run the command that failed.\n`
  );
}
