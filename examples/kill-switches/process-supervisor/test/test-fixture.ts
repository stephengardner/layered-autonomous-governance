/**
 * Test fixture builder for ProcessSupervisor. Shared between the
 * example's impl-specific tests and the substrate-level conformance
 * test (`test/conformance/kill-switch.test.ts`). Lives under
 * `examples/.../test/` so the test-only fixture stays out of the
 * `tsconfig.examples.json` rootDir surface and can freely import the
 * substrate spec from `test/conformance/shared/`.
 */
import { spawn } from 'node:child_process';
import { ProcessSupervisor } from '../process-supervisor.js';
import type { MediumTierKillSwitchFixture } from '../../../../test/conformance/shared/kill-switch-spec.js';

/**
 * Spawn a long-lived guinea-pig child. Uses `node -e` with a
 * `setInterval(() => {}, 1000)` body so the child stays alive across
 * platforms without depending on `sleep` / `timeout` / `ping` binaries.
 *
 * detached:false so the child is reaped by the test runner cleanly
 * when the parent exits. On Windows we do NOT want a process-group
 * leader because `taskkill /T` walks the descendant tree from the
 * explicit PID instead.
 */
export function spawnGuinea(): { pid: number; done: Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (typeof child.pid !== 'number') {
    throw new Error('spawnGuinea: child has no pid');
  }
  const done = new Promise<void>((resolveExit) => {
    child.on('exit', () => resolveExit());
    child.on('error', () => resolveExit());
  });
  return { pid: child.pid, done };
}

/**
 * `process.kill(pid, 0)` is the canonical alive-probe on POSIX. On
 * Windows it raises ESRCH only after the OS reaps; some Windows test
 * environments have a small reap-latency window. Probe across a short
 * retry window so a post-tripAll reap on Windows (where
 * `taskkill /T /PID` returns before the OS scrubs the PID) has time
 * to propagate. Any ESRCH (or EPERM, since the test never creates
 * foreign-PID processes) is conclusive that the process is gone;
 * return false on the first failed probe. If every probe in the
 * window succeeds, treat the process as alive.
 */
export async function isAlive(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      void err;
      return false;
    }
    await sleep(50);
  }
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function buildProcessSupervisorFixture(): Promise<MediumTierKillSwitchFixture> {
  // Default constructor uses real process.platform + real signals.
  // Tighten the escalation window so the test runs fast.
  const killSwitch = new ProcessSupervisor({ killEscalationMs: 20 });
  const spawned: Array<{ pid: number; done: Promise<void> }> = [];
  return {
    killSwitch,
    isAlive,
    spawnGuinea: async () => {
      const child = spawnGuinea();
      spawned.push(child);
      // Give the OS a tick to register the new PID before the contract
      // test reads it back via `process.kill(pid, 0)`.
      await sleep(20);
      return child;
    },
    cleanup: async () => {
      // Belt-and-suspenders: anything still alive gets force-killed.
      for (const child of spawned) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      await Promise.all(spawned.map((c) => c.done.catch(() => undefined)));
    },
  };
}
