/**
 * Tests for the self-audit LoopRunner pass wiring.
 *
 * Covers two surfaces:
 *
 *   - `loadSelfAuditCadence`: subject-discriminated canon reader
 *     returning `{enabled, intervalMs}`. Mirrors the contract of
 *     `readLoopPassClaimReaperFromCanon`: hardcoded default on
 *     absence, warn + hardcoded default on malformed payload, skip
 *     tainted / superseded atoms.
 *
 *   - `LoopRunner` pass wiring: the runner skips the self-audit pass
 *     when `runSelfAuditPass` defaults to false (selfAuditReport ===
 *     null), invokes the supplied closure when the option AND canon
 *     enable it, honors the cadence interval across multiple ticks,
 *     and the pass's independent try/catch keeps a throw in the
 *     closure from short-circuiting the rest of the tick.
 *
 * The runner tests pass a `vi.fn()` closure so the wiring is exercised
 * without seeding any external subprocess. The reader contract is
 * exercised independently above.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { LoopRunner } from '../../../src/runtime/loop/runner.js';
import {
  loadSelfAuditCadence,
  DEFAULT_SELF_AUDIT_CADENCE,
} from '../../../src/substrate/policy/self-audit-cadence.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-22T12:00:00.000Z' as Time;
const principal = 'loop-test' as PrincipalId;

/**
 * Direct console.error replacement for capture-on-test. The vitest
 * config in this repo runs with `globals: false` and the
 * vi.spyOn(console, 'error') interception has been unreliable in
 * that mode; direct replacement works in both contexts. Mirrors the
 * shape of test/runtime/loop/claim-reaper-pass.test.ts.
 */
function captureStderr(): {
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  restore: () => void;
} {
  const original = console.error;
  const captured: unknown[][] = [];
  const replacement: typeof console.error = (...args: unknown[]): void => {
    captured.push(args);
  };
  console.error = replacement;
  return {
    calls: captured,
    restore: () => {
      console.error = original;
    },
  };
}

interface PolicyFields {
  readonly enabled?: unknown;
  readonly intervalMs?: unknown;
}

function policyAtom(id: string, fields: PolicyFields): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'self-audit-cadence policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'self-audit-cadence',
        ...fields,
      },
    },
  };
}

describe('loadSelfAuditCadence', () => {
  it('returns the hardcoded default when no canon atom exists', async () => {
    const host = createMemoryHost();
    const result = await loadSelfAuditCadence(host);
    expect(result).toEqual(DEFAULT_SELF_AUDIT_CADENCE);
    expect(result.enabled).toBe(false);
    expect(result.intervalMs).toBe(3_600_000);
  });

  it('returns the configured cadence when policy atom is present and well-formed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const result = await loadSelfAuditCadence(host);
    expect(result).toEqual({ enabled: true, intervalMs: 100 });
  });

  it('returns the default + warns when enabled field is a non-boolean (string)', async () => {
    const host = createMemoryHost();
    // The wire-format failure mode under test: an operator-typed
    // "true" string. Strict typing on the reader prevents the
    // coercion-flipping foot-gun documented in the reader doc.
    await host.atoms.put(policyAtom('pol-bad-enabled', {
      enabled: 'true',
      intervalMs: 100,
    }));
    const cap = captureStderr();
    try {
      const result = await loadSelfAuditCadence(host);
      expect(result).toEqual(DEFAULT_SELF_AUDIT_CADENCE);
      expect(cap.calls.length).toBeGreaterThan(0);
      expect(String(cap.calls[0]?.[0])).toContain('malformed payload');
      expect(String(cap.calls[0]?.[0])).toContain('enabled');
    } finally {
      cap.restore();
    }
  });

  it('returns the default + warns when intervalMs is zero', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bad-interval-zero', {
      enabled: true,
      intervalMs: 0,
    }));
    const cap = captureStderr();
    try {
      const result = await loadSelfAuditCadence(host);
      expect(result).toEqual(DEFAULT_SELF_AUDIT_CADENCE);
      expect(cap.calls.length).toBeGreaterThan(0);
      expect(String(cap.calls[0]?.[0])).toContain('intervalMs');
    } finally {
      cap.restore();
    }
  });

  it('returns the default + warns when intervalMs is negative', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-bad-interval-negative', {
      enabled: true,
      intervalMs: -100,
    }));
    const cap = captureStderr();
    try {
      const result = await loadSelfAuditCadence(host);
      expect(result).toEqual(DEFAULT_SELF_AUDIT_CADENCE);
      expect(cap.calls.length).toBeGreaterThan(0);
    } finally {
      cap.restore();
    }
  });

  it('skips tainted atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-tainted', { enabled: true, intervalMs: 100 });
    await host.atoms.put({ ...atom, taint: 'tainted' });
    const result = await loadSelfAuditCadence(host);
    expect(result).toEqual(DEFAULT_SELF_AUDIT_CADENCE);
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-superseded', { enabled: true, intervalMs: 100 });
    await host.atoms.put({ ...atom, superseded_by: ['pol-newer' as AtomId] });
    const result = await loadSelfAuditCadence(host);
    expect(result).toEqual(DEFAULT_SELF_AUDIT_CADENCE);
  });
});

describe('LoopRunner self-audit pass wiring', () => {
  let auditTick: ReturnType<typeof vi.fn<[], Promise<void>>>;

  beforeEach(() => {
    auditTick = vi.fn(async () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the pass entirely when runSelfAuditPass is false (default)', async () => {
    // Even with a cadence policy enabling the audit, the option-gate
    // default suppresses the pass. selfAuditReport === null marks
    // "pass did not run" while the closure stays uncalled.
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      selfAuditTick: auditTick,
      // runSelfAuditPass intentionally omitted (defaults to false)
    });
    const report = await runner.tick();
    expect(report.selfAuditReport).toBeNull();
    expect(auditTick).not.toHaveBeenCalled();
  });

  it('does not fire the closure when runSelfAuditPass=true but no cadence atom is seeded', async () => {
    // Defaults from the reader: `enabled: false`. The pass runs (so
    // selfAuditReport is populated) but the closure stays uncalled
    // because the canon-default disables firing. This is the
    // default-off posture: opting into the flag without seeding canon
    // is a no-op until canon turns it on.
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    const runner = new LoopRunner(host, {
      principalId: principal,
      runSelfAuditPass: true,
      selfAuditTick: auditTick,
    });
    const report = await runner.tick();
    expect(report.selfAuditReport).toEqual({ fired: false, closureErrorMs: null });
    expect(auditTick).not.toHaveBeenCalled();
  });

  it('fires the closure on the first tick when canon enables the cadence', async () => {
    // First fire: `lastSelfAuditAt` starts null, so any tick after
    // canon enables the cadence fires the closure regardless of
    // interval. Subsequent tests cover the interval-gating path.
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const cap = captureStderr();
    try {
      const runner = new LoopRunner(host, {
        principalId: principal,
        runSelfAuditPass: true,
        selfAuditTick: auditTick,
      });
      const report = await runner.tick();
      expect(report.selfAuditReport).toEqual({ fired: true, closureErrorMs: null });
      expect(auditTick).toHaveBeenCalledTimes(1);
      // Loud-at-boundaries: the runner logs one line naming the
      // cadence when the closure fires.
      expect(cap.calls.some((args) => String(args[0]).includes('[self-audit] firing'))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('honors the cadence interval across consecutive ticks (no fire when < intervalMs elapsed)', async () => {
    // Two ticks at the same clock instant: the first fires (cadence
    // anchor was null); the second observes a 0-ms delta against the
    // 100-ms intervalMs and SKIPS the fire. The closure is called
    // exactly once across both ticks.
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runSelfAuditPass: true,
      selfAuditTick: auditTick,
    });
    const first = await runner.tick();
    expect(first.selfAuditReport).toEqual({ fired: true, closureErrorMs: null });
    // Second tick at the same clock instant: 0 ms elapsed, well
    // under the 100ms cadence floor. Pass runs but closure stays
    // uncalled; the fired flag flips false.
    const second = await runner.tick();
    expect(second.selfAuditReport).toEqual({ fired: false, closureErrorMs: null });
    expect(auditTick).toHaveBeenCalledTimes(1);
  });

  it('re-fires the closure once the cadence interval elapses', async () => {
    // First fire anchors the cadence; advance the clock past
    // intervalMs and the next tick re-fires. The closure is called
    // exactly twice across the three ticks (fire, skip, fire).
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const runner = new LoopRunner(host, {
      principalId: principal,
      runSelfAuditPass: true,
      selfAuditTick: auditTick,
    });
    // Tick 1: first fire.
    const first = await runner.tick();
    expect(first.selfAuditReport?.fired).toBe(true);
    // Tick 2: clock not advanced, cadence skip.
    const second = await runner.tick();
    expect(second.selfAuditReport?.fired).toBe(false);
    // Advance clock past 100ms.
    host.clock.advance(150);
    // Tick 3: cadence elapsed, re-fire.
    const third = await runner.tick();
    expect(third.selfAuditReport?.fired).toBe(true);
    expect(auditTick).toHaveBeenCalledTimes(2);
  });

  it('records the closure throw into errors[] without failing the tick', async () => {
    // Independence guarantee: a throw inside the closure surfaces in
    // `report.errors` and does NOT cascade into following passes.
    // The audit anchor is NOT advanced on throw so the next tick
    // re-attempts (the operator intent: a failed audit is "attempted
    // to fire", not "fired").
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const throwingTick = vi.fn(async () => {
      throw new Error('synthetic self-audit failure');
    });
    const cap = captureStderr();
    try {
      const runner = new LoopRunner(host, {
        principalId: principal,
        runSelfAuditPass: true,
        selfAuditTick: throwingTick,
      });
      const report = await runner.tick();
      // Closure was called.
      expect(throwingTick).toHaveBeenCalledTimes(1);
      // Throw recorded with full error message.
      expect(report.errors.some((e) => e.startsWith('self-audit-pass:'))).toBe(true);
      expect(
        report.errors.some((e) => e.includes('synthetic self-audit failure')),
      ).toBe(true);
      // Failure timing preserved: the catch extracts
      // `selfAuditClosureErrorMs` from the thrown error and surfaces
      // it into the report so a downstream consumer can correlate the
      // failure with elapsed wall-time. `fired: true` records that
      // the closure was reached (vs. a cadence skip or canon-read
      // fault which would carry `fired: false` or `selfAuditReport
      // === null`). The error path uses the same host clock so the
      // elapsed-ms is 0 in this synchronous-throw test; assert that
      // closureErrorMs is a number (not null) so the contract is
      // exercised without coupling to the specific timing value.
      expect(report.selfAuditReport).not.toBeNull();
      expect(report.selfAuditReport?.fired).toBe(true);
      expect(typeof report.selfAuditReport?.closureErrorMs).toBe('number');
      // Tick still completed: tickNumber and finishedAt are load-
      // bearing signals that the tick finished rather than halting
      // at the closure throw.
      expect(report.tickNumber).toBe(1);
      expect(report.finishedAt).not.toBe('');
    } finally {
      cap.restore();
    }
  });

  it('logs a once-per-runner warning when the option is true but no closure is supplied', async () => {
    // Caller opted into the flag from canon but did not yet wire the
    // closure (e.g. a deployment plans to wire it later). The pass
    // silent-skips and the runner warns once per runner; subsequent
    // ticks stay quiet so a misconfigured run does not flood stderr.
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-self-audit-cadence', {
      enabled: true,
      intervalMs: 100,
    }));
    const cap = captureStderr();
    try {
      const runner = new LoopRunner(host, {
        principalId: principal,
        runSelfAuditPass: true,
        // selfAuditTick intentionally omitted
      });
      const first = await runner.tick();
      expect(first.selfAuditReport).toBeNull();
      // Second tick: warning is latched, stays quiet.
      const second = await runner.tick();
      expect(second.selfAuditReport).toBeNull();
      const warns = cap.calls.filter((args) =>
        String(args[0]).includes('[self-audit]')
        && String(args[0]).includes('no selfAuditTick'),
      );
      // Exactly one warning across both ticks.
      expect(warns.length).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('does not fail the tick when canon-read throws during cadence resolution', async () => {
    // Isolation guarantee: `loadSelfAuditCadence` awaits an atom-store
    // query. A transient atom-store fault during gate resolution MUST
    // be contained by the pass's own try/catch so the tick keeps
    // running for downstream passes. Mirrors the analogous test on the
    // claim-reaper wiring (PR #394 flagged the unwrapped read as
    // Major).
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    // Stub host.atoms.query so the directive query inside the canon
    // reader throws. Other passes use other filters; do not break them.
    const realQuery = host.atoms.query.bind(host.atoms);
    (host.atoms as { query: typeof host.atoms.query }).query = async (
      filter,
      limit,
      cursor,
    ) => {
      const types = (filter as { type?: ReadonlyArray<string> } | undefined)?.type;
      const layers = (filter as { layer?: ReadonlyArray<string> } | undefined)?.layer;
      // Match the canon reader's exact query shape so other passes'
      // directive queries (e.g. promotion) continue working.
      if (types?.includes('directive') && layers?.includes('L3')) {
        throw new Error('synthetic atom-store failure during cadence read');
      }
      return realQuery(filter, limit, cursor);
    };
    const runner = new LoopRunner(host, {
      principalId: principal,
      runSelfAuditPass: true,
      selfAuditTick: auditTick,
    });
    const report = await runner.tick();
    expect(report.selfAuditReport).toBeNull();
    expect(report.errors.some((e) => e.startsWith('self-audit-pass:'))).toBe(true);
    // Closure was NOT called (the read threw before reaching it).
    expect(auditTick).not.toHaveBeenCalled();
    // Tick still completed.
    expect(report.tickNumber).toBe(1);
    expect(report.finishedAt).not.toBe('');
  });
});
