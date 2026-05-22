# Atom store out of space (ENOSPC)

The partition holding `.lag/atoms/` is approaching or has hit the no-space-left-on-device threshold. The file adapter writes atoms via atomic-rename through a temp file; ENOSPC mid-write leaves a partial file that breaks the index priming on the next backend restart.

## Symptoms

- Console System Health row `atom-store-free-space` is yellow (1-5% free) or red (<1% free).
- File adapter writes fail with `ENOSPC: no space left on device, write` from `host.atoms.put()` / `host.atoms.update()`.
- Backend restart logs report `[backend] dropping <filename>.json: <ENOSPC parse error>` for partially-written atom files.
- Loop tick errors include atom-store write failures across multiple actors at once (signature of partition-wide pressure, not per-actor).

## Atom kinds that fire

The atom-store itself fails to write when ENOSPC trips, so the absence of new atoms is the signal. Look for:

- Last `created_at` across all atom files (`ls -lat .lag/atoms/ | head` on POSIX); a gap of minutes when a loop is running is the smoking gun.
- The Console probe row's detail text reports the exact free-space percentage and partition path.
- Filesystem level: `df -h <path-to-atoms>` (POSIX) / `Get-PSDrive` (Windows).

## Recovery steps

1. Confirm the impact: `df -h .lag/atoms/` (POSIX) or `Get-PSDrive` filtered to the relevant drive (Windows). Free space below 1% is critical.
2. Immediate breathing room: prune the audit-trail atoms that age out cleanly. Reaped pipelines, completed claims, and superseded canon atoms can be moved out of `.lag/atoms/` into `.lag/atoms.archive/` (the substrate ignores anything not under `atoms/`). Reference: `scripts/reap-stale-pipelines.mjs` (preview with `--dry-run`).
3. Identify large consumers outside `.lag/`: agent log files, cloudflared logs, `.worktrees/` checkouts (each one is a full repo clone), node_modules in stale worktrees.
4. Permanent: move `.lag/` to a larger partition by setting `LAG_CONSOLE_LAG_DIR` to the new location, then `mv .lag/* <new-location>/`. The backend reads through the env var so no code change is required.
5. Org-ceiling escape: graduate to the SQLite atom store reference adapter (`examples/atom-stores/sqlite/`). SQLite consolidates all atoms into one file plus WAL, reducing inode pressure and making partition migration a single-file move.

## Prevention follow-up

- Substrate gap: the file adapter does not enforce atom retention policies; long-running deployments accumulate audit trail indefinitely. A retention sweep that ages out atoms with terminal `pipeline_state` / `plan_state` and `claim_state` after a configurable window would relieve growth pressure.
- The Console probe at 5% / 1% gives hours-to-minutes of warning runway on typical atom growth rates; org-ceiling deployments writing 10x more atoms per minute should tighten thresholds via a future canon policy (`pol-atom-store-free-space-thresholds`).
- Monitoring: hooking the probe into a paging surface (Telegram, Slack notifier) so the operator wakes on yellow rather than red would shrink the recovery window further.

## Related

- Code: `src/adapters/file/atom-store.ts`, `examples/atom-stores/sqlite/`
- Console probe: `apps/console/server/system-health.ts` (probeAtomStoreFreeSpace)
- Audit: `docs/audit/2026-05-22-perpetual-self-audit-v1.md` PR-7
