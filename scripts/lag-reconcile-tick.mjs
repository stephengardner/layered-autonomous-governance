#!/usr/bin/env node
/**
 * lag-reconcile-tick: one-shot substrate reconciliation driver.
 *
 * Chains three existing passes into a single tick suitable for cron,
 * Windows Task Scheduler, or any external orchestrator:
 *
 *   1. runPlanObservationRefreshTick (src/runtime/plans/pr-observation-
 *      refresh.ts) -- refreshes stale pr_state=OPEN pr-observation atoms
 *      via the injected refresher (this driver supplies an inline gh-as
 *      adapter that calls `gh pr view --json state,...` and writes a
 *      partial-true heal atom).
 *
 *   2. runPlanStateReconcileTick (src/runtime/plans/pr-merge-reconcile.ts)
 *      -- scans pr-observation atoms with terminal state (MERGED/CLOSED)
 *      and transitions their linked plan to succeeded/abandoned.
 *
 *   3. runReaperSweep (src/runtime/plans/reaper.ts) -- classifies plans
 *      in `proposed` state against the 24h/72h TTL pair and transitions
 *      abandon-bucket plans to `abandoned`.
 *
 * The substrate gap this closes: each of the three passes already
 * exists, but none auto-runs in a fresh deployment that does not start
 * the LoopRunner (src/cli/run-loop.ts). On the operator's dev box the
 * Console accumulated 17-day-old "proposed" plans + 21-hour-old
 * "executing" plans because no reconciler was wired into a continuous
 * loop. This driver makes one-tick invocation cheap (no daemon to keep
 * alive); operators schedule it via OS-level cron or Task Scheduler
 * instead. See docs/operator/lag-reconcile-tick.md for scheduling.
 *
 * Substrate posture: the driver is a thin orchestrator over the three
 * existing passes. It adds no new atom types, no new policy schemas, no
 * new state machine transitions. The inline refresher uses the existing
 * PrObservationRefresher seam (src/runtime/plans/pr-observation-
 * refresh.ts) and the existing pr-observation atom shape consumed by
 * apps/console/server/live-ops.ts. Removing this driver does not break
 * any existing flow; it only re-opens the staleness gap for deployments
 * that did not adopt the LoopRunner.
 *
 * Usage:
 *
 *   # Default tick (refresh + reconcile + reap):
 *   node scripts/lag-reconcile-tick.mjs
 *
 *   # Subset:
 *   node scripts/lag-reconcile-tick.mjs --skip-reap
 *   node scripts/lag-reconcile-tick.mjs --skip-refresh --skip-reap
 *
 *   # Explicit root, custom timeouts:
 *   node scripts/lag-reconcile-tick.mjs --root /path/to/.lag --pr-timeout-ms 5000
 *
 *   # Bot identity for gh pr view subprocess (default lag-ceo):
 *   node scripts/lag-reconcile-tick.mjs --bot lag-ceo
 *
 *   # Help:
 *   node scripts/lag-reconcile-tick.mjs --help
 *
 * Exit codes:
 *   0 - tick completed (each pass succeeded; zero or more transitions
 *       applied; the operator interprets the summary, not the exit code)
 *   1 - fatal error in a pass or argv parsing
 *   2 - kill switch active (.lag/STOP present); halt before any mutation
 *
 * Environment:
 *   LAG_OPERATOR_ID                 required (principal id used for the
 *                                   inline refresh atoms and the reaper
 *                                   sweep's audit attribution)
 *   LAG_RECONCILE_TICK_PRINCIPAL    optional override for the operator
 *                                   principal (takes precedence over
 *                                   LAG_OPERATOR_ID); useful when the
 *                                   tick is run by a dedicated bot
 *                                   identity in the future
 *   LAG_ROOT                        atom-store root; falls back to ./.lag
 *
 * Helpers in scripts/lib/lag-reconcile-tick.mjs (shebang-free) are
 * imported by test/scripts/lag-reconcile-tick.test.ts so the test
 * surface stays subprocess-free per
 * feedback_shebang_import_from_tests.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import { mkPrObservationAtomId } from '../dist/runtime/atoms/pr-observation-id.js';
import {
  runPlanObservationRefreshTick,
} from '../dist/runtime/plans/pr-observation-refresh.js';
import {
  runPlanStateReconcileTick,
} from '../dist/runtime/plans/pr-merge-reconcile.js';
import {
  runReaperSweep,
  DEFAULT_REAPER_TTLS,
} from '../dist/runtime/plans/reaper.js';
import {
  parseArgs,
  resolveOperatorPrincipal,
  createInlineGhRefresher,
  formatTickSummary,
} from './lib/lag-reconcile-tick.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const USAGE = `Usage: node scripts/lag-reconcile-tick.mjs [options]

One-shot substrate reconciliation driver. Chains three existing passes
(plan-observation refresh, plan-state reconcile, plan reaper) into a
single tick suitable for cron or Windows Task Scheduler.

Options:
  --root <path>           atom-store root (default: ./.lag, or LAG_ROOT env)
  --bot <id>              bot identity for gh subprocess (default: lag-ceo)
  --pr-timeout-ms <n>     per-PR gh subprocess timeout (default: 10000)
  --max-scan <n>          max observation atoms scanned per refresh pass (default: 5000)
  --max-refreshes <n>     max refresh subprocess calls per tick (default: 50)
  --skip-refresh          skip the pr-observation refresh pass
  --skip-reconcile        skip the plan-state reconcile pass
  --skip-reap             skip the proposed-plan reaper sweep
  --help, -h              show this message and exit

Environment:
  LAG_OPERATOR_ID                 required for the inline refresh atoms +
                                  reaper audit attribution
  LAG_RECONCILE_TICK_PRINCIPAL    optional override for the operator id
  LAG_ROOT                        atom-store root (overridden by --root)

Exit codes:
  0  tick completed
  1  fatal error
  2  .lag/STOP sentinel present (halted before any mutation)
`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[lag-reconcile-tick] ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const rootDir = args.rootDir ?? resolve(REPO_ROOT, '.lag');

  // Kill-switch sentinel lives inside the resolved store root, not
  // REPO_ROOT, so a tick targeting an alternate atom store (--root /
  // LAG_ROOT) honors that store's own STOP. Per inv-kill-switch-first
  // the gate halts before any mutation so we check BEFORE constructing
  // the host (host construction touches the filesystem to ensure dirs).
  const stopSentinel = resolve(rootDir, 'STOP');
  if (existsSync(stopSentinel)) {
    console.error(`[lag-reconcile-tick] STOP sentinel present at ${stopSentinel}; halting before any tick.`);
    process.exit(2);
  }

  const principalId = resolveOperatorPrincipal(process.env);
  if (principalId === null) {
    console.error(
      '[lag-reconcile-tick] no principal resolved. Set LAG_OPERATOR_ID or'
      + ' LAG_RECONCILE_TICK_PRINCIPAL.',
    );
    console.error(
      '[lag-reconcile-tick] this tick writes audit rows + heal atoms and'
      + ' refuses to guess the operator principal.',
    );
    process.exit(1);
  }

  const host = await createFileHost({ rootDir });

  console.error(
    `[lag-reconcile-tick] starting (root=${rootDir} bot=${args.bot}`
    + ` pr-timeout=${args.prTimeoutMs}ms`
    + ` max-scan=${args.maxScan} max-refreshes=${args.maxRefreshes})`,
  );

  /** @type {{ refreshed: number, scanned: number, skipped: Record<string, number> }} */
  let refreshResult = { refreshed: 0, scanned: 0, skipped: {} };
  /** @type {{ scanned: number, matched: number, transitioned: number, claimConflicts: number }} */
  let reconcileResult = { scanned: 0, matched: 0, transitioned: 0, claimConflicts: 0 };
  /** @type {{ classified: number, abandoned: number, truncated: boolean }} */
  let reapResult = { classified: 0, abandoned: 0, truncated: false };

  // Pass 1: refresh stale pr-observation atoms via inline gh-as adapter.
  if (!args.skipRefresh) {
    const refresher = createInlineGhRefresher({
      host,
      principalId,
      bot: args.bot,
      prTimeoutMs: args.prTimeoutMs,
      mkPrObservationAtomId,
      maxScan: args.maxScan,
    });
    const tick = await runPlanObservationRefreshTick(host, refresher, {
      maxScan: args.maxScan,
      maxRefreshes: args.maxRefreshes,
    });
    refreshResult = {
      refreshed: tick.refreshed,
      scanned: tick.scanned,
      skipped: tick.skipped,
    };
  }

  // Pass 2: reconcile plans whose pr-observation went terminal.
  if (!args.skipReconcile) {
    const tick = await runPlanStateReconcileTick(host, { maxScan: args.maxScan });
    reconcileResult = {
      scanned: tick.scanned,
      matched: tick.matched,
      transitioned: tick.transitioned,
      claimConflicts: tick.claimConflicts,
    };
  }

  // Pass 3: reap chronically-stale proposed plans. The reaper consumes
  // the configured TTL pair (default 24h warn / 72h abandon); the
  // LoopRunner reads canon policies before falling back to defaults,
  // and the standalone driver here mirrors only the defaults path. A
  // tighter org-ceiling deployment that wants per-tick canon-driven
  // TTLs runs the LoopRunner instead of this one-shot tick; the
  // standalone shape is for an indie operator who wants cron + defaults.
  if (!args.skipReap) {
    const sweep = await runReaperSweep(host, principalId, DEFAULT_REAPER_TTLS);
    reapResult = {
      classified:
        sweep.classifications.fresh.length
        + sweep.classifications.warn.length
        + sweep.classifications.abandon.length,
      abandoned: sweep.apply.abandoned.length,
      truncated: sweep.truncated,
    };
  }

  const summary = formatTickSummary({
    refresh: refreshResult,
    reconcile: reconcileResult,
    reap: reapResult,
  });
  process.stdout.write(summary + '\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(
    `[lag-reconcile-tick] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exit(1);
});
