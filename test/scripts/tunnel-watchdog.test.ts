/**
 * Unit tests for scripts/tunnel-watchdog.mjs pure helpers.
 *
 * The watchdog wires three pure decisions together: parse a tunnel
 * hostname out of cloudflared output, decide a backoff delay after a
 * failure, classify a probe response into healthy/unhealthy, and
 * merge a newly-discovered hostname into LAG_CONSOLE_ALLOWED_ORIGINS.
 * Each is covered here in isolation; the spawn + signal + restart side
 * effects are exercised via operator dogfeed (the watchdog is an OPS
 * supervisor, not a substrate primitive, so a vitest harness around
 * cloudflared is more cost than coverage).
 *
 * Test discipline: import the shebang-free helper module so vitest's
 * Windows-CI transformer does not stumble on the `#!` of the CLI
 * wrapper (PR #123 / PR #172 precedent).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyProbe,
  decideRestartAction,
  mergeAllowedOrigins,
  nextBackoffMs,
  parseTrycloudflareHostname,
} from '../../scripts/lib/tunnel-watchdog.mjs';

describe('parseTrycloudflareHostname', () => {
  it('returns the bare host from a plain log line', () => {
    const line = 'Your quick Tunnel has been created! Visit it at: https://swift-eagle-foo-bar.trycloudflare.com';
    expect(parseTrycloudflareHostname(line)).toBe('swift-eagle-foo-bar.trycloudflare.com');
  });

  it('lowercases the host so allowlist comparisons are stable', () => {
    expect(parseTrycloudflareHostname('https://Mixed-Case-Host.TryCloudflare.COM')).toBe(
      'mixed-case-host.trycloudflare.com',
    );
  });

  it('strips ANSI colour codes around the URL', () => {
    const ansi = '\x1B[36mTunnel:\x1B[0m \x1B[1mhttps://blue-cat.trycloudflare.com\x1B[0m';
    expect(parseTrycloudflareHostname(ansi)).toBe('blue-cat.trycloudflare.com');
  });

  it('returns null when no trycloudflare host is present', () => {
    expect(parseTrycloudflareHostname('starting tunnel...')).toBeNull();
    expect(parseTrycloudflareHostname('https://example.com')).toBeNull();
  });

  it('returns null on non-string / empty input', () => {
    expect(parseTrycloudflareHostname('')).toBeNull();
    // @ts-expect-error feeding the wrong shape on purpose to exercise the guard
    expect(parseTrycloudflareHostname(undefined)).toBeNull();
    // @ts-expect-error feeding the wrong shape on purpose
    expect(parseTrycloudflareHostname({ url: 'https://x.trycloudflare.com' })).toBeNull();
  });

  it('takes the first match if multiple URLs appear in one chunk', () => {
    const chunk = 'https://first-host.trycloudflare.com and later https://second-host.trycloudflare.com';
    expect(parseTrycloudflareHostname(chunk)).toBe('first-host.trycloudflare.com');
  });

  it('also matches plain http URLs (rare but legal for quick-tunnels)', () => {
    expect(parseTrycloudflareHostname('listening on http://plain-host.trycloudflare.com')).toBe(
      'plain-host.trycloudflare.com',
    );
  });
});

describe('nextBackoffMs', () => {
  it('returns approximately base * 2^failures with no jitter when random pinned to 0.5', () => {
    // random()=0.5 -> jitter factor = (0.5*2-1)*0.2 = 0; jittered = clamped
    const r = nextBackoffMs({ failures: 3, baseMs: 1000, maxMs: 60_000, jitterFraction: 0.2, random: () => 0.5 });
    expect(r).toBe(8000);
  });

  it('clamps to maxMs at high failure counts', () => {
    const r = nextBackoffMs({ failures: 20, baseMs: 1000, maxMs: 30_000, jitterFraction: 0.2, random: () => 0.5 });
    expect(r).toBe(30_000);
  });

  it('returns a non-zero delay for failures=0 (no hot loop on instant-exit)', () => {
    const r = nextBackoffMs({ failures: 0, baseMs: 500, maxMs: 60_000, jitterFraction: 0, random: () => 0.5 });
    expect(r).toBe(500);
  });

  it('clamps a negative jitter to floor 0 (returned delay never goes negative)', () => {
    // random()=0 -> jitter = -1 * jitterFraction; very high jitter would push value below 0.
    const r = nextBackoffMs({ failures: 0, baseMs: 100, maxMs: 60_000, jitterFraction: 0.99, random: () => 0 });
    expect(r).toBeGreaterThanOrEqual(0);
  });

  it('clamps invalid input to safe defaults rather than throwing', () => {
    // failures negative -> 0; baseMs 0 -> 1000; maxMs less than base -> 60000; jitter 1 -> 0.2
    const r = nextBackoffMs({ failures: -5, baseMs: 0, maxMs: -1, jitterFraction: 5, random: () => 0.5 });
    expect(r).toBe(1000);
  });
});

describe('decideRestartAction', () => {
  it('attempts when failures are below threshold', () => {
    expect(decideRestartAction({ failures: 2, threshold: 5 })).toEqual({
      verdict: 'attempt',
      reason: 'within-budget',
    });
  });

  it('trips with no cooldown when breaker is open', () => {
    const r = decideRestartAction({ failures: 5, threshold: 5, cooldownMs: 0 });
    expect(r.verdict).toBe('tripped');
  });

  it('reports cooldown active when cooldown not yet elapsed', () => {
    const r = decideRestartAction({
      failures: 5,
      threshold: 5,
      cooldownMs: 60_000,
      lastTripAt: 1_000_000,
      now: 1_030_000, // 30s elapsed
    });
    expect(r.verdict).toBe('cooldown');
    expect(r.reason).toContain('cooldown-active');
  });

  it('attempts again after cooldown elapses', () => {
    const r = decideRestartAction({
      failures: 5,
      threshold: 5,
      cooldownMs: 60_000,
      lastTripAt: 1_000_000,
      now: 1_120_000, // 120s elapsed > 60s cooldown
    });
    expect(r.verdict).toBe('attempt');
    expect(r.reason).toContain('cooldown-elapsed');
  });

  it('reports cooldown-pending when tripped without a recorded trip time', () => {
    const r = decideRestartAction({ failures: 5, threshold: 5, cooldownMs: 60_000, lastTripAt: null });
    expect(r.verdict).toBe('cooldown');
    expect(r.reason).toContain('cooldown-pending');
  });
});

describe('classifyProbe', () => {
  it('healthy on a 2xx response', () => {
    expect(classifyProbe({ status: 200 })).toEqual({ status: 'healthy', reason: 'http-200' });
  });

  it('unhealthy on a 502 (the canonical cloudflared upstream-down signature)', () => {
    expect(classifyProbe({ status: 502 })).toEqual({ status: 'unhealthy', reason: 'http-502' });
  });

  it('unhealthy on connection refused', () => {
    expect(classifyProbe({ status: 0, error: 'ECONNREFUSED' })).toEqual({
      status: 'unhealthy',
      reason: 'network-econnrefused',
    });
  });

  it('unhealthy on timeout', () => {
    expect(classifyProbe({ status: 0, error: 'ETIMEDOUT' })).toEqual({
      status: 'unhealthy',
      reason: 'network-etimedout',
    });
  });

  it('treats 4xx as healthy server / wrong probe path (does not bounce a working server)', () => {
    expect(classifyProbe({ status: 404 }).status).toBe('healthy');
  });

  it('flags missing body marker as unhealthy when the caller asked for one', () => {
    expect(classifyProbe({ status: 200, body: 'not the marker', bodyMarker: 'EXPECTED' })).toEqual({
      status: 'unhealthy',
      reason: 'body-marker-missing',
    });
  });

  it('healthy when body marker is present', () => {
    expect(classifyProbe({ status: 200, body: 'has EXPECTED inside', bodyMarker: 'EXPECTED' }).status).toBe(
      'healthy',
    );
  });

  it('unhealthy on a missing/null probe object (defensive)', () => {
    // @ts-expect-error feeding null on purpose
    expect(classifyProbe(null).status).toBe('unhealthy');
    // @ts-expect-error feeding undefined on purpose
    expect(classifyProbe(undefined).status).toBe('unhealthy');
  });
});

describe('mergeAllowedOrigins', () => {
  it('adds both https and http variants for a fresh host', () => {
    const r = mergeAllowedOrigins(undefined, 'fresh-host.trycloudflare.com');
    expect(r.changed).toBe(true);
    expect(r.value).toBe('https://fresh-host.trycloudflare.com,http://fresh-host.trycloudflare.com');
  });

  it('preserves existing entries when adding a new host', () => {
    const r = mergeAllowedOrigins('http://example.com', 'new-host.trycloudflare.com');
    expect(r.changed).toBe(true);
    expect(r.value.startsWith('http://example.com,')).toBe(true);
    expect(r.value).toContain('https://new-host.trycloudflare.com');
  });

  it('returns changed=false when both variants are already present', () => {
    const existing = 'https://known.trycloudflare.com,http://known.trycloudflare.com';
    const r = mergeAllowedOrigins(existing, 'known.trycloudflare.com');
    expect(r.changed).toBe(false);
    expect(r.value).toBe(existing);
  });

  it('tolerates whitespace and empty entries in the existing value', () => {
    const r = mergeAllowedOrigins('  http://example.com , ,  ', 'foo.trycloudflare.com');
    expect(r.value.includes(',,')).toBe(false);
    expect(r.value.startsWith('http://example.com,https://foo.trycloudflare.com')).toBe(true);
  });

  it('returns changed=false on a missing host', () => {
    const r = mergeAllowedOrigins('http://example.com', '');
    expect(r.changed).toBe(false);
    expect(r.value).toBe('http://example.com');
  });
});
