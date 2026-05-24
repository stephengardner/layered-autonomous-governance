/**
 * Pure helpers for scripts/lag-reconcile-tick.mjs.
 *
 * The driver wraps three existing substrate passes
 * (runPlanObservationRefreshTick + runPlanStateReconcileTick +
 * runReaperSweep) into a single one-shot tick suitable for cron, Windows
 * Task Scheduler, or any external orchestrator. The library file here
 * carries the pieces that benefit from unit tests:
 *
 *   - parseArgs: argv parsing
 *   - resolveOperatorPrincipal: env-var resolution with loud failure
 *   - buildHealObservationAtom: pure builder for the heal-shaped
 *     pr-observation atom the inline refresher writes
 *   - parsePrViewJson: defensive JSON parser for the `gh pr view --json`
 *     subprocess output
 *   - formatTickSummary: shapes the runtime result trio into the single
 *     stdout summary line the operator reads
 *
 * The orchestration (createFileHost + chained passes + auditor calls)
 * lives in the driver script alongside the kill-switch sentinel check,
 * so that subprocess spawn paths stay out of the test surface per the
 * shebang-import pattern documented at
 * feedback_shebang_import_from_tests.
 *
 * Tests import this module (shebang-free) directly per
 * scripts/lib/backfill-stale-pr-observations.mjs precedent.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/** Default per-PR gh subprocess timeout: 10 seconds. */
export const DEFAULT_PR_TIMEOUT_MS = 10_000;

/** Default upper bound on observation atoms scanned per refresh pass. */
export const DEFAULT_MAX_SCAN = 5_000;

/** Default upper bound on refresh subprocess calls per tick. */
export const DEFAULT_MAX_REFRESHES = 50;

/**
 * Parse argv into a structured options bag. Exposed for unit testing.
 *
 * @param {ReadonlyArray<string>} argv  argv slice WITHOUT `node script.mjs`
 * @returns {{
 *   rootDir: string | undefined,
 *   prTimeoutMs: number,
 *   bot: string,
 *   maxScan: number,
 *   maxRefreshes: number,
 *   skipRefresh: boolean,
 *   skipReconcile: boolean,
 *   skipReap: boolean,
 *   help: boolean,
 * }}
 */
export function parseArgs(argv) {
  const args = {
    rootDir: undefined,
    prTimeoutMs: DEFAULT_PR_TIMEOUT_MS,
    bot: 'lag-ceo',
    maxScan: DEFAULT_MAX_SCAN,
    maxRefreshes: DEFAULT_MAX_REFRESHES,
    skipRefresh: false,
    skipReconcile: false,
    skipReap: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    if (a === '--root' && argv[i + 1]) {
      args.rootDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--pr-timeout-ms' && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.prTimeoutMs = v;
      i += 1;
      continue;
    }
    if (a === '--bot' && argv[i + 1]) {
      args.bot = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--max-scan' && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.maxScan = v;
      i += 1;
      continue;
    }
    if (a === '--max-refreshes' && argv[i + 1]) {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) args.maxRefreshes = v;
      i += 1;
      continue;
    }
    if (a === '--skip-refresh') {
      args.skipRefresh = true;
      continue;
    }
    if (a === '--skip-reconcile') {
      args.skipReconcile = true;
      continue;
    }
    if (a === '--skip-reap') {
      args.skipReap = true;
      continue;
    }
    if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    }
    throw new Error(`Unexpected positional argument: ${a}`);
  }
  if (process.env.LAG_ROOT && args.rootDir === undefined) {
    args.rootDir = process.env.LAG_ROOT;
  }
  return args;
}

/**
 * Resolve the operator principal id used for inline refresh atom writes
 * and the reaper sweep's audit attribution. Returns the resolved string
 * or null when no env var supplies it; the driver fails loud with an
 * exit code in that case rather than guessing. Same discipline as
 * scripts/reap-stale-plans.mjs.
 *
 * Order: LAG_RECONCILE_TICK_PRINCIPAL, LAG_OPERATOR_ID. No silent
 * fallback to a hardcoded id; per
 * dev-no-hardcoded-principal-fallback an audit row attributing a write
 * to the wrong principal is worse than no write at all.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function resolveOperatorPrincipal(env) {
  const fromTick = env.LAG_RECONCILE_TICK_PRINCIPAL;
  if (typeof fromTick === 'string' && fromTick.length > 0) return fromTick;
  const fromOp = env.LAG_OPERATOR_ID;
  if (typeof fromOp === 'string' && fromOp.length > 0) return fromOp;
  return null;
}

/**
 * Parse the stdout of `gh pr view <n> --json state,mergedAt,headRefOid,
 * headRefName,baseRefName,number,title` into a typed object. Returns
 * null on any malformed input so a single bad payload does not halt the
 * tick.
 *
 * @param {string} raw
 * @returns {{
 *   state: 'OPEN' | 'CLOSED' | 'MERGED',
 *   mergedAt: string | null,
 *   headRefOid: string,
 *   headRefName: string,
 *   baseRefName: string,
 *   number: number,
 *   title: string,
 * } | null}
 */
export function parsePrViewJson(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.state !== 'string') return null;
  const state = parsed.state.toUpperCase();
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return null;
  return {
    state,
    mergedAt: typeof parsed.mergedAt === 'string' ? parsed.mergedAt : null,
    headRefOid: typeof parsed.headRefOid === 'string' ? parsed.headRefOid : '',
    headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : '',
    baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : '',
    number: typeof parsed.number === 'number' ? parsed.number : 0,
    title: typeof parsed.title === 'string' ? parsed.title : '',
  };
}

/**
 * Spawn `node scripts/gh-as.mjs <bot> pr view ...` to fetch live PR
 * state. Returns the parsed live snapshot on success, null on any
 * subprocess error (timeout, exit code, malformed payload). The caller
 * (the refresher) treats null as "refresh failed for this PR; counted
 * in skipped['refresh-failed'] by the framework tick".
 *
 * @param {{ owner: string, repo: string, number: number }} pr
 * @param {{ bot: string, prTimeoutMs: number, repoRoot?: string }} opts
 * @returns {Promise<{
 *   state: 'OPEN' | 'CLOSED' | 'MERGED',
 *   mergedAt: string | null,
 *   headRefOid: string,
 *   headRefName: string,
 *   baseRefName: string,
 *   number: number,
 *   title: string,
 * } | null>}
 */
export async function fetchLivePrState(pr, opts) {
  const { bot, prTimeoutMs, repoRoot = REPO_ROOT } = opts;
  const ghAsPath = resolve(repoRoot, 'scripts', 'gh-as.mjs');
  try {
    const result = await execa(process.execPath, [
      ghAsPath,
      bot,
      'pr',
      'view',
      String(pr.number),
      '--repo',
      `${pr.owner}/${pr.repo}`,
      '--json',
      'state,mergedAt,headRefOid,headRefName,baseRefName,number,title',
    ], {
      timeout: prTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if (result.exitCode !== 0) return null;
    return parsePrViewJson(result.stdout ?? '');
  } catch {
    return null;
  }
}

/**
 * Build a fresh pr-observation atom that supersedes the stale one,
 * shaped to match the existing pr-observation atom contract consumed by
 * apps/console/server/live-ops.ts and the merge-reconcile tick.
 *
 * Carries `partial: true` and `partial_surfaces: ['all']` because the
 * lightweight `gh pr view` query reports state + mergedAt + head SHA +
 * title only, not the full review tree (counts, reviews, check-runs).
 * A subsequent run-pr-landing observe-only run hydrates those surfaces.
 *
 * The atom-id generator is INJECTED so tests can pin the contract
 * without dragging in the full dist tree. Production callers wire in
 * mkPrObservationAtomId from dist/runtime/atoms/pr-observation-id.js.
 *
 * @param {{
 *   stale: { id: string, metadata?: Record<string, unknown> },
 *   live: {
 *     state: 'OPEN' | 'CLOSED' | 'MERGED',
 *     mergedAt: string | null,
 *     headRefOid: string,
 *     title: string,
 *   },
 *   planId: string,
 *   principalId: string,
 *   nowIso: string,
 *   mkPrObservationAtomId: (owner: string, repo: string, number: number, headSha: string, observedAt: string) => string,
 * }} inputs
 * @returns {object}
 */
export function buildHealObservationAtom(inputs) {
  const { stale, live, planId, principalId, nowIso, mkPrObservationAtomId } = inputs;
  const staleMeta = stale.metadata ?? {};
  const pr = staleMeta.pr;
  if (!pr || typeof pr !== 'object') {
    throw new Error('buildHealObservationAtom: stale.metadata.pr is required');
  }
  const headSha = live.headRefOid.length > 0
    ? live.headRefOid
    : (typeof staleMeta.head_sha === 'string' && staleMeta.head_sha.length > 0
      ? staleMeta.head_sha
      : 'unknown');
  const atomId = mkPrObservationAtomId(
    pr.owner,
    pr.repo,
    pr.number,
    headSha,
    nowIso,
  );
  const contentLines = [
    `**pr-observation refresh for ${pr.owner}/${pr.repo}#${pr.number}** (lag-reconcile-tick)`,
    '',
    `observed_at: ${nowIso}`,
    `head_sha: \`${headSha}\``,
    `pr_state: ${live.state}`,
  ];
  if (live.mergedAt) contentLines.push(`merged_at: ${live.mergedAt}`);
  contentLines.push(`plan_id: ${planId}`);
  contentLines.push('partial: true (lag-reconcile-tick; full review tree not re-queried)');
  contentLines.push('');
  contentLines.push(
    'Refreshed by the lag-reconcile-tick driver. A subsequent observe-only'
    + ' run of the pr-landing actor hydrates the full review tree.',
  );
  return {
    schema_version: 1,
    id: atomId,
    content: contentLines.join('\n'),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: principalId,
        tool: 'lag-reconcile-tick',
      },
      derived_from: [stale.id, planId],
    },
    confidence: 0.85,
    created_at: nowIso,
    last_reinforced_at: nowIso,
    expires_at: null,
    supersedes: [stale.id],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: principalId,
    taint: 'clean',
    metadata: {
      kind: 'pr-observation',
      pr: { owner: pr.owner, repo: pr.repo, number: pr.number },
      head_sha: headSha,
      observed_at: nowIso,
      pr_state: live.state,
      plan_id: planId,
      ...(live.mergedAt ? { mergedAt: live.mergedAt } : {}),
      ...(live.title && live.title.length > 0 ? { pr_title: live.title } : {}),
      partial: true,
      partial_surfaces: ['all'],
      counts: {
        line_comments: 0,
        body_nits: 0,
        submitted_reviews: 0,
        check_runs: 0,
        legacy_statuses: 0,
      },
    },
  };
}

/**
 * Format the per-tick summary. Single-line, parseable, mirrors the
 * existing tick-report shape so an operator scanning logs sees a
 * consistent surface.
 *
 * @param {{
 *   refresh: { refreshed: number, scanned: number, skipped: Record<string, number> },
 *   reconcile: { scanned: number, matched: number, transitioned: number, claimConflicts: number },
 *   reap: { classified: number, abandoned: number, truncated: boolean },
 * }} result
 * @returns {string}
 */
export function formatTickSummary(result) {
  const rateLimited = result.refresh.skipped['rate-limited'] ?? 0;
  return (
    '[lag-reconcile-tick] '
    + `refresh: refreshed=${result.refresh.refreshed} scanned=${result.refresh.scanned} rate-limited=${rateLimited} | `
    + `reconcile: scanned=${result.reconcile.scanned} matched=${result.reconcile.matched} transitioned=${result.reconcile.transitioned} claim-conflicts=${result.reconcile.claimConflicts} | `
    + `reap: classified=${result.reap.classified} abandoned=${result.reap.abandoned}${result.reap.truncated ? ' (TRUNCATED)' : ''}`
  );
}

/**
 * Build the inline refresher adapter the driver injects into
 * runPlanObservationRefreshTick. Keeps the GitHub-shaped concern in
 * the deployment shell per dev-substrate-not-prescription: the framework
 * tick consumes the seam, the driver supplies a concrete adapter that
 * spawns gh-as.mjs and writes the fresh atom.
 *
 * @param {{
 *   host: { atoms: { get: (id: string) => Promise<any>, put: (atom: any) => Promise<void>, update: (id: string, patch: any) => Promise<void> } },
 *   principalId: string,
 *   bot: string,
 *   prTimeoutMs: number,
 *   mkPrObservationAtomId: (owner: string, repo: string, number: number, headSha: string, observedAt: string) => string,
 *   nowFn?: () => Date,
 *   fetchLivePrStateImpl?: typeof fetchLivePrState,
 * }} opts
 * @returns {{ refresh: (args: { pr: { owner: string, repo: string, number: number }, plan_id: string }) => Promise<void> }}
 */
export function createInlineGhRefresher(opts) {
  const {
    host,
    principalId,
    bot,
    prTimeoutMs,
    mkPrObservationAtomId,
    nowFn = () => new Date(),
    fetchLivePrStateImpl = fetchLivePrState,
  } = opts;
  return {
    async refresh(args) {
      const { pr, plan_id } = args;
      const live = await fetchLivePrStateImpl(pr, { bot, prTimeoutMs });
      if (live === null) {
        // The framework tick counts a thrown error here as
        // skipped['refresh-failed']. We use the same surface to
        // signal "couldn't fetch live state".
        throw new Error(`lag-reconcile-tick refresher: gh pr view failed for ${pr.owner}/${pr.repo}#${pr.number}`);
      }
      // Locate the stale predecessor by walking the latest non-superseded
      // pr-observation chain for this PR. The framework tick already
      // narrowed to a stale observation, but it does not surface the
      // atom-id; we re-discover it by scanning. Cheap because the
      // store is filesystem-paged and the tick already gated this PR.
      // In practice the stale atom carries metadata.pr_state in
      // {OPEN, undefined} so the discriminator is reliable.
      const priorObservation = await findLatestPrObservation(host, pr);
      if (priorObservation === null) {
        // No prior observation: should not happen because the tick
        // narrowed by it, but defensively treat as a write of a fresh
        // atom with no supersedes. Use a stub id+metadata so the
        // builder still produces a valid heal atom shape.
        throw new Error(`lag-reconcile-tick refresher: prior observation vanished for ${pr.owner}/${pr.repo}#${pr.number}`);
      }
      const nowIso = nowFn().toISOString();
      const heal = buildHealObservationAtom({
        stale: priorObservation,
        live,
        planId: plan_id,
        principalId,
        nowIso,
        mkPrObservationAtomId,
      });
      // Idempotent: a second refresh inside the same minute for the
      // same head SHA collides on atom id and ConflictErrors via the
      // atom store. The framework counts that as refresh-failed and
      // moves on; the operator sees the existing fresh atom on the
      // next read. Same idempotency contract as
      // mkPrObservationAtomId.
      await host.atoms.put(heal);
      // Update the predecessor's superseded_by so consumers walking
      // the chain land on the heal atom. The atom-store merges into
      // existing superseded_by; existing entries are preserved.
      await host.atoms.update(priorObservation.id, {
        superseded_by: [heal.id],
      });
    },
  };
}

/**
 * Walk pages of observation atoms to find the latest non-superseded
 * pr-observation for the given PR. Cheap enough at indie scale (5000
 * atom cap mirrors the tick's maxScan); org-ceiling deployments can
 * override via --max-scan.
 *
 * @param {{ atoms: { query: (filter: any, limit: number, cursor?: string) => Promise<{ atoms: any[], nextCursor: string | null }> } }} host
 * @param {{ owner: string, repo: string, number: number }} pr
 * @returns {Promise<any | null>}
 */
export async function findLatestPrObservation(host, pr) {
  const PAGE_SIZE = 500;
  const MAX_SCAN = 5_000;
  let scanned = 0;
  let latest = null;
  let cursor;
  do {
    const remaining = MAX_SCAN - scanned;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['observation'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const atom of page.atoms) {
      scanned += 1;
      if (atom.taint && atom.taint !== 'clean') continue;
      if (atom.superseded_by && atom.superseded_by.length > 0) continue;
      const meta = atom.metadata ?? {};
      if (meta.kind !== 'pr-observation') continue;
      const obsPr = meta.pr;
      if (!obsPr || typeof obsPr !== 'object') continue;
      if (obsPr.owner !== pr.owner) continue;
      if (obsPr.repo !== pr.repo) continue;
      if (obsPr.number !== pr.number) continue;
      if (latest === null || atom.created_at > latest.created_at) {
        latest = atom;
      }
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return latest;
}
