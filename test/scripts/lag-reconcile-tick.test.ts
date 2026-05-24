/**
 * Unit tests for scripts/lag-reconcile-tick.mjs.
 *
 * The test surface follows the canon scripts/lib/<name>.mjs pattern
 * (see feedback_shebang_import_from_tests): the driver script
 * scripts/lag-reconcile-tick.mjs spawns gh-as.mjs subprocesses, and
 * vitest on Windows-CI cannot strip shebangs from `.mjs` files
 * imported by `.test.ts`. The helper module
 * scripts/lib/lag-reconcile-tick.mjs is shebang-free; the tests
 * exercise:
 *
 *   - argv parsing
 *   - operator-principal resolution
 *   - parsePrViewJson defensive parser
 *   - buildHealObservationAtom shape (matches the apps/console
 *     server/live-ops.ts consumer contract)
 *   - end-to-end one-tick orchestration with an injected refresher
 *     stub + an in-memory host, asserting the three passes compose
 *     correctly (refresh -> reconcile -> reap) and the final atom
 *     state matches expectations
 *
 * No subprocess spawn anywhere in this suite.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PR_TIMEOUT_MS,
  buildHealObservationAtom,
  createInlineGhRefresher,
  findLatestPrObservation,
  formatTickSummary,
  parseArgs,
  parsePrViewJson,
  resolveOperatorPrincipal,
} from '../../scripts/lib/lag-reconcile-tick.mjs';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { runPlanObservationRefreshTick } from '../../src/runtime/plans/pr-observation-refresh.js';
import { runPlanStateReconcileTick } from '../../src/runtime/plans/pr-merge-reconcile.js';
import { runReaperSweep } from '../../src/runtime/plans/reaper.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../../src/types.js';

const NOW = '2026-05-24T00:00:00.000Z' as Time;
const OPERATOR = 'apex-agent' as PrincipalId;
const OWNER = 'stephengardner';
const REPO = 'layered-autonomous-governance';

/**
 * Stub mkPrObservationAtomId for tests: deterministic format so the
 * suite can pin the contract without dragging in the dist tree.
 */
function mkAtomIdStub(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  observedAt: string,
): string {
  const shaSuffix = String(headSha).slice(0, 12);
  const minute = String(observedAt).slice(0, 16).replace(/[^0-9]/g, '');
  return `pr-observation-${owner}-${repo}-${number}-${shaSuffix}-${minute}`;
}

function planAtom(
  id: string,
  overrides: {
    readonly plan_state?: PlanState;
    readonly created_at?: Time;
    readonly tainted?: boolean;
    readonly superseded?: boolean;
  } = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan body',
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor' },
      derived_from: [],
    },
    confidence: 0.9,
    created_at: overrides.created_at ?? NOW,
    last_reinforced_at: overrides.created_at ?? NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: overrides.superseded ? ['replacement' as AtomId] : [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'cto-actor' as PrincipalId,
    taint: overrides.tainted ? 'tainted' : 'clean',
    plan_state: overrides.plan_state ?? 'executing',
    metadata: { title: 'test plan' },
  };
}

function prObservationAtom(
  id: string,
  overrides: {
    readonly pr_state?: 'OPEN' | 'CLOSED' | 'MERGED';
    readonly observed_at?: string;
    readonly plan_id?: string;
    readonly pr_number?: number;
  } = {},
): Atom {
  const prNumber = overrides.pr_number ?? 42;
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'pr-observation body',
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'lag-pr-landing' },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: overrides.observed_at ?? NOW,
    last_reinforced_at: overrides.observed_at ?? NOW,
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
    principal_id: 'lag-pr-landing' as PrincipalId,
    taint: 'clean',
    metadata: {
      kind: 'pr-observation',
      pr: { owner: OWNER, repo: REPO, number: prNumber },
      head_sha: 'deadbeefcafe',
      observed_at: overrides.observed_at ?? NOW,
      pr_state: overrides.pr_state ?? 'OPEN',
      plan_id: overrides.plan_id ?? 'p1',
    },
  };
}

describe('parseArgs', () => {
  it('returns sensible defaults for empty argv', () => {
    const r = parseArgs([]);
    expect(r.rootDir).toBeUndefined();
    expect(r.prTimeoutMs).toBe(DEFAULT_PR_TIMEOUT_MS);
    expect(r.bot).toBe('lag-ceo');
    expect(r.skipRefresh).toBe(false);
    expect(r.skipReconcile).toBe(false);
    expect(r.skipReap).toBe(false);
    expect(r.help).toBe(false);
  });

  it('honors --help and -h flags', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('honors skip flags', () => {
    expect(parseArgs(['--skip-refresh']).skipRefresh).toBe(true);
    expect(parseArgs(['--skip-reconcile']).skipReconcile).toBe(true);
    expect(parseArgs(['--skip-reap']).skipReap).toBe(true);
  });

  it('parses --root and --bot', () => {
    const r = parseArgs(['--root', '/tmp/lag', '--bot', 'lag-cto']);
    expect(r.rootDir).toBe('/tmp/lag');
    expect(r.bot).toBe('lag-cto');
  });

  it('parses numeric flags as positive numbers', () => {
    const r = parseArgs([
      '--pr-timeout-ms', '5000',
      '--max-scan', '100',
      '--max-refreshes', '10',
    ]);
    expect(r.prTimeoutMs).toBe(5000);
    expect(r.maxScan).toBe(100);
    expect(r.maxRefreshes).toBe(10);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--no-such-flag'])).toThrow(/--no-such-flag/);
  });

  it('rejects positional arguments', () => {
    expect(() => parseArgs(['unexpected'])).toThrow(/unexpected/);
  });
});

describe('resolveOperatorPrincipal', () => {
  it('returns LAG_RECONCILE_TICK_PRINCIPAL when set', () => {
    expect(resolveOperatorPrincipal({ LAG_RECONCILE_TICK_PRINCIPAL: 'tick-bot' })).toBe('tick-bot');
  });

  it('falls back to LAG_OPERATOR_ID', () => {
    expect(resolveOperatorPrincipal({ LAG_OPERATOR_ID: 'apex' })).toBe('apex');
  });

  it('returns null when neither is set', () => {
    expect(resolveOperatorPrincipal({})).toBeNull();
  });

  it('prefers LAG_RECONCILE_TICK_PRINCIPAL over LAG_OPERATOR_ID', () => {
    expect(
      resolveOperatorPrincipal({
        LAG_RECONCILE_TICK_PRINCIPAL: 'tick-bot',
        LAG_OPERATOR_ID: 'apex',
      }),
    ).toBe('tick-bot');
  });

  it('treats empty strings as unset', () => {
    expect(
      resolveOperatorPrincipal({
        LAG_RECONCILE_TICK_PRINCIPAL: '',
        LAG_OPERATOR_ID: '',
      }),
    ).toBeNull();
  });
});

describe('parsePrViewJson', () => {
  it('parses MERGED state with all fields', () => {
    const raw = JSON.stringify({
      state: 'MERGED',
      mergedAt: '2026-05-24T01:00:00Z',
      headRefOid: 'abcdef1234567890',
      headRefName: 'feat/x',
      baseRefName: 'main',
      number: 100,
      title: 'feat: x',
    });
    const r = parsePrViewJson(raw);
    expect(r).not.toBeNull();
    expect(r?.state).toBe('MERGED');
    expect(r?.mergedAt).toBe('2026-05-24T01:00:00Z');
    expect(r?.headRefOid).toBe('abcdef1234567890');
    expect(r?.title).toBe('feat: x');
  });

  it('parses CLOSED state', () => {
    const r = parsePrViewJson(JSON.stringify({ state: 'CLOSED', number: 1 }));
    expect(r?.state).toBe('CLOSED');
    expect(r?.mergedAt).toBeNull();
  });

  it('parses OPEN state', () => {
    const r = parsePrViewJson(JSON.stringify({ state: 'OPEN', number: 1 }));
    expect(r?.state).toBe('OPEN');
  });

  it('uppercases lowercase state', () => {
    expect(parsePrViewJson(JSON.stringify({ state: 'merged' }))?.state).toBe('MERGED');
  });

  it('returns null for malformed JSON', () => {
    expect(parsePrViewJson('not-json')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parsePrViewJson('')).toBeNull();
    expect(parsePrViewJson('   ')).toBeNull();
  });

  it('returns null for missing state', () => {
    expect(parsePrViewJson(JSON.stringify({}))).toBeNull();
  });

  it('returns null for unknown state value', () => {
    expect(parsePrViewJson(JSON.stringify({ state: 'DRAFT' }))).toBeNull();
  });

  it('returns null for non-string raw input', () => {
    expect(parsePrViewJson(123 as unknown as string)).toBeNull();
    expect(parsePrViewJson(null as unknown as string)).toBeNull();
  });
});

describe('buildHealObservationAtom', () => {
  const stale: Atom = prObservationAtom('stale-1', { pr_state: 'OPEN' });
  const live = {
    state: 'MERGED' as const,
    mergedAt: '2026-05-24T01:00:00Z',
    headRefOid: 'feedfacecafe1234',
    title: 'feat: x',
  };

  it('builds a fresh observation atom with terminal state', () => {
    const heal = buildHealObservationAtom({
      stale,
      live,
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    });
    expect(heal.metadata.kind).toBe('pr-observation');
    expect(heal.metadata.pr_state).toBe('MERGED');
    expect(heal.metadata.mergedAt).toBe('2026-05-24T01:00:00Z');
    expect(heal.metadata.head_sha).toBe('feedfacecafe1234');
    expect(heal.metadata.plan_id).toBe('p1');
    expect(heal.metadata.partial).toBe(true);
    expect(heal.metadata.partial_surfaces).toEqual(['all']);
    expect(heal.metadata.pr).toEqual({ owner: OWNER, repo: REPO, number: 42 });
    expect(heal.metadata.pr_title).toBe('feat: x');
  });

  it('chains supersedes + derived_from to the stale predecessor', () => {
    const heal = buildHealObservationAtom({
      stale,
      live,
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    });
    expect(heal.supersedes).toEqual(['stale-1']);
    expect(heal.provenance.derived_from).toEqual(['stale-1', 'p1']);
  });

  it('attributes to the provided principal_id', () => {
    const heal = buildHealObservationAtom({
      stale,
      live,
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    });
    expect(heal.principal_id).toBe('apex');
    expect(heal.provenance.source.agent_id).toBe('apex');
    expect(heal.provenance.source.tool).toBe('lag-reconcile-tick');
  });

  it('falls back to stale head_sha when live headRefOid is empty', () => {
    const liveNoHead = { ...live, headRefOid: '' };
    const heal = buildHealObservationAtom({
      stale,
      live: liveNoHead,
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    });
    expect(heal.metadata.head_sha).toBe('deadbeefcafe');
  });

  it('omits pr_title when live title is empty', () => {
    const liveNoTitle = { ...live, title: '' };
    const heal = buildHealObservationAtom({
      stale,
      live: liveNoTitle,
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    });
    expect(heal.metadata.pr_title).toBeUndefined();
  });

  it('omits mergedAt when live PR is OPEN/CLOSED without merged_at', () => {
    const heal = buildHealObservationAtom({
      stale,
      live: { ...live, state: 'CLOSED', mergedAt: null },
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    });
    expect(heal.metadata.mergedAt).toBeUndefined();
    expect(heal.metadata.pr_state).toBe('CLOSED');
  });

  it('throws when stale metadata is missing pr field', () => {
    const broken: Atom = { ...stale, metadata: {} as Record<string, unknown> };
    expect(() => buildHealObservationAtom({
      stale: broken,
      live,
      planId: 'p1',
      principalId: 'apex',
      nowIso: NOW,
      mkPrObservationAtomId: mkAtomIdStub,
    })).toThrow(/metadata\.pr/);
  });
});

describe('formatTickSummary', () => {
  it('shapes refresh/reconcile/reap counts into a single line', () => {
    const line = formatTickSummary({
      refresh: { refreshed: 2, scanned: 100, skipped: { 'rate-limited': 1 } },
      reconcile: { scanned: 50, matched: 2, transitioned: 2, claimConflicts: 0 },
      reap: { classified: 10, abandoned: 1, truncated: false },
    });
    expect(line).toContain('refresh: refreshed=2 scanned=100 rate-limited=1');
    expect(line).toContain('reconcile: scanned=50 matched=2 transitioned=2 claim-conflicts=0');
    expect(line).toContain('reap: classified=10 abandoned=1');
    expect(line).not.toContain('TRUNCATED');
  });

  it('marks truncated reap result', () => {
    const line = formatTickSummary({
      refresh: { refreshed: 0, scanned: 0, skipped: {} },
      reconcile: { scanned: 0, matched: 0, transitioned: 0, claimConflicts: 0 },
      reap: { classified: 100, abandoned: 0, truncated: true },
    });
    expect(line).toContain('TRUNCATED');
  });
});

describe('findLatestPrObservation', () => {
  it('returns the most recent non-superseded pr-observation for the PR', async () => {
    const host = createMemoryHost();
    const older = prObservationAtom('older', { observed_at: '2026-05-22T00:00:00.000Z' });
    const newer = prObservationAtom('newer', { observed_at: '2026-05-23T00:00:00.000Z' });
    await host.atoms.put(older);
    await host.atoms.put(newer);
    const result = await findLatestPrObservation(host, { owner: OWNER, repo: REPO, number: 42 });
    expect(result?.id).toBe('newer');
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const newer = prObservationAtom('newer', { observed_at: '2026-05-23T00:00:00.000Z' });
    const replacement: Atom = {
      ...prObservationAtom('replacement', { observed_at: '2026-05-22T00:00:00.000Z' }),
      superseded_by: ['something-else' as AtomId],
    };
    await host.atoms.put(newer);
    await host.atoms.put(replacement);
    const result = await findLatestPrObservation(host, { owner: OWNER, repo: REPO, number: 42 });
    expect(result?.id).toBe('newer');
  });

  it('returns null when no matching observation exists', async () => {
    const host = createMemoryHost();
    const result = await findLatestPrObservation(host, { owner: OWNER, repo: REPO, number: 999 });
    expect(result).toBeNull();
  });

  it('does not match other PRs', async () => {
    const host = createMemoryHost();
    await host.atoms.put(prObservationAtom('other', { pr_number: 41 }));
    const result = await findLatestPrObservation(host, { owner: OWNER, repo: REPO, number: 42 });
    expect(result).toBeNull();
  });
});

describe('end-to-end tick orchestration (in-memory)', () => {
  /**
   * Operator-spec coverage: seed a temp store with a stale OPEN
   * pr-observation, an `executing` plan linked by metadata.plan_id, and
   * a 96-hour-old `proposed` plan. Use a stub refresher that returns
   * MERGED. After one tick assert:
   *   - new pr-observation has pr_state=MERGED superseding the old one
   *   - executing plan transitions to succeeded
   *   - proposed plan transitions to abandoned
   */
  it('refresh + reconcile + reap compose into the expected substrate state', async () => {
    const host = createMemoryHost();
    const NOW_MS = Date.parse(NOW);
    // 96h old proposed plan: well past the 72h abandon TTL.
    const NINETY_SIX_HOURS_AGO = new Date(NOW_MS - 96 * 60 * 60 * 1000).toISOString() as Time;
    // 10-minute-old observation: past the 5-minute freshness window.
    const TEN_MIN_AGO = new Date(NOW_MS - 10 * 60 * 1000).toISOString() as Time;

    await host.atoms.put(planAtom('plan-executing', { plan_state: 'executing' }));
    await host.atoms.put(planAtom('plan-proposed-stale', {
      plan_state: 'proposed',
      created_at: NINETY_SIX_HOURS_AGO,
    }));
    await host.atoms.put(prObservationAtom('obs-stale', {
      pr_state: 'OPEN',
      observed_at: TEN_MIN_AGO,
      plan_id: 'plan-executing',
    }));

    // Inject a stub refresher: returns MERGED for the executing plan's
    // PR. Operator spec calls for the refresher to be mocked so no
    // subprocess spawn happens in the test.
    const refresher = createInlineGhRefresher({
      host,
      principalId: OPERATOR,
      bot: 'lag-ceo',
      prTimeoutMs: 1000,
      mkPrObservationAtomId: mkAtomIdStub,
      nowFn: () => new Date(NOW_MS),
      fetchLivePrStateImpl: async () => ({
        state: 'MERGED',
        mergedAt: '2026-05-24T01:00:00Z',
        headRefOid: 'cafef00dbaad1234',
        headRefName: 'feat/x',
        baseRefName: 'main',
        number: 42,
        title: 'feat(test): merged via stub',
      }),
    });

    // Pass 1: refresh stale observations.
    const refresh = await runPlanObservationRefreshTick(host, refresher, {
      maxScan: 1000,
      maxRefreshes: 50,
      now: () => NOW,
    });
    expect(refresh.refreshed).toBe(1);

    // Pass 2: reconcile plan state from terminal observation.
    const reconcile = await runPlanStateReconcileTick(host, {
      now: () => NOW,
      maxScan: 1000,
    });
    expect(reconcile.transitioned).toBe(1);

    // Pass 3: reap chronically-stale proposed plans.
    // Pin the host clock so the reaper picks 96h-old plan as abandon.
    host.clock = { now: () => NOW } as never;
    const reap = await runReaperSweep(host, OPERATOR, {
      staleWarnMs: 24 * 60 * 60 * 1000,
      staleAbandonMs: 72 * 60 * 60 * 1000,
    });
    // Reaper only abandons proposed plans past TTL; the executing plan
    // is handled by reconcile (transitions to succeeded). Only one plan
    // hits the abandon bucket: the 96h-old proposed plan.
    expect(reap.apply.abandoned.length).toBe(1);
    expect(reap.apply.abandoned[0]?.atomId).toBe('plan-proposed-stale');

    // Walk back through the assertions: pull each atom and verify.
    const executing = await host.atoms.get('plan-executing' as AtomId);
    expect(executing?.plan_state).toBe('succeeded');

    const proposed = await host.atoms.get('plan-proposed-stale' as AtomId);
    expect(proposed?.plan_state).toBe('abandoned');

    // The fresh observation should exist with pr_state=MERGED and
    // supersedes pointing at the stale obs.
    const freshObs = await findLatestPrObservation(host, {
      owner: OWNER,
      repo: REPO,
      number: 42,
    });
    expect(freshObs).not.toBeNull();
    expect(freshObs?.metadata.pr_state).toBe('MERGED');
    expect(freshObs?.supersedes).toContain('obs-stale');

    // The stale observation should now carry superseded_by pointing
    // at the heal atom.
    const stale = await host.atoms.get('obs-stale' as AtomId);
    expect(stale?.superseded_by.length).toBeGreaterThan(0);
  });
});
