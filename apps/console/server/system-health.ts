/*
 * Pure helpers for the bot-identity health handler. Extracted from
 * server/index.ts so the unit tests can drive the logic without
 * spinning up the HTTP listener.
 *
 * Why a Console-side health surface: when a bot identity's GitHub App
 * loses its installation, has its private key rotated, or sees a
 * GitHub-side App revocation, the failure mode today is silent until
 * the next push or PR creation hits 401. The Console projection turns
 * that silent failure into a visible row the operator can pattern-
 * match before a 3am incident.
 *
 * Mechanism: each provisioned role under `.lag/apps/<role>.json` plus
 * the matching `.lag/apps/keys/<role>.pem` carries the GitHub App id
 * + installation id + private key. The token-mint endpoint
 * (`POST /app/installations/<id>/access_tokens`) round-trips that to
 * a short-lived access token + an explicit `expires_at`. We treat the
 * round-trip itself as the health check:
 *   - 201 with a token in the body -> status='fresh'
 *   - 401 / 403 / 404 / other 4xx -> status='stale' (credential bad)
 *   - timeout / network failure / 5xx -> status='network-error'
 *     (caller does NOT treat this as a hard fail; the next tick may
 *      succeed once GitHub's API recovers)
 *
 * Read-only contract: this helper mints a token to verify auth, but
 * does NOT use the token for any write. The token expires inside an
 * hour; the response surface does not echo the token value. The
 * Console read-only invariant per its CLAUDE.md is preserved.
 *
 * Injects `fetch`, `now`, and `loadRoleCredentials` so tests can drive
 * the helper without filesystem state or live GitHub calls.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSign } from 'node:crypto';

/**
 * Roles the Console health check probes. These are the four
 * canonical provisioned bot identities in this repository:
 *   - lag-ceo:        operator-proxy (PR-open, merge, comments)
 *   - lag-cto:        decision-bearing planning identity
 *   - lag-pr-landing: CR-handling and review-thread replies
 *   - lag-actors:     reserved per provisioning roadmap; absent when
 *                     the role has not been provisioned yet, which
 *                     surfaces as kind='not-provisioned' rather than
 *                     a stale credential
 *
 * The shape is a tuple of strings (not a free-form list) so the
 * frontend can render a deterministic header order regardless of
 * filesystem listing order. Adding a new bot identity to the org is
 * a conscious canon-edit moment that updates this tuple paired with
 * a `.lag/apps/<new-role>.json` provisioning sync.
 */
export const PROBED_ROLES = [
  'lag-ceo',
  'lag-cto',
  'lag-pr-landing',
  'lag-actors',
] as const;

export type ProbedRole = (typeof PROBED_ROLES)[number];

/**
 * Identity status the UI renders as a pill.
 *   - fresh:          token mint succeeded, identity authenticates
 *   - stale:          credentials present but mint returned 4xx; the
 *                     bot's GitHub App installation needs attention
 *   - network-error:  transient failure (timeout, 5xx, DNS); the next
 *                     health tick may succeed
 *   - not-provisioned: no `.lag/apps/<role>.json` record exists; the
 *                     role has never been wired up locally
 */
export type IdentityStatus = 'fresh' | 'stale' | 'network-error' | 'not-provisioned';

export interface BotIdentityHealth {
  readonly role: ProbedRole;
  /** GitHub App slug (the `<slug>[bot]` login appears on PRs). */
  readonly login: string | null;
  /** GitHub App numeric id, or null when not provisioned. */
  readonly appId: number | null;
  /** Installation id, or null when not provisioned or not installed. */
  readonly installationId: number | null;
  /** Token expiry ISO string, or null when no token was minted. */
  readonly expiresAt: string | null;
  readonly status: IdentityStatus;
  /** ISO timestamp the probe ran. */
  readonly lastCheckedAt: string;
  /** Milliseconds between expiresAt and lastCheckedAt (when both set). */
  readonly ageMs: number | null;
  /** Human-readable detail for stale / network-error rows. */
  readonly detail: string | null;
}

export interface BotIdentityHealthResponse {
  readonly identities: ReadonlyArray<BotIdentityHealth>;
}

/*
 * The shape of an `.lag/apps/<role>.json` record. Mirrors
 * AppCredentialsRecord from src/runtime/actors/provisioning/credentials-store.ts
 * but kept duplicated here so the Console server has zero runtime
 * dependency on the framework's compiled `dist/`. This is the price
 * of the Console being a separate process; the duplication is small
 * and reviewer-discoverable.
 */
export interface RoleCredentials {
  readonly record: {
    readonly role: string;
    readonly appId: number;
    readonly slug: string;
    readonly installationId?: number;
  };
  readonly privateKey: string;
}

/**
 * Default load function: reads `.lag/apps/<role>.json` plus
 * `.lag/apps/keys/<role>.pem`, returns null when either is absent.
 * Injected as `loadRoleCredentials` so tests pass a stub without
 * touching the filesystem.
 */
export async function defaultLoadRoleCredentials(
  lagDir: string,
  role: ProbedRole,
): Promise<RoleCredentials | null> {
  const recordPath = join(lagDir, 'apps', `${role}.json`);
  const keyPath = join(lagDir, 'apps', 'keys', `${role}.pem`);
  if (!existsSync(recordPath)) return null;
  if (!existsSync(keyPath)) return null;
  const [json, pem] = await Promise.all([
    readFile(recordPath, 'utf8'),
    readFile(keyPath, 'utf8'),
  ]);
  let record: RoleCredentials['record'];
  try {
    record = JSON.parse(json) as RoleCredentials['record'];
  } catch {
    return null;
  }
  if (typeof record?.appId !== 'number' || typeof record?.slug !== 'string') {
    return null;
  }
  return { record, privateKey: pem };
}

/*
 * Create a short-lived (9-minute) App JWT signed with the role's
 * private key. Duplicated from src/external/github-app/app-auth.ts to
 * keep the Console server free of a `dist/` import; the algorithm is
 * fixed by GitHub's API spec so drift is unlikely. If the upstream
 * helper ever changes a constant (skew window, exp horizon) the
 * Console copy should follow.
 */
function createAppJwt(opts: {
  readonly appId: number;
  readonly privateKey: string;
  readonly nowMs: number;
}): string {
  const nowSec = Math.floor(opts.nowMs / 1000);
  const iat = nowSec - 30; // 30s skew protection
  const exp = nowSec + 9 * 60; // 9 minutes, under GitHub's 10-min cap
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: opts.appId };
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(opts.privateKey)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${unsigned}.${signature}`;
}

export interface ProbeIdentityOpts {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly loadRoleCredentials?: (lagDir: string, role: ProbedRole) => Promise<RoleCredentials | null>;
}

/**
 * Probe a single bot identity. Returns the row the API surfaces in
 * `{ identities: [...] }`. Never throws: filesystem absences become
 * `not-provisioned`, credential issues become `stale`, transient
 * failures become `network-error`. The handler aggregates one row
 * per role; a single bad row does not poison the whole response.
 *
 * The token returned by GitHub is intentionally discarded after the
 * status determination. The Console never holds an installation
 * token in memory longer than the immediate function scope so a
 * memory dump of the running process does not leak active creds.
 */
export async function probeBotIdentity(
  lagDir: string,
  role: ProbedRole,
  opts: ProbeIdentityOpts = {},
): Promise<BotIdentityHealth> {
  const nowFn = opts.now ?? (() => Date.now());
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const loadFn = opts.loadRoleCredentials ?? defaultLoadRoleCredentials;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const nowMs = nowFn();
  const lastCheckedAt = new Date(nowMs).toISOString();

  let creds: RoleCredentials | null;
  try {
    creds = await loadFn(lagDir, role);
  } catch (err) {
    return {
      role,
      login: null,
      appId: null,
      installationId: null,
      expiresAt: null,
      status: 'stale',
      lastCheckedAt,
      ageMs: null,
      detail: `load failed: ${(err as Error).message}`,
    };
  }
  if (creds === null) {
    return {
      role,
      login: null,
      appId: null,
      installationId: null,
      expiresAt: null,
      status: 'not-provisioned',
      lastCheckedAt,
      ageMs: null,
      detail: null,
    };
  }
  const installationId = creds.record.installationId;
  if (typeof installationId !== 'number') {
    return {
      role,
      login: creds.record.slug,
      appId: creds.record.appId,
      installationId: null,
      expiresAt: null,
      status: 'stale',
      lastCheckedAt,
      ageMs: null,
      detail: 'role provisioned but not installed on any repository',
    };
  }

  let jwt: string;
  try {
    jwt = createAppJwt({
      appId: creds.record.appId,
      privateKey: creds.privateKey,
      nowMs,
    });
  } catch (err) {
    return {
      role,
      login: creds.record.slug,
      appId: creds.record.appId,
      installationId,
      expiresAt: null,
      status: 'stale',
      lastCheckedAt,
      ageMs: null,
      detail: `jwt-sign failed: ${(err as Error).message}`,
    };
  }

  let response: Response;
  try {
    response = await fetchFn(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'lag-console/system-health',
        },
      },
    );
  } catch (err) {
    const isTimeout = (err as Error & { name?: string })?.name === 'TimeoutError'
      || (err as Error & { name?: string })?.name === 'AbortError';
    const label = isTimeout ? `timeout after ${timeoutMs}ms` : 'fetch failed';
    return {
      role,
      login: creds.record.slug,
      appId: creds.record.appId,
      installationId,
      expiresAt: null,
      status: 'network-error',
      lastCheckedAt,
      ageMs: null,
      detail: `${label}: ${(err as Error)?.message ?? err}`,
    };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // body unreadable; status is the only signal we have left
    }
    if (response.status >= 500) {
      return {
        role,
        login: creds.record.slug,
        appId: creds.record.appId,
        installationId,
        expiresAt: null,
        status: 'network-error',
        lastCheckedAt,
        ageMs: null,
        detail: `HTTP ${response.status}: ${detail}`,
      };
    }
    return {
      role,
      login: creds.record.slug,
      appId: creds.record.appId,
      installationId,
      expiresAt: null,
      status: 'stale',
      lastCheckedAt,
      ageMs: null,
      detail: `HTTP ${response.status}: ${detail}`,
    };
  }

  let parsed: { token?: string; expires_at?: string };
  try {
    parsed = (await response.json()) as { token?: string; expires_at?: string };
  } catch (err) {
    return {
      role,
      login: creds.record.slug,
      appId: creds.record.appId,
      installationId,
      expiresAt: null,
      status: 'stale',
      lastCheckedAt,
      ageMs: null,
      detail: `unparseable response: ${(err as Error).message}`,
    };
  }

  const expiresAtRaw = typeof parsed.expires_at === 'string' ? parsed.expires_at : null;
  let expiresAtIso: string | null = null;
  let ageMs: number | null = null;
  if (expiresAtRaw !== null) {
    const expMs = Date.parse(expiresAtRaw);
    if (Number.isFinite(expMs)) {
      expiresAtIso = new Date(expMs).toISOString();
      ageMs = expMs - nowMs;
    }
  }

  return {
    role,
    login: creds.record.slug,
    appId: creds.record.appId,
    installationId,
    expiresAt: expiresAtIso,
    status: 'fresh',
    lastCheckedAt,
    ageMs,
    detail: null,
  };
}

/**
 * Probe every role in PROBED_ROLES concurrently and shape the
 * response. Concurrency is bounded by the (small) tuple size; we do
 * not need a worker pool here because GitHub's installation-token
 * endpoint tolerates 4 parallel requests trivially.
 *
 * Returns the rows in PROBED_ROLES order so the UI renders a stable
 * sequence regardless of how fast each probe completes.
 */
export async function buildBotIdentityHealth(
  lagDir: string,
  opts: ProbeIdentityOpts = {},
): Promise<BotIdentityHealthResponse> {
  const rows = await Promise.all(
    PROBED_ROLES.map((role) => probeBotIdentity(lagDir, role, opts)),
  );
  return { identities: rows };
}
