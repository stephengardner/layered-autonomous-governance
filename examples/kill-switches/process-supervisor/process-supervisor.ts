/**
 * Reference ProcessSupervisor: the canonical `MediumTierKillSwitch`
 * implementation that ships with the substrate.
 *
 * Platform handling is selected once at construction time. The POSIX
 * branch signals each armed PID with `SIGTERM` then `SIGKILL`; the
 * Windows branch shells out to `taskkill /F /T /PID <pid>` which
 * walks the descendant process tree.
 *
 * Constraints:
 *   - In-memory trip set only. A supervisor restart loses adopted
 *     PIDs; a host that needs persistence across supervisor crashes
 *     wraps this impl with its own durability layer.
 *   - `arm()` does not validate the PID exists. The contract permits
 *     validation but the canonical impl skips it: signaling a
 *     non-existent PID later is itself a no-op on both platforms.
 *   - `tripAll()` returns when every armed PID has been signaled,
 *     not when the OS has confirmed exit. The contract calls this
 *     out as best-effort by design.
 */

import { spawn } from 'node:child_process';
import type { MediumTierKillSwitch } from '../../../src/substrate/kill-switch/index.js';

/**
 * Construction options. Tuning these is rarely necessary for the
 * indie-floor default; org-ceiling deployments that need a different
 * signal cadence wire a custom subclass or a competing implementation.
 */
export interface ProcessSupervisorOptions {
  /**
   * Platform override for tests + container-runtime adapters. When
   * absent, the impl reads `process.platform` once at construction.
   */
  readonly platform?: NodeJS.Platform;

  /**
   * Milliseconds between the initial `SIGTERM` and the follow-up
   * `SIGKILL` on the POSIX branch. Lets a well-behaved child run
   * its own cleanup before the supervisor escalates. Default 100ms;
   * a child that ignores SIGTERM is presumed misbehaving and the
   * impl does not wait long for it.
   *
   * The Windows branch ignores this knob: `taskkill /F` is already
   * the equivalent of SIGKILL with no graceful intermediate.
   */
  readonly killEscalationMs?: number;

  /**
   * Hook for tests + container runtimes that need to intercept the
   * actual signal call. Default: `process.kill`. The hook receives
   * the signal name as a string (`'SIGTERM'`, `'SIGKILL'`).
   */
  readonly posixSignal?: (pid: number, signal: NodeJS.Signals) => void;

  /**
   * Hook for tests that need to intercept the `taskkill` spawn.
   * Default: spawn `taskkill /F /T /PID <pid>` and resolve when it
   * exits.
   */
  readonly windowsTerminate?: (pid: number) => Promise<void>;
}

const DEFAULT_KILL_ESCALATION_MS = 100;

export class ProcessSupervisor implements MediumTierKillSwitch {
  private readonly armed: Set<number> = new Set();

  private readonly platform: NodeJS.Platform;

  private readonly killEscalationMs: number;

  private readonly posixSignal: (pid: number, signal: NodeJS.Signals) => void;

  private readonly windowsTerminate: (pid: number) => Promise<void>;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.killEscalationMs = options.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
    this.posixSignal = options.posixSignal ?? defaultPosixSignal;
    this.windowsTerminate = options.windowsTerminate ?? defaultWindowsTerminate;
  }

  async arm(pid: number): Promise<void> {
    assertValidPid(pid);
    this.armed.add(pid);
  }

  async disarm(pid: number): Promise<void> {
    assertValidPid(pid);
    this.armed.delete(pid);
  }

  async tripAll(): Promise<void> {
    // Snapshot before iterating so a slow signal call does not race a
    // concurrent arm() into the live set. After signaling, the trip set
    // is empty - the contract is explicit that subsequent arms start
    // fresh.
    const targets = Array.from(this.armed);
    this.armed.clear();

    if (targets.length === 0) {
      return;
    }

    if (this.platform === 'win32') {
      await Promise.all(targets.map((pid) => this.windowsTerminate(pid).catch(swallow)));
      return;
    }

    // POSIX: SIGTERM, brief grace, then SIGKILL on anything that did
    // not exit. Errors are swallowed because the contract is best-
    // effort signaling; a PID that already exited yields ESRCH which
    // is not a real failure.
    for (const pid of targets) {
      try {
        this.posixSignal(pid, 'SIGTERM');
      } catch {
        // ESRCH (already exited) or EPERM (foreign process) - both
        // surface up as best-effort failures the supervisor does not
        // escalate on.
      }
    }
    if (this.killEscalationMs > 0) {
      await sleep(this.killEscalationMs);
    }
    for (const pid of targets) {
      try {
        this.posixSignal(pid, 'SIGKILL');
      } catch {
        // Same swallow rationale as the SIGTERM pass.
      }
    }
  }
}

function assertValidPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `[process-supervisor] pid must be a positive integer (received ${String(pid)})`,
    );
  }
}

function defaultPosixSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultWindowsTerminate(pid: number): Promise<void> {
  return new Promise((resolveExit) => {
    // `/F` forces, `/T` walks the process tree (descendant kills) so a
    // shell that spawned grandchildren does not leave orphans. Best-
    // effort: errors surface as a non-zero exit which the supervisor
    // swallows because the contract is signaling, not confirmation.
    const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => resolveExit());
    child.on('exit', () => resolveExit());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function swallow(): void {
  // Intentionally empty - tripAll() is best-effort by contract.
}
