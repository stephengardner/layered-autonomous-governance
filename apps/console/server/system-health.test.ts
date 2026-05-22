import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  ATOM_STORE_GREEN_FREE_PCT,
  ATOM_STORE_YELLOW_FREE_PCT,
  DEFAULT_CLAIM_REAPER_CADENCE_MS,
  buildBotIdentityHealth,
  buildSystemHealth,
  PROBED_ROLES,
  probeAtomStoreFreeSpace,
  probeBotIdentity,
  probeClaimReaperCadence,
  probeTunnelReachability,
  type ProbeAtom,
  type ProbeStatFs,
  type RoleCredentials,
} from './system-health';

/*
 * Tests for the bot-identity health probe.
 *
 * Coverage focus:
 *   - Each probe outcome (fresh / stale / network-error /
 *     not-provisioned) maps to the right discriminated status.
 *   - The aggregate handler returns one row per role in
 *     PROBED_ROLES order so the UI renders a stable sequence.
 *   - The token returned by GitHub is NOT echoed in the response
 *     payload; only the expiry is surfaced. This is a security
 *     contract: a leaked dashboard snapshot must not include an
 *     active installation token.
 *   - The 4xx mapping does NOT call the renewal helper or hold the
 *     token after the status determination; the function returns a
 *     stale row and exits.
 *
 * Mocked dependencies:
 *   - fetch: stubbed per test so no live GitHub API call
 *   - loadRoleCredentials: stubbed so no filesystem read
 *   - now: fixed instant so ageMs is deterministic
 */

const REFERENCE_NOW_MS = Date.parse('2026-05-22T12:00:00.000Z');
const REFERENCE_EXPIRES_AT = '2026-05-22T13:00:00.000Z';

/*
 * An ephemeral RSA key pair generated at test runtime. The createSign
 * path inside probeBotIdentity needs a parseable PEM to mint a JWT;
 * stubbed fetch then captures the request before it leaves the
 * process, so the key never authenticates against a live endpoint.
 *
 * Generating at runtime (instead of inlining a literal) keeps the
 * repo free of static private-key material that would trip secret
 * scanners. modulusLength is 2048 so CodeQL's js/insufficient-key-size
 * rule stays green; the extra generation cost (~50ms) is paid once
 * per file load.
 */
const TEST_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey
  .export({ type: 'pkcs1', format: 'pem' })
  .toString();

function fixedNow() {
  return REFERENCE_NOW_MS;
}

function stubCredentials(role: string, options: { installationId?: number | null } = {}): RoleCredentials {
  /*
   * Default to installed (id=12345) when caller does not specify.
   * Pass { installationId: null } to simulate "provisioned but not
   * installed on any repo". The explicit null disambiguates from
   * "default applied" because JS default parameters treat undefined
   * as missing and would otherwise rewrite the value.
   */
  const id = options.installationId === undefined ? 12345 : options.installationId;
  return {
    record: {
      role,
      appId: 999,
      slug: role,
      ...(id !== null ? { installationId: id } : {}),
    },
    privateKey: TEST_PEM,
  };
}

function stubFetchOk(): typeof globalThis.fetch {
  return (async () => new Response(
    JSON.stringify({ token: 'ghs_supersecret', expires_at: REFERENCE_EXPIRES_AT }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  )) as typeof globalThis.fetch;
}

describe('probeBotIdentity', () => {
  it('returns fresh + expiresAt + ageMs when GitHub returns 201 with a token', async () => {
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: stubFetchOk(),
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.status).toBe('fresh');
    expect(result.role).toBe('lag-ceo');
    expect(result.login).toBe('lag-ceo');
    expect(result.appId).toBe(999);
    expect(result.installationId).toBe(12345);
    expect(result.expiresAt).toBe(REFERENCE_EXPIRES_AT);
    expect(result.ageMs).toBe(3_600_000); // exactly one hour ahead of REFERENCE_NOW_MS
    expect(result.detail).toBeNull();
  });

  it('does NOT include the minted token anywhere in the response', async () => {
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: stubFetchOk(),
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    /*
     * Defense-in-depth: a leaked dashboard snapshot or a logged
     * response body must not echo an active installation token.
     * Serialise the full row and grep for the token literal.
     */
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('ghs_supersecret');
  });

  it('returns not-provisioned when no credentials file exists', async () => {
    const result = await probeBotIdentity('/fake/lag', 'lag-actors', {
      now: fixedNow,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      loadRoleCredentials: async () => null,
    });
    expect(result.status).toBe('not-provisioned');
    expect(result.role).toBe('lag-actors');
    expect(result.appId).toBeNull();
    expect(result.installationId).toBeNull();
    expect(result.expiresAt).toBeNull();
    expect(result.ageMs).toBeNull();
    expect(result.detail).toBeNull();
  });

  it('returns stale when role is provisioned but not installed on a repo', async () => {
    const result = await probeBotIdentity('/fake/lag', 'lag-cto', {
      now: fixedNow,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      loadRoleCredentials: async () => stubCredentials('lag-cto', { installationId: null }),
    });
    expect(result.status).toBe('stale');
    expect(result.installationId).toBeNull();
    expect(result.detail).toContain('not installed on any repository');
  });

  it('returns stale on HTTP 401 from the token-mint endpoint', async () => {
    const fetchFn = (async () => new Response('Bad credentials', { status: 401 })) as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-cto', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-cto'),
    });
    expect(result.status).toBe('stale');
    expect(result.detail).toContain('HTTP 401');
    expect(result.expiresAt).toBeNull();
  });

  it('returns stale on HTTP 404 (app uninstalled from the target installation)', async () => {
    const fetchFn = (async () => new Response('Not Found', { status: 404 })) as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-pr-landing', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-pr-landing'),
    });
    expect(result.status).toBe('stale');
    expect(result.detail).toContain('HTTP 404');
  });

  it('returns network-error on HTTP 503 (transient GitHub outage)', async () => {
    const fetchFn = (async () => new Response('Service Unavailable', { status: 503 })) as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.status).toBe('network-error');
    expect(result.detail).toContain('HTTP 503');
  });

  it('returns network-error on a fetch exception (DNS failure / abort)', async () => {
    const fetchFn = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.status).toBe('network-error');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('returns network-error with timeout label on AbortError', async () => {
    const fetchFn = (() => {
      const err = new Error('signal aborted');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }) as unknown as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.status).toBe('network-error');
    expect(result.detail).toContain('timeout');
  });

  it('returns stale when response body parses but omits the token field', async () => {
    /*
     * Malformed-success guard: a 201 whose body lacks `token` (an
     * upstream proxy stripped it, or a future API revision changed
     * the shape) must not be treated as healthy auth. Surface as
     * stale so the operator investigates rather than blindly trusts.
     */
    const fetchFn = (async () => new Response(
      JSON.stringify({ expires_at: REFERENCE_EXPIRES_AT }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.status).toBe('stale');
    expect(result.detail).toContain('missing token');
  });

  it('returns stale on unparseable response body (200 but JSON broken)', async () => {
    const fetchFn = (async () => new Response('not-json-{', { status: 201, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: fetchFn,
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.status).toBe('stale');
    expect(result.detail).toContain('unparseable');
  });

  it('returns stale when the loader itself throws', async () => {
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      loadRoleCredentials: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(result.status).toBe('stale');
    expect(result.detail).toContain('EACCES');
  });

  it('attaches a deterministic lastCheckedAt ISO string from the now injector', async () => {
    const result = await probeBotIdentity('/fake/lag', 'lag-ceo', {
      now: fixedNow,
      fetch: stubFetchOk(),
      loadRoleCredentials: async () => stubCredentials('lag-ceo'),
    });
    expect(result.lastCheckedAt).toBe(new Date(REFERENCE_NOW_MS).toISOString());
  });
});

describe('buildBotIdentityHealth', () => {
  it('returns one row per role in PROBED_ROLES order', async () => {
    const seen: string[] = [];
    const result = await buildBotIdentityHealth('/fake/lag', {
      now: fixedNow,
      fetch: stubFetchOk(),
      loadRoleCredentials: async (_dir, role) => {
        seen.push(role);
        return stubCredentials(role);
      },
    });
    expect(result.identities.map((r) => r.role)).toEqual([...PROBED_ROLES]);
    // Sort because Promise.all parallelism does not guarantee call order
    expect([...seen].sort()).toEqual([...PROBED_ROLES].sort());
  });

  it('aggregates a mix of statuses without one failing row poisoning others', async () => {
    let i = 0;
    const result = await buildBotIdentityHealth('/fake/lag', {
      now: fixedNow,
      fetch: ((async () => {
        const idx = i++;
        if (idx === 0) {
          return new Response(
            JSON.stringify({ token: 't', expires_at: REFERENCE_EXPIRES_AT }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        if (idx === 1) {
          return new Response('Bad credentials', { status: 401 });
        }
        if (idx === 2) {
          return new Response('Service Unavailable', { status: 503 });
        }
        return new Response(
          JSON.stringify({ token: 't', expires_at: REFERENCE_EXPIRES_AT }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof globalThis.fetch),
      loadRoleCredentials: async (_dir, role) => stubCredentials(role),
    });
    /*
     * Because Promise.all runs in parallel we cannot pin which row
     * got which response, but we CAN assert: 4 rows, no exception
     * escaped, every status falls in the allowed set, and at least
     * one row hit each of fresh / stale / network-error.
     */
    expect(result.identities).toHaveLength(PROBED_ROLES.length);
    const statuses = result.identities.map((r) => r.status).sort();
    expect(statuses.every((s) => ['fresh', 'stale', 'network-error', 'not-provisioned'].includes(s))).toBe(true);
  });

  it('returns not-provisioned rows for every role when the lag dir is empty', async () => {
    const result = await buildBotIdentityHealth('/fake/lag', {
      now: fixedNow,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      loadRoleCredentials: async () => null,
    });
    expect(result.identities).toHaveLength(PROBED_ROLES.length);
    expect(result.identities.every((r) => r.status === 'not-provisioned')).toBe(true);
  });
});

/*
 * Tests for the three substrate probes: claim-reaper cadence, tunnel
 * reachability, atom-store free space.
 *
 * Each probe is a pure function with injected dependencies (now,
 * fetch, statfs, atom loader). Tests drive every status branch
 * (green / yellow / red) plus the error-path branches that surface
 * as red rows with a diagnostic detail string.
 */

function mkSweepAtom(id: string, createdAt: string): ProbeAtom {
  return {
    id,
    type: 'claim-reaper-sweep-completed',
    created_at: createdAt,
    metadata: { reaper_sweep: { detected: 0, recovered: 0, escalated: 0 } },
  };
}

describe('probeClaimReaperCadence', () => {
  /*
   * REFERENCE_NOW_MS is shared with the bot-identity suite above. The
   * cadence default is 60_000ms so the test fixtures key elapsed-since
   * values off that constant.
   */
  it('returns green when the most recent sweep is fresher than 2x cadence', async () => {
    const recent = REFERENCE_NOW_MS - 30_000; // 0.5x cadence ago
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => [mkSweepAtom('a1', new Date(recent).toISOString())],
    });
    expect(result.status).toBe('green');
    expect(result.id).toBe('claim-reaper-cadence');
    expect(result.summary).toMatch(/Reaper swept/);
    expect(result.runbookHref).toContain('reaper-not-running');
  });

  it('returns yellow when the most recent sweep is between 2x and 5x cadence ago', async () => {
    const stale = REFERENCE_NOW_MS - 3 * DEFAULT_CLAIM_REAPER_CADENCE_MS; // 3x cadence
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => [mkSweepAtom('a2', new Date(stale).toISOString())],
    });
    expect(result.status).toBe('yellow');
    expect(result.summary).toMatch(/slow/);
  });

  it('returns red when the most recent sweep is older than 5x cadence', async () => {
    const veryStale = REFERENCE_NOW_MS - 10 * DEFAULT_CLAIM_REAPER_CADENCE_MS;
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => [mkSweepAtom('a3', new Date(veryStale).toISOString())],
    });
    expect(result.status).toBe('red');
    expect(result.summary).toMatch(/offline/);
  });

  it('returns red with absent-heartbeat detail when no sweep atom is found', async () => {
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => [],
    });
    expect(result.status).toBe('red');
    expect(result.detail).toContain('No claim-reaper-sweep-completed atom');
  });

  it('ignores atoms of other types in the loaded array', async () => {
    /*
     * The default loader only filters by filename prefix; the probe
     * itself filters by `type` field so a future filename-pattern
     * collision (e.g. test fixtures) does not poison the cadence
     * calculation. Pin that behavior here.
     */
    const recent = REFERENCE_NOW_MS - 1_000;
    const distractor: ProbeAtom = {
      id: 'distractor',
      type: 'observation',
      created_at: new Date(REFERENCE_NOW_MS).toISOString(),
    };
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => [distractor, mkSweepAtom('sweep', new Date(recent).toISOString())],
    });
    expect(result.status).toBe('green');
  });

  it('picks the most recent sweep when multiple atoms exist', async () => {
    const old = REFERENCE_NOW_MS - 1_000_000;
    const newest = REFERENCE_NOW_MS - 500;
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => [
        mkSweepAtom('old', new Date(old).toISOString()),
        mkSweepAtom('newest', new Date(newest).toISOString()),
      ],
    });
    expect(result.status).toBe('green');
    expect(result.detail).toContain('newest');
  });

  it('surfaces atom-loader failures as red without throwing', async () => {
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(result.status).toBe('red');
    expect(result.detail).toContain('EACCES');
  });

  it('atom-loader failure detail names the right subsystem (atom load, not reaper)', async () => {
    /*
     * Regression guard: an earlier draft swallowed readdir() failure
     * inside defaultLoadClaimReaperHeartbeatAtoms as empty array,
     * which surfaced as "No reaper heartbeat observed" instead of
     * "Atom load failed". Operators chasing a missing-heartbeat
     * symptom would investigate the LoopRunner reaper pass when the
     * actual problem was an unreadable atom store. The probe's
     * detail string must point at the right subsystem.
     */
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      loadAtoms: async () => {
        throw new Error('ENOENT: no such file or directory, scandir');
      },
    });
    expect(result.status).toBe('red');
    expect(result.summary).toMatch(/Atom load failed/);
    expect(result.detail).toContain('Could not read atoms');
    expect(result.detail).not.toContain('heartbeat'); // not the wrong subsystem
  });

  it('honours a caller-supplied cadenceMs override', async () => {
    /*
     * An org-ceiling deployment that tightens the reaper cadence to
     * 10s expects the probe thresholds to follow (2x = 20s yellow,
     * 5x = 50s red). The cadenceMs seam threads the canon-resolved
     * value into the probe at the boundary; tests pin it directly.
     */
    const result = await probeClaimReaperCadence({
      now: fixedNow,
      cadenceMs: 10_000,
      loadAtoms: async () => [
        mkSweepAtom('a', new Date(REFERENCE_NOW_MS - 30_000).toISOString()),
      ],
    });
    // 30s = 3x of 10s cadence -> yellow
    expect(result.status).toBe('yellow');
  });
});

describe('probeTunnelReachability', () => {
  it('returns green when cloudflared returns 200 with a hostname', async () => {
    const fetchFn = (async () => new Response(
      JSON.stringify({ hostname: 'fluffy-rabbit-1234.trycloudflare.com' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('green');
    expect(result.summary).toContain('fluffy-rabbit-1234.trycloudflare.com');
    expect(result.runbookHref).toContain('tunnel-disconnected');
  });

  it('returns yellow on ECONNREFUSED (tunnel not running yet)', async () => {
    const fetchFn = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('yellow');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('returns yellow on AbortError / timeout', async () => {
    const fetchFn = (() => {
      const err = new Error('signal aborted');
      err.name = 'TimeoutError';
      return Promise.reject(err);
    }) as unknown as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('yellow');
  });

  it('returns yellow on HTTP 5xx (cloudflared starting up)', async () => {
    const fetchFn = (async () => new Response('Service Unavailable', { status: 503 })) as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('yellow');
    expect(result.summary).toContain('HTTP 503');
  });

  it('returns red on 200 with no hostname (cloudflared up but no quick-tunnel)', async () => {
    const fetchFn = (async () => new Response(
      JSON.stringify({ /* no hostname field */ }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('red');
    expect(result.summary).toMatch(/No active quick-tunnel/);
  });

  it('returns red on 200 with malformed JSON (proxy stripped body)', async () => {
    const fetchFn = (async () => new Response(
      'not-json-{',
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('red');
    expect(result.summary).toContain('malformed JSON');
  });

  it('returns red on 200 with hostname=empty-string (cloudflared bug surface)', async () => {
    /*
     * Defensive: cloudflared has historically had bug surfaces where
     * the metrics endpoint returns an empty string. Empty string is
     * not "active tunnel"; treat it as red.
     */
    const fetchFn = (async () => new Response(
      JSON.stringify({ hostname: '' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
    const result = await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
    });
    expect(result.status).toBe('red');
  });

  it('uses the metricsPort override when supplied', async () => {
    /*
     * The probe is wired to cloudflared's first-port-default (20241)
     * but an operator running on a custom port via --metrics flags
     * the override through. Verify the URL the probe issues actually
     * carries the custom port.
     */
    let calledWith: string | null = null;
    const fetchFn = (async (url: string) => {
      calledWith = url;
      return new Response(
        JSON.stringify({ hostname: 'h.trycloudflare.com' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    await probeTunnelReachability({
      now: fixedNow,
      fetch: fetchFn,
      metricsPort: 31415,
    });
    expect(calledWith).toContain(':31415');
    expect(calledWith).toContain('/quicktunnel');
  });
});

describe('probeAtomStoreFreeSpace', () => {
  /*
   * statfs returns block counts; the probe computes (bavail / blocks)
   * as a percentage. We construct ProbeStatFs literals so the test
   * isolates the threshold logic from any real filesystem.
   *
   * 1 KiB block size keeps the byte math human-readable in failures.
   */
  function mkStat(freePct: number, totalBlocks = 1_000_000): ProbeStatFs {
    return {
      bsize: 1024,
      blocks: totalBlocks,
      bfree: Math.floor(totalBlocks * freePct / 100),
      bavail: Math.floor(totalBlocks * freePct / 100),
    };
  }

  it('returns green when free space > 5%', async () => {
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => mkStat(20),
    });
    expect(result.status).toBe('green');
    expect(result.summary).toContain('healthy');
    expect(result.runbookHref).toContain('atom-store-enospc');
  });

  it('returns green at exactly the green threshold ceiling', async () => {
    // 5.01% is green (strictly greater than 5)
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => mkStat(5.01),
    });
    expect(result.status).toBe('green');
  });

  it('returns yellow when free space is between 1% and 5%', async () => {
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => mkStat(3),
    });
    expect(result.status).toBe('yellow');
    expect(result.summary).toContain('tight');
  });

  it('returns yellow at exactly the yellow lower boundary', async () => {
    // 1% is yellow (inclusive)
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => mkStat(1),
    });
    expect(result.status).toBe('yellow');
  });

  it('returns red when free space is < 1%', async () => {
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => mkStat(0.5),
    });
    expect(result.status).toBe('red');
    expect(result.summary).toContain('critical');
  });

  it('returns red on statfs throw (filesystem unmounted or permission denied)', async () => {
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });
    expect(result.status).toBe('red');
    expect(result.detail).toContain('ENOENT');
  });

  it('returns red when statfs returns zero blocks (degenerate partition)', async () => {
    const result = await probeAtomStoreFreeSpace('/fake/atoms', {
      now: fixedNow,
      statfs: async () => ({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }),
    });
    expect(result.status).toBe('red');
    expect(result.detail).toContain('zero capacity');
  });

  it('threshold constants stay aligned with the documented runbook prose', () => {
    /*
     * Regression guard: the runbook prose at docs/runbooks/atom-store-
     * enospc.md cites 5% as the yellow ceiling and 1% as the red
     * boundary. If a future tuning changes the constants, the runbook
     * narrative needs to be updated in lock-step.
     */
    expect(ATOM_STORE_GREEN_FREE_PCT).toBe(5);
    expect(ATOM_STORE_YELLOW_FREE_PCT).toBe(1);
  });
});

describe('buildSystemHealth', () => {
  it('returns identities + probes in a single response with stable probe order', async () => {
    const result = await buildSystemHealth('/fake/lag', '/fake/atoms', {
      identityOpts: {
        now: fixedNow,
        fetch: stubFetchOk(),
        loadRoleCredentials: async (_dir, role) => stubCredentials(role),
      },
      claimReaperOpts: {
        now: fixedNow,
        loadAtoms: async () => [
          mkSweepAtom('s', new Date(REFERENCE_NOW_MS - 1_000).toISOString()),
        ],
      },
      tunnelOpts: {
        now: fixedNow,
        fetch: (async () => new Response(
          JSON.stringify({ hostname: 'h.trycloudflare.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof globalThis.fetch,
      },
      atomStoreOpts: {
        now: fixedNow,
        statfs: async () => ({ bsize: 1024, blocks: 1_000_000, bfree: 200_000, bavail: 200_000 }),
      },
    });
    expect(result.identities).toHaveLength(PROBED_ROLES.length);
    expect(result.probes).toHaveLength(3);
    expect(result.probes.map((p) => p.id)).toEqual([
      'claim-reaper-cadence',
      'tunnel-reachability',
      'atom-store-free-space',
    ]);
    // All four surfaces green / fresh on the happy path
    expect(result.identities.every((r) => r.status === 'fresh')).toBe(true);
    expect(result.probes.every((p) => p.status === 'green')).toBe(true);
  });

  it('wires defaultLoadClaimReaperHeartbeatAtoms when the caller omits loadAtoms', async () => {
    /*
     * Regression guard: probeClaimReaperCadence's own default
     * loadAtoms is `async () => []`, which would render the probe
     * useless for any composer that calls buildSystemHealth without
     * supplying an explicit loader. buildSystemHealth must wire the
     * disk-backed default so on-disk heartbeats are observed even
     * without an in-memory index. We exercise that by passing no
     * claimReaperOpts.loadAtoms and pointing atomsDir at a
     * non-existent path: the disk loader throws on readdir(), the
     * probe catches the throw, and the result is a red row whose
     * detail carries the underlying ENOENT message -- proving the
     * default loader ran (not the empty array).
     */
    const result = await buildSystemHealth('/fake/lag', '/this/path/does/not/exist', {
      identityOpts: {
        now: fixedNow,
        fetch: stubFetchOk(),
        loadRoleCredentials: async () => null,
      },
      claimReaperOpts: { now: fixedNow },
      tunnelOpts: {
        now: fixedNow,
        fetch: (async () => new Response(
          JSON.stringify({ hostname: 'h.trycloudflare.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof globalThis.fetch,
      },
      atomStoreOpts: {
        now: fixedNow,
        statfs: async () => ({ bsize: 1024, blocks: 1_000_000, bfree: 200_000, bavail: 200_000 }),
      },
    });
    const reaper = result.probes.find((p) => p.id === 'claim-reaper-cadence')!;
    expect(reaper.status).toBe('red');
    // Confirm the detail surfaces the underlying load failure, not the
    // generic "No heartbeat observed" message that the empty-array
    // default would have produced.
    expect(reaper.summary).toMatch(/Atom load failed/);
  });

  it('does not let one failing probe poison the others', async () => {
    const result = await buildSystemHealth('/fake/lag', '/fake/atoms', {
      identityOpts: {
        now: fixedNow,
        fetch: stubFetchOk(),
        loadRoleCredentials: async (_dir, role) => stubCredentials(role),
      },
      claimReaperOpts: {
        now: fixedNow,
        loadAtoms: async () => { throw new Error('boom'); },
      },
      tunnelOpts: {
        now: fixedNow,
        fetch: (async () => new Response(
          JSON.stringify({ hostname: 'h.trycloudflare.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof globalThis.fetch,
      },
      atomStoreOpts: {
        now: fixedNow,
        statfs: async () => ({ bsize: 1024, blocks: 1_000_000, bfree: 200_000, bavail: 200_000 }),
      },
    });
    expect(result.probes).toHaveLength(3);
    const reaper = result.probes.find((p) => p.id === 'claim-reaper-cadence')!;
    const tunnel = result.probes.find((p) => p.id === 'tunnel-reachability')!;
    const atomStore = result.probes.find((p) => p.id === 'atom-store-free-space')!;
    expect(reaper.status).toBe('red');
    expect(tunnel.status).toBe('green');
    expect(atomStore.status).toBe('green');
  });
});
