# lag-reconcile-tick

One-shot substrate reconciliation driver. Runs three existing passes
(pr-observation refresh, plan-state reconcile, proposed-plan reaper) in
sequence against a LAG atom store and exits. Suitable for cron, Windows
Task Scheduler, or any external orchestrator.

## What it does

Each invocation runs three passes in order:

1. **pr-observation refresh.** Scans pr-observation atoms whose
   `pr_state=OPEN` is stale (older than 5 minutes by default). For each,
   spawns `node scripts/gh-as.mjs <bot> pr view <number> --json
   state,mergedAt,headRefOid,...` to fetch live PR state from GitHub.
   Writes a fresh pr-observation atom that supersedes the stale one,
   carrying `partial: true` because only the lightweight `gh pr view`
   query was used (not the full review tree).

2. **plan-state reconcile.** Scans pr-observation atoms whose `pr_state`
   is terminal (MERGED or CLOSED), resolves the linked plan via
   `metadata.plan_id`, and transitions the plan to `succeeded` (MERGED)
   or `abandoned` (CLOSED). Idempotent via a deterministic marker atom
   so a second tick on the same observation is a no-op.

3. **proposed-plan reaper.** Classifies plans in `proposed` state
   against the default TTL pair (24h warn / 72h abandon). Transitions
   abandon-bucket plans to `abandoned` via the existing plan state
   machine; emits an audit row per transition.

The driver exits 0 after the three passes complete and prints a
parseable single-line summary on stdout.

## Why it exists

Each of the three passes already exists in the LAG substrate:

- `src/runtime/plans/pr-observation-refresh.ts`
- `src/runtime/plans/pr-merge-reconcile.ts`
- `src/runtime/plans/reaper.ts`

The `LoopRunner` (`src/cli/run-loop.ts`) wires all three into a
long-running tick loop. In deployments that do not start the
`LoopRunner` (a solo developer on a dev box, an org running a different
orchestrator), none of the three passes run, and the atom store
accumulates stuck atoms: stale OPEN pr-observation rows, plans frozen
in `executing` after their PR merged, plans piling up in `proposed`
without acknowledgement.

This driver makes one-tick invocation cheap. There is no daemon to keep
alive; the operator wires it into OS-level cron or Task Scheduler. The
substrate primitives stay unchanged; this is a thin orchestrator.

## Run it once

```bash
node scripts/lag-reconcile-tick.mjs
```

Required environment variable:

- `LAG_OPERATOR_ID`: principal id used for the inline refresh atoms
  and the reaper sweep's audit attribution. The driver refuses to write
  audit rows without a resolved principal.

Optional environment variables:

- `LAG_RECONCILE_TICK_PRINCIPAL`: overrides `LAG_OPERATOR_ID` when the
  tick is run under a dedicated bot identity. The override is read
  first; the operator id is the fallback.
- `LAG_ROOT`: atom-store root; default `./.lag` relative to the repo.

Common flags:

- `--root <path>`: atom-store root (overrides `LAG_ROOT`).
- `--bot <id>`: bot identity for the `gh pr view` subprocess (default
  `lag-ceo`).
- `--pr-timeout-ms <n>`: per-PR `gh pr view` timeout in ms (default
  10000).
- `--skip-refresh` / `--skip-reconcile` / `--skip-reap`: skip a pass.
  Useful when wiring a partial tick into a different scheduler than the
  one running the other two.
- `--help`: show usage and exit.

Exit codes:

- `0`: tick completed (zero or more transitions; the operator reads the
  stdout summary, not the exit code, to interpret the result).
- `1`: fatal error (argv parse failure, no operator principal resolved,
  pass throws).
- `2`: `.lag/STOP` sentinel present; the driver halted before any
  mutation per `inv-kill-switch-first`.

Output: one stdout line like

```text
[lag-reconcile-tick] refresh: refreshed=2 scanned=120 rate-limited=0 | reconcile: scanned=120 matched=2 transitioned=2 claim-conflicts=0 | reap: classified=15 abandoned=1
```

## Schedule it on Windows (Task Scheduler)

A 5-minute recurring task using `schtasks`:

```powershell
schtasks /Create ^
  /SC MINUTE ^
  /MO 5 ^
  /TN "LAG-Reconcile-Tick" ^
  /TR "node C:\Users\<you>\memory-governance\scripts\lag-reconcile-tick.mjs" ^
  /RL HIGHEST ^
  /F
```

Notes:

- Set `LAG_OPERATOR_ID` (and optionally `LAG_RECONCILE_TICK_PRINCIPAL`)
  in the Windows environment variable surface that Task Scheduler reads.
  System-wide env vars are visible to scheduled tasks; user-scoped vars
  are visible only when the task runs as the operator's user account.
- Bot credentials must exist at `<repo>/.lag/apps/<bot>.json` so the
  `gh pr view` subprocess can mint an installation token. The driver
  exits 1 if `gh-as.mjs` fails to resolve the bot identity.
- To verify Task Scheduler is firing the tick, query the task's last
  run result: `schtasks /Query /TN "LAG-Reconcile-Tick" /V /FO LIST`.

To stop the task:

```powershell
schtasks /Delete /TN "LAG-Reconcile-Tick" /F
```

## Schedule it on POSIX (cron)

A 5-minute crontab entry:

```bash
*/5 * * * * cd /path/to/memory-governance && /usr/bin/env LAG_OPERATOR_ID=apex-agent node scripts/lag-reconcile-tick.mjs >> /var/log/lag-reconcile-tick.log 2>&1
```

Notes:

- The `cd` is necessary because the driver resolves `.lag` relative to
  the script's repo root by default. Pass `--root /abs/path/.lag` to
  decouple from the cwd if preferred.
- Pin `LAG_OPERATOR_ID` in the cron environment; the cron `env(1)` does
  not inherit a login shell's exported vars.
- Append to a log file so a failed tick is observable; the stderr
  banner names which pass threw.

## Observability

Every transition emits an audit row in `.lag/audit/`:

- Refresh writes a new `pr-observation` atom; the atom's
  `provenance.source.tool=lag-reconcile-tick` distinguishes refresh
  atoms from the normal pr-landing actor's emissions.
- Reconcile writes a `plan-merge-settled` marker atom and emits an
  audit row of kind `plan.state-reconciled-succeeded` or
  `plan.state-reconciled-abandoned`.
- Reap calls `transitionPlanState` for every abandoned plan, which
  emits an audit row of kind `plan.state-transitioned`.

The LAG Console renders the resulting state on the live ops dashboard
(pulse tile, plans view) within the next refresh interval. The Console
itself is read-only; this driver is one of the substrate-side paths
that produces the state the Console renders.

## When NOT to run this

- An org-ceiling deployment that has already started the LoopRunner
  (`node scripts/run-loop.ts --refresh-plan-observations
  --reconcile-plan-state --reap-stale-plans`) does NOT need this
  driver. Both paths trigger the same three passes; running both is
  harmless (the deterministic-id and CAS guards make every pass
  idempotent) but redundant.
- A deployment whose atom store is shared across multiple processes
  may want to keep the driver to a single scheduler to bound
  concurrency. The substrate's CAS + claim-marker contracts handle
  contention safely, but multiple concurrent ticks waste subprocess
  spawns.

## Reference

- Source: `scripts/lag-reconcile-tick.mjs` (driver) and
  `scripts/lib/lag-reconcile-tick.mjs` (testable helpers).
- Tests: `test/scripts/lag-reconcile-tick.test.ts`.
- Substrate passes: `src/runtime/plans/pr-observation-refresh.ts`,
  `src/runtime/plans/pr-merge-reconcile.ts`,
  `src/runtime/plans/reaper.ts`.
- Loop wiring: `src/cli/run-loop.ts` (for the long-running alternative).
