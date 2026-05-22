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

import { readFile, readdir, statfs } from 'node:fs/promises';
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

  /*
   * Validate the response body has the shape GitHub documents. A 201
   * with an empty / non-string `token` field is a malformed-success
   * response (e.g. an upstream proxy stripped the body, or a future
   * API revision drops the field). Treating that as `fresh` would
   * misclassify a broken auth pipeline as healthy. Surface it as
   * `stale` so the operator notices the row and investigates.
   */
  const hasToken = typeof parsed.token === 'string' && parsed.token.length > 0;
  if (!hasToken) {
    return {
      role,
      login: creds.record.slug,
      appId: creds.record.appId,
      installationId,
      expiresAt: null,
      status: 'stale',
      lastCheckedAt,
      ageMs: null,
      detail: 'missing token in GitHub token-mint response',
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

// ---------------------------------------------------------------------------
// Substrate-probe family
//
// Three additional probes complete the System Health page promised at
// `apps/console/src/features/system-health/SystemHealthView.tsx`. Each is
// a pure function with injected dependencies so the tests can drive
// every status branch without filesystem or network state. The probe
// row shape (`ProbeRow`) is shared across all three; the bot-identity
// surface keeps its richer row type for back-compat.
//
//   - claim-reaper-cadence: green when the LoopRunner's reaper-pass
//     has emitted a `claim-reaper-sweep-completed` heartbeat atom in
//     the last 2x configured tick interval; yellow at 2-5x; red beyond.
//   - tunnel-reachability: green when the cloudflared metrics endpoint
//     resolves a hostname; yellow on transient network failure; red on
//     no-tunnel.
//   - atom-store-free-space: green at >5% free on the atoms partition;
//     yellow at 1-5%; red <1%.
//
// Mechanism, not policy: the thresholds live as named constants below;
// org-ceiling deployments tune them via a future canon-policy reader
// (per `dev-substrate-not-prescription` the seam stays minimal until a
// second use case asks).
// ---------------------------------------------------------------------------

/**
 * Traffic-light status the UI renders as a colored row pill. Distinct
 * from `IdentityStatus` because the four bot-identity outcomes do not
 * map 1:1 to a three-color severity scale (e.g. `not-provisioned` is
 * neutral, not green/yellow/red).
 */
export type ProbeStatus = 'green' | 'yellow' | 'red';

/**
 * Shared row shape for all substrate probes. The UI renders one
 * <li> per row in the same masonry style as bot-identity, with the
 * pill colored by `status`, the summary read out, the detail used as
 * the tooltip + collapsed-text body, and the runbook deep-link
 * surfaced as a "view runbook" action.
 *
 * `lastCheckedAt` is the ISO timestamp at which the probe ran; the
 * Console refresh cadence (30s) drives a fresh check per poll.
 */
export interface ProbeRow {
  readonly id: 'claim-reaper-cadence' | 'tunnel-reachability' | 'atom-store-free-space';
  readonly status: ProbeStatus;
  readonly summary: string;
  readonly detail: string;
  readonly runbookHref: string;
  readonly lastCheckedAt: string;
}

/**
 * Default tick interval (ms) used to bound the claim-reaper-cadence
 * probe's freshness window. Mirrors the indie-floor default seeded by
 * `scripts/lib/claim-contract-canon-policies.mjs`
 * (kind='claim-reaper-cadence-ms', value=60000). The probe reads the
 * runtime canon value when available; this constant is the fallback
 * when canon is unseeded so a fresh deployment still gets a sensible
 * probe behaviour.
 */
export const DEFAULT_CLAIM_REAPER_CADENCE_MS = 60_000;

/**
 * Default cloudflared quick-tunnel metrics port. cloudflared without an
 * explicit `--metrics` flag binds to one of localhost:20241..20245 in
 * order; the first port in that sequence is the canonical probe target.
 * Operators running a non-default metrics port set
 * `LAG_TUNNEL_METRICS_PORT` to override.
 */
export const DEFAULT_TUNNEL_METRICS_PORT = 20241;

/**
 * Free-space severity thresholds for the atoms partition. >5% is
 * healthy operating headroom for a long-running LAG deployment; 1-5%
 * is yellow because atom growth is steady-state and ENOSPC arrives
 * within hours; <1% is red because the next file-adapter write may
 * fail.
 */
export const ATOM_STORE_GREEN_FREE_PCT = 5;
export const ATOM_STORE_YELLOW_FREE_PCT = 1;

/**
 * Minimal atom shape the claim-reaper probe reads. Mirrors the JSON
 * persisted under `.lag/atoms/` without importing the framework
 * substrate types (Console server keeps its zero-dependency posture
 * per the file's lead docstring). Only the three fields the probe
 * consults are typed; any extra fields are ignored.
 */
export interface ProbeAtom {
  readonly id: string;
  readonly type: string;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown> | null;
}

export interface ProbeClaimReaperOpts {
  /** Now-injection for deterministic tests. */
  readonly now?: () => number;
  /** Atom-source injection: a snapshot of the atom store. */
  readonly loadAtoms?: () => Promise<ReadonlyArray<ProbeAtom>>;
  /**
   * Cadence override (ms). Defaults to
   * `DEFAULT_CLAIM_REAPER_CADENCE_MS` when not supplied; the caller
   * threads the canon-resolved value through this seam so the probe
   * does not duplicate the canon-policy reader path.
   */
  readonly cadenceMs?: number;
}

/**
 * Probe the claim-reaper cadence. Reads the most recent
 * `claim-reaper-sweep-completed` atom (observation-type, written by
 * `runClaimReaperTick` once per non-halted tick) and compares the
 * elapsed-since-last-sweep against the configured cadence.
 *
 *   green   : elapsed < 2x cadence  (sweep ran recently)
 *   yellow  : 2x <= elapsed < 5x    (sweep is slow or skipping)
 *   red     : elapsed >= 5x         (sweep is offline)
 *
 * No-atom-found defaults to red because a fresh deployment with the
 * reaper pass disabled is exactly the operator-visible state this
 * probe is meant to surface. The runbook deep-link routes to
 * `docs/runbooks/reaper-not-running.md` so the operator sees the
 * playbook directly from the dashboard.
 */
export async function probeClaimReaperCadence(
  opts: ProbeClaimReaperOpts = {},
): Promise<ProbeRow> {
  const nowFn = opts.now ?? (() => Date.now());
  const loadFn = opts.loadAtoms ?? (async () => []);
  const cadenceMs = opts.cadenceMs ?? DEFAULT_CLAIM_REAPER_CADENCE_MS;
  const nowMs = nowFn();
  const lastCheckedAt = new Date(nowMs).toISOString();

  let atoms: ReadonlyArray<ProbeAtom>;
  try {
    atoms = await loadFn();
  } catch (err) {
    return {
      id: 'claim-reaper-cadence',
      status: 'red',
      summary: 'Atom load failed',
      detail: `Could not read atoms to probe reaper cadence: ${(err as Error).message}`,
      runbookHref: '/docs/runbooks/reaper-not-running.md',
      lastCheckedAt,
    };
  }

  /*
   * The reaper writes one heartbeat per non-halted tick keyed by
   * type='claim-reaper-sweep-completed'. We take the max created_at
   * across all such atoms; an absent set is treated as "never ran"
   * which surfaces as red rather than silently passing through to
   * green.
   */
  let mostRecentMs = -Infinity;
  let mostRecentId: string | null = null;
  for (const a of atoms) {
    if (a.type !== 'claim-reaper-sweep-completed') continue;
    const ts = Date.parse(a.created_at);
    if (!Number.isFinite(ts)) continue;
    if (ts > mostRecentMs) {
      mostRecentMs = ts;
      mostRecentId = a.id;
    }
  }
  if (mostRecentMs === -Infinity) {
    return {
      id: 'claim-reaper-cadence',
      status: 'red',
      summary: 'No reaper heartbeat observed',
      detail:
        'No claim-reaper-sweep-completed atom found. The LoopRunner reaper'
        + ' pass may be disabled or the loop process may be down.',
      runbookHref: '/docs/runbooks/reaper-not-running.md',
      lastCheckedAt,
    };
  }

  const elapsedMs = Math.max(0, nowMs - mostRecentMs);
  const elapsedRatio = elapsedMs / cadenceMs;
  let status: ProbeStatus;
  let summary: string;
  if (elapsedRatio < 2) {
    status = 'green';
    summary = `Reaper swept ${formatElapsed(elapsedMs)} ago`;
  } else if (elapsedRatio < 5) {
    status = 'yellow';
    summary = `Reaper slow (${formatElapsed(elapsedMs)} since last sweep)`;
  } else {
    status = 'red';
    summary = `Reaper offline (${formatElapsed(elapsedMs)} since last sweep)`;
  }
  return {
    id: 'claim-reaper-cadence',
    status,
    summary,
    detail:
      `Last sweep: ${new Date(mostRecentMs).toISOString()}`
      + ` (cadence: ${cadenceMs}ms, atom: ${mostRecentId ?? 'unknown'})`,
    runbookHref: '/docs/runbooks/reaper-not-running.md',
    lastCheckedAt,
  };
}

export interface ProbeTunnelOpts {
  /** Now-injection. */
  readonly now?: () => number;
  /** Fetch-injection. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Metrics port override; defaults to
   * `DEFAULT_TUNNEL_METRICS_PORT`. Production wiring threads
   * `process.env.LAG_TUNNEL_METRICS_PORT` here.
   */
  readonly metricsPort?: number;
  /** Per-call timeout. Defaults to 2_000ms (a tunnel probe is local). */
  readonly timeoutMs?: number;
}

/**
 * Probe the cloudflared tunnel via its native metrics endpoint at
 * `http://127.0.0.1:<metrics-port>/quicktunnel`. cloudflared responds
 * with `{ hostname: "<random>.trycloudflare.com" }` while a quick-
 * tunnel is active.
 *
 *   green   : 200 OK with a `hostname` field (tunnel is live)
 *   yellow  : connection refused / DNS / 5xx (transient or
 *             metrics-port-not-bound; the tunnel may still be alive
 *             but the metrics surface is not reporting)
 *   red     : 200 OK without a hostname (no quick-tunnel running)
 *
 * Deep-link to `docs/runbooks/tunnel-disconnected.md` (new stub).
 */
export async function probeTunnelReachability(
  opts: ProbeTunnelOpts = {},
): Promise<ProbeRow> {
  const nowFn = opts.now ?? (() => Date.now());
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const port = opts.metricsPort ?? DEFAULT_TUNNEL_METRICS_PORT;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const nowMs = nowFn();
  const lastCheckedAt = new Date(nowMs).toISOString();

  let response: Response;
  try {
    response = await fetchFn(`http://127.0.0.1:${port}/quicktunnel`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    /*
     * ECONNREFUSED / DNS / timeout / abort all land here. cloudflared
     * exposes the metrics port AFTER startup completes, so a yellow
     * row may be a 1-2 second startup race rather than a permanent
     * down state. The 30s Console refresh cadence rules out a stuck
     * yellow row from a startup race; if it stays yellow across
     * refreshes the tunnel is genuinely unreachable.
     */
    return {
      id: 'tunnel-reachability',
      status: 'yellow',
      summary: 'Tunnel metrics unreachable',
      detail: `Could not connect to cloudflared metrics at 127.0.0.1:${port}: ${(err as Error)?.message ?? err}`,
      runbookHref: '/docs/runbooks/tunnel-disconnected.md',
      lastCheckedAt,
    };
  }

  if (!response.ok) {
    return {
      id: 'tunnel-reachability',
      status: 'yellow',
      summary: `Tunnel metrics returned HTTP ${response.status}`,
      detail:
        `cloudflared metrics endpoint responded with non-2xx status ${response.status}.`
        + ' Tunnel may be starting up or the metrics port may have shifted.',
      runbookHref: '/docs/runbooks/tunnel-disconnected.md',
      lastCheckedAt,
    };
  }

  let parsed: { hostname?: unknown };
  try {
    parsed = (await response.json()) as { hostname?: unknown };
  } catch (err) {
    return {
      id: 'tunnel-reachability',
      status: 'red',
      summary: 'Tunnel metrics returned malformed JSON',
      detail: `cloudflared metrics body was not parseable JSON: ${(err as Error).message}`,
      runbookHref: '/docs/runbooks/tunnel-disconnected.md',
      lastCheckedAt,
    };
  }
  const hostname = typeof parsed.hostname === 'string' && parsed.hostname.length > 0
    ? parsed.hostname
    : null;
  if (hostname === null) {
    return {
      id: 'tunnel-reachability',
      status: 'red',
      summary: 'No active quick-tunnel',
      detail:
        'cloudflared metrics endpoint responded but reported no active'
        + ' quick-tunnel hostname. Restart the tunnel with'
        + ' `node scripts/tunnel-watchdog.mjs` or run `cloudflared tunnel'
        + ' --url http://localhost:9080`.',
      runbookHref: '/docs/runbooks/tunnel-disconnected.md',
      lastCheckedAt,
    };
  }

  return {
    id: 'tunnel-reachability',
    status: 'green',
    summary: `Tunnel reachable: ${hostname}`,
    detail: `Active cloudflared quick-tunnel at ${hostname} (metrics port ${port}).`,
    runbookHref: '/docs/runbooks/tunnel-disconnected.md',
    lastCheckedAt,
  };
}

/**
 * The minimal shape of `node:fs/promises.statfs` result that the
 * free-space probe reads. Mirrors `StatsFsBase` from `@types/node`
 * without importing the type so tests can pass a plain object.
 */
export interface ProbeStatFs {
  readonly bsize: number;
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
}

export interface ProbeAtomStoreOpts {
  /** Now-injection. */
  readonly now?: () => number;
  /**
   * statfs-injection: lets tests drive every threshold without
   * mounting a fake filesystem. Defaults to `node:fs/promises.statfs`.
   */
  readonly statfs?: (path: string) => Promise<ProbeStatFs>;
}

/**
 * Probe the free-space ratio on the partition holding the atoms
 * directory. Uses `node:fs/promises.statfs` which is portable across
 * POSIX and Windows (Windows returns a synthetic bavail derived from
 * the disk's free space).
 *
 *   green   : bavail / blocks * 100 > 5
 *   yellow  : 1 <= % <= 5
 *   red     : < 1
 *
 * The threshold is conservative because the file-adapter atom writer
 * uses atomic-rename through a temp file; running out of space mid-
 * write produces a partial atom that breaks the index priming on the
 * next restart. Catching this at 5% gives the operator hours of
 * runway rather than minutes.
 */
export async function probeAtomStoreFreeSpace(
  atomsDir: string,
  opts: ProbeAtomStoreOpts = {},
): Promise<ProbeRow> {
  const nowFn = opts.now ?? (() => Date.now());
  const statfsFn = opts.statfs ?? statfs;
  const nowMs = nowFn();
  const lastCheckedAt = new Date(nowMs).toISOString();

  let info: ProbeStatFs;
  try {
    info = await statfsFn(atomsDir);
  } catch (err) {
    return {
      id: 'atom-store-free-space',
      status: 'red',
      summary: 'Could not stat atoms partition',
      detail: `statfs(${atomsDir}) failed: ${(err as Error).message}`,
      runbookHref: '/docs/runbooks/atom-store-enospc.md',
      lastCheckedAt,
    };
  }

  if (!Number.isFinite(info.blocks) || info.blocks <= 0) {
    return {
      id: 'atom-store-free-space',
      status: 'red',
      summary: 'Atoms partition reports zero capacity',
      detail:
        `statfs(${atomsDir}) returned blocks=${info.blocks} (zero capacity);`
        + ' cannot compute free-space ratio. Filesystem may be unmounted or read-only.',
      runbookHref: '/docs/runbooks/atom-store-enospc.md',
      lastCheckedAt,
    };
  }

  /*
   * `bavail` is "blocks available to unprivileged users"; we use it
   * (not `bfree`) because the LAG runtime writes as a normal user and
   * the reserved-root blocks should not count toward our headroom.
   * Compute the percentage with floating-point math and pin to four
   * decimals so the detail text is stable across runs.
   */
  const freePct = (info.bavail / info.blocks) * 100;
  const freeBytes = info.bavail * info.bsize;
  const totalBytes = info.blocks * info.bsize;
  const detail =
    `${freePct.toFixed(2)}% free`
    + ` (${formatBytes(freeBytes)} of ${formatBytes(totalBytes)} available`
    + ` on the partition holding ${atomsDir}).`;

  let status: ProbeStatus;
  let summary: string;
  if (freePct > ATOM_STORE_GREEN_FREE_PCT) {
    status = 'green';
    summary = `Atom store healthy (${freePct.toFixed(1)}% free)`;
  } else if (freePct >= ATOM_STORE_YELLOW_FREE_PCT) {
    status = 'yellow';
    summary = `Atom store tight (${freePct.toFixed(1)}% free)`;
  } else {
    status = 'red';
    summary = `Atom store critical (${freePct.toFixed(2)}% free)`;
  }
  return {
    id: 'atom-store-free-space',
    status,
    summary,
    detail,
    runbookHref: '/docs/runbooks/atom-store-enospc.md',
    lastCheckedAt,
  };
}

/**
 * Aggregated System Health response shape. Carries both surfaces (bot-
 * identities and substrate probes) in one payload so the frontend
 * makes a single network call per refresh.
 */
export interface SystemHealthResponse {
  readonly identities: ReadonlyArray<BotIdentityHealth>;
  readonly probes: ReadonlyArray<ProbeRow>;
}

export interface BuildSystemHealthOpts {
  readonly identityOpts?: ProbeIdentityOpts;
  readonly claimReaperOpts?: ProbeClaimReaperOpts;
  readonly tunnelOpts?: ProbeTunnelOpts;
  readonly atomStoreOpts?: ProbeAtomStoreOpts;
}

/**
 * Compose all four probe families into a single response. Runs the
 * probes concurrently because they are independent (bot-identity hits
 * GitHub, claim-reaper reads the atom store, tunnel hits localhost,
 * atom-store hits statfs). The aggregate latency is bounded by the
 * slowest probe, which is normally the GitHub round-trip.
 *
 * Probe row order is stable so the UI renders the same sequence
 * regardless of Promise.all completion order.
 */
export async function buildSystemHealth(
  lagDir: string,
  atomsDir: string,
  opts: BuildSystemHealthOpts = {},
): Promise<SystemHealthResponse> {
  const [identityResp, claimReaperRow, tunnelRow, atomStoreRow] = await Promise.all([
    buildBotIdentityHealth(lagDir, opts.identityOpts),
    probeClaimReaperCadence(opts.claimReaperOpts),
    probeTunnelReachability(opts.tunnelOpts),
    probeAtomStoreFreeSpace(atomsDir, opts.atomStoreOpts),
  ]);
  return {
    identities: identityResp.identities,
    probes: [claimReaperRow, tunnelRow, atomStoreRow],
  };
}

/*
 * formatElapsed / formatBytes: helpers shared across probe rows.
 * Kept local because the bot-identity rows have their own age
 * formatter on the client; extracting a shared util across server +
 * client would require a transport-shared package which is out of
 * scope. Mirrors the "extract at N=2" canon: the second use case is
 * the threshold; here both formatters have one server-side caller
 * each so they stay inline.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes - hours * 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

/**
 * Read `claim-reaper-sweep-completed` atoms from a `.lag/atoms/`
 * directory without depending on the server's in-memory atom index.
 * This helper is the production wiring of `ProbeClaimReaperOpts.loadAtoms`;
 * tests skip it and pass a stub directly.
 *
 * Failure modes deliberately propagate to the caller:
 *   - readdir() on the atoms directory throws (ENOENT / EACCES /
 *     filesystem unmounted): the throw bubbles up so the probe's
 *     catch-block reports "Atom load failed" with the underlying
 *     errno. Swallowing this as an empty array would point operators
 *     at "no heartbeat observed" when the real problem is "the atom
 *     store is unreadable."
 *
 * Per-file read errors stay caught: a single corrupted JSON file
 * inside the atoms directory should not poison the probe's view of
 * the rest of the heartbeat set. That branch logs nothing because
 * the broader probe surfaces aggregate state, not per-atom errors.
 */
export async function defaultLoadClaimReaperHeartbeatAtoms(
  atomsDir: string,
): Promise<ReadonlyArray<ProbeAtom>> {
  // No try/catch here. readdir() failure means the atom-store is
  // inaccessible; the caller's catch translates that into a red row
  // with the underlying error message in detail.
  const entries = await readdir(atomsDir);
  const out: ProbeAtom[] = [];
  /*
   * Atoms of this type are very small and rare (one per tick when the
   * reaper pass is enabled, deleted by the reaper's own age-out
   * sweep). The full directory scan is bounded by the small number of
   * heartbeat files; we still filter by filename prefix to skip the
   * thousands of non-heartbeat atoms in a typical deployment.
   */
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    if (!name.startsWith('claim-reaper-sweep-completed-')) continue;
    try {
      const raw = await readFile(join(atomsDir, name), 'utf8');
      const parsed = JSON.parse(raw) as ProbeAtom;
      if (parsed.type === 'claim-reaper-sweep-completed') {
        out.push(parsed);
      }
    } catch {
      // Skip unreadable / malformed individual files; the probe
      // handles empty results and the aggregate state is what
      // matters. A corrupted single atom does not justify failing
      // the whole probe.
    }
  }
  return out;
}
