import { describe, it, expect } from 'vitest';
import { SameMachineCliResumeStrategy } from '../../../../../examples/agent-loops/resume-author/strategies/same-machine.js';
import type { CandidateSession, ResumeContext } from '../../../../../examples/agent-loops/resume-author/types.js';
import type { Workspace } from '../../../../../src/substrate/workspace-provider.js';
import type { Host } from '../../../../../src/substrate/interface.js';
import type { AtomId } from '../../../../../src/substrate/types.js';

const stubWs = { id: 'ws-1', path: '/tmp/ws', baseRef: 'main' } as Workspace;
const stubHost = {} as unknown as Host;

/**
 * Build a ResumeContext from partial candidate inputs. The candidates
 * are normalized THEN sorted newest-first to honor the documented
 * `ResumeContext.candidateSessions` precondition (see types.ts:31). The
 * strategy under test relies on that ordering: `find()` returns the
 * first non-stale candidate, so a caller passing unsorted candidates
 * would see different behavior. Tests should match the contract; an
 * unsorted-input case is added separately to assert the strategy's
 * dependency on the precondition is the documented one.
 */
function makeCtx(candidates: ReadonlyArray<Partial<CandidateSession>>): ResumeContext {
  const normalized = candidates.map((c, i) => ({
    sessionAtomId: (c.sessionAtomId ?? `s${i}`) as AtomId,
    resumableSessionId: c.resumableSessionId ?? `uuid-${i}`,
    startedAt: c.startedAt ?? new Date().toISOString(),
    extra: c.extra ?? {},
    adapterId: c.adapterId ?? 'claude-code-agent-loop',
  }));
  // Newest-first sort to match the documented contract on
  // ResumeContext.candidateSessions. Stable sort (Array.prototype.sort
  // in V8 is stable) so equal startedAt values preserve input order.
  const sorted = [...normalized].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  return {
    candidateSessions: sorted,
    workspace: stubWs,
    host: stubHost,
  };
}

const oneHourAgo = () => new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
const nineHoursAgo = () => new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();

describe('SameMachineCliResumeStrategy', () => {
  it('returns null when no candidates', async () => {
    const ctx = makeCtx([]);
    const s = new SameMachineCliResumeStrategy();
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('returns the freshest claude-code candidate within maxStaleHours', async () => {
    const ctx = makeCtx([
      { adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo(), resumableSessionId: 'stale-uuid', sessionAtomId: 'a' as AtomId },
      { adapterId: 'claude-code-agent-loop', startedAt: oneHourAgo(), resumableSessionId: 'fresh-uuid', sessionAtomId: 'b' as AtomId },
    ]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    const r = await s.findResumableSession(ctx);
    expect(r?.resumableSessionId).toBe('fresh-uuid');
    expect(r?.strategyName).toBe('same-machine-cli');
    expect(r?.resumedFromSessionAtomId).toBe('b');
    expect(r?.preparation).toBeUndefined();  // same-machine needs no preparation
  });

  it('skips non-claude-code adapters', async () => {
    const ctx = makeCtx([{ adapterId: 'langgraph', startedAt: oneHourAgo() }]);
    const s = new SameMachineCliResumeStrategy();
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('skips all-stale candidates', async () => {
    const ctx = makeCtx([{ adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo() }]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('default maxStaleHours is 8', async () => {
    const ctx = makeCtx([
      { adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo(), resumableSessionId: 'stale' },
    ]);
    const s = new SameMachineCliResumeStrategy();  // no opts
    expect(await s.findResumableSession(ctx)).toBeNull();
  });

  it('respects custom maxStaleHours via constructor opts', async () => {
    const ctx = makeCtx([
      { adapterId: 'claude-code-agent-loop', startedAt: nineHoursAgo(), resumableSessionId: 'mine' },
    ]);
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 24 });
    const r = await s.findResumableSession(ctx);
    expect(r?.resumableSessionId).toBe('mine');
  });

  it('depends on the documented newest-first precondition (regression note)', async () => {
    // Documents the precondition that
    // ResumeContext.candidateSessions is sorted newest-first
    // (types.ts:31). The strategy uses Array.find() and returns the
    // first non-stale candidate; if a caller violates the precondition
    // and passes unsorted candidates, find() may return a stale-but-
    // newer-in-list candidate instead of the freshest one. This test
    // builds a ResumeContext directly (bypassing makeCtx's sort) to
    // pin the contract: when the precondition is violated, the
    // strategy returns whatever the caller put first. The fix is at
    // the caller level (assemble candidates newest-first), NOT in the
    // strategy.
    const oldButFresh = oneHourAgo();
    const newer = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const ctx: ResumeContext = {
      candidateSessions: [
        {
          sessionAtomId: 'older' as AtomId,
          resumableSessionId: 'older-uuid',
          startedAt: oldButFresh,
          extra: {},
          adapterId: 'claude-code-agent-loop',
        },
        {
          sessionAtomId: 'newer' as AtomId,
          resumableSessionId: 'newer-uuid',
          startedAt: newer,
          extra: {},
          adapterId: 'claude-code-agent-loop',
        },
      ],
      workspace: stubWs,
      host: stubHost,
    };
    const s = new SameMachineCliResumeStrategy({ maxStaleHours: 8 });
    const r = await s.findResumableSession(ctx);
    // With the precondition violated (older listed first), the
    // strategy resolves to that older candidate. Documents the
    // behaviour so future readers see the dependency on input order.
    expect(r?.resumableSessionId).toBe('older-uuid');
  });
});
