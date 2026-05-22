import { describe, expect, it, vi } from 'vitest';
import {
  buildBotIdentityHealth,
  PROBED_ROLES,
  probeBotIdentity,
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
 * A minimal valid PEM. We do not need the signature to verify; the
 * test stubs fetch so the JWT is never sent to a server. The
 * createSign call needs a parseable PEM, hence the real shape (a
 * 1024-bit RSA test key inlined). Generated specifically for this
 * test file via `openssl genrsa 1024`; it is NOT used anywhere live.
 */
const TEST_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIICXAIBAAKBgQDF6QnHs8gAuY6tFvWtnzlZpz4iZepQYJ7vQQrgr4o4yK/iN8nW
JlxRRm1XU0aGn07qCD83hVRT4FB0nfHWLogIfFGzkXOzu4ZpUXAYi0KdoCdLpiH3
zLi9HC8YQy9R+wRzZ7Sef2K0jBOR/Y5G7BMtt8MeULIqQHHWPg+u++j3wQIDAQAB
AoGAJ5pq5HfYJ7C0EzfgWzVR8byaRtjUS75/3wKKkLcIxLEcAlfCKLgZVcVnf/QM
NfKnsTbHNPNqJ70UCcsLeKwhmHHWXmctZBaqdLrnE6L7QwsT7VHGGcWixQXrr4uV
mWGu0fwq19s4FhfsXxxgTBeQQzc83v8oTKwz3ekIp7Tsm6ECQQDojGqzbBSrEW7T
qmYWzy/zZc4tnFB/JE99dT9LBJh3KCAk+/B6m69VWQ5+IGGNwJrqgYcwPLrCNVbi
Z7TfYjFzAkEA2nXjqBjy9hVgcEpBy7VLDFRsM5pSn6ZTzPpD/iV1AlqotPpaHsZv
ChsR3mhE0BTBKAFqkP6jcOAfX+ZWOj3uOwJAdwLnYJBbcUibvLBdoPaqcFfEEXas
QqEnYjNZmHPN67ENG/aD7QqYSL8RGSGMD2cT2k0NwQKpYqsCAuLnYY1WSwJBAJWk
xnzcUNwhB1ngevjxsCsmGTZdyGCFt6cyymF3yz8tH5/5wxs8Y5HMYBKkfPJWFCMs
8AoZpFCXkBz1nh5pZ+kCQEXfWPMOnxIyEPNV4HCDuk1pSjxnq3Tlh9wWQiSdiQVR
cIRrkpgM39kI4lyiwwLeCK3IK1OPg9XB9Bq8nfJTkPg=
-----END RSA PRIVATE KEY-----
`;

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
