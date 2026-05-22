/**
 * Tests for scripts/lib/token-health.mjs.
 *
 * Pins the contract that every PAT-using script depends on:
 *   - 401 surfaces as kind='invalid' with the renewal-recovery path
 *   - 200 with no expiry header surfaces as kind='ok', expiresAt=null
 *   - 200 with expiry header far in the future is 'ok' with no warning
 *   - 200 with expiry header < N days away surfaces a warning string
 *   - fetch errors / timeouts surface as kind='network-error' (caller
 *     treats as transient, NOT a hard fail)
 *   - empty / whitespace-only token short-circuits without an HTTP call
 *
 * The fetch injection lets the test drive the helper synchronously
 * with stubbed Response objects; no live network call.
 */

import { describe, expect, it, vi } from 'vitest';

const { checkPatHealth, renewalInstructionsFor, DEFAULT_WARN_DAYS_FROM_EXPIRY } = await import(
  '../../scripts/lib/token-health.mjs'
);

type FetchOk = (url: string, init: RequestInit) => Promise<Response>;

function stubFetch(response: Response): FetchOk {
  return () => Promise.resolve(response);
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('checkPatHealth', () => {
  it('returns invalid for empty token without any HTTP call', async () => {
    const fetchSpy = vi.fn();
    const result = await checkPatHealth('', { fetch: fetchSpy as unknown as FetchOk });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.status).toBe(0);
      expect(result.detail).toBe('empty token');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns invalid for whitespace-only token', async () => {
    const fetchSpy = vi.fn();
    const result = await checkPatHealth('   ', { fetch: fetchSpy as unknown as FetchOk });
    expect(result.kind).toBe('invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns invalid on HTTP 401 with the response body as detail', async () => {
    const fetchFn = stubFetch(
      new Response('{"message":"Bad credentials"}', { status: 401 }),
    );
    const result = await checkPatHealth('expired-token', { fetch: fetchFn });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.status).toBe(401);
      expect(result.detail).toContain('Bad credentials');
    }
  });

  it('returns ok with identity but no expiresAt for classic PATs (no expiration header)', async () => {
    const fetchFn = stubFetch(jsonResponse(200, { login: 'machine-user' }));
    const result = await checkPatHealth('classic-pat', { fetch: fetchFn });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.identity).toBe('machine-user');
      expect(result.expiresAt).toBeNull();
      expect(result.daysToExpiry).toBeNull();
      expect(result.warning).toBeNull();
    }
  });

  it('returns ok with warning when fine-grained PAT is < warn floor from expiry', async () => {
    // Token expires 3 days from "now". Mock `now` so the test is
    // deterministic across machines.
    const nowMs = Date.parse('2026-05-22T00:00:00Z');
    const expiryMs = nowMs + 3 * 86_400_000;
    const expiryIso = new Date(expiryMs).toISOString();
    const fetchFn = stubFetch(
      jsonResponse(
        200,
        { login: 'machine-user' },
        { 'github-authentication-token-expiration': expiryIso },
      ),
    );
    const result = await checkPatHealth('fine-grained-pat', {
      fetch: fetchFn,
      now: () => nowMs,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.daysToExpiry).toBe(3);
      expect(result.expiresAt).toBe(expiryIso);
      expect(result.warning).toContain('3 day(s)');
      expect(result.warning).toContain('rotate');
    }
  });

  it('returns ok with no warning when fine-grained PAT is well past warn floor', async () => {
    const nowMs = Date.parse('2026-05-22T00:00:00Z');
    // 60 days out, well beyond the 7-day default warn floor.
    const expiryMs = nowMs + 60 * 86_400_000;
    const expiryIso = new Date(expiryMs).toISOString();
    const fetchFn = stubFetch(
      jsonResponse(
        200,
        { login: 'machine-user' },
        { 'github-authentication-token-expiration': expiryIso },
      ),
    );
    const result = await checkPatHealth('fine-grained-pat', {
      fetch: fetchFn,
      now: () => nowMs,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.daysToExpiry).toBe(60);
      expect(result.warning).toBeNull();
    }
  });

  it('honors warnDaysFromExpiry override', async () => {
    const nowMs = Date.parse('2026-05-22T00:00:00Z');
    const expiryMs = nowMs + 10 * 86_400_000;
    const expiryIso = new Date(expiryMs).toISOString();
    const fetchFn = stubFetch(
      jsonResponse(
        200,
        { login: 'machine-user' },
        { 'github-authentication-token-expiration': expiryIso },
      ),
    );
    const result = await checkPatHealth('fine-grained-pat', {
      fetch: fetchFn,
      now: () => nowMs,
      warnDaysFromExpiry: 14,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // 10 days <= 14-day floor, so the warning fires.
      expect(result.warning).toContain('10 day(s)');
    }
  });

  it('treats fetch error as network-error (caller decides whether to proceed)', async () => {
    const fetchFn = () => Promise.reject(new Error('ECONNREFUSED'));
    const result = await checkPatHealth('any-token', {
      fetch: fetchFn as unknown as FetchOk,
    });
    expect(result.kind).toBe('network-error');
    if (result.kind === 'network-error') {
      expect(result.detail).toContain('ECONNREFUSED');
    }
  });

  it('treats abort/timeout as network-error with timeout label', async () => {
    const fetchFn = () => {
      const err = new Error('Aborted');
      (err as Error & { name: string }).name = 'AbortError';
      return Promise.reject(err);
    };
    const result = await checkPatHealth('any-token', {
      fetch: fetchFn as unknown as FetchOk,
    });
    expect(result.kind).toBe('network-error');
    if (result.kind === 'network-error') {
      expect(result.detail).toContain('timeout');
    }
  });

  it('default warn floor is 7 days (substrate contract)', () => {
    expect(DEFAULT_WARN_DAYS_FROM_EXPIRY).toBe(7);
  });
});

describe('renewalInstructionsFor', () => {
  it('includes the env var name and machine user', () => {
    const text = renewalInstructionsFor('LAG_OPS_PAT', 'layered-autonomous-governance');
    expect(text).toContain('LAG_OPS_PAT');
    expect(text).toContain('layered-autonomous-governance');
    expect(text).toContain('https://github.com/settings/tokens');
  });

  it('defaults machine user when omitted', () => {
    const text = renewalInstructionsFor('LAG_OPS_PAT');
    expect(text).toContain('layered-autonomous-governance');
  });
});
