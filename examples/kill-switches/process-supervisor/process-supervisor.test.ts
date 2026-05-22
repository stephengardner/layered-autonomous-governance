import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { ProcessSupervisor } from './process-supervisor.js';
import {
  runMediumTierKillSwitchContract,
  type MediumTierKillSwitchFixture,
} from './contract.js';

/**
 * Spawn a long-lived guinea-pig child. Uses `node -e` with a
 * `setInterval(() => {}, 1000)` body so the child stays alive across
 * platforms without depending on `sleep` / `timeout` / `ping` binaries.
 */
function spawnGuinea(): { pid: number; done: Promise<void> } {
  // detached:false so the child is reaped by the test runner cleanly
  // when the parent exits. On Windows we do NOT want a process-group
  // leader because `taskkill /T` walks the descendant tree from the
  // explicit PID instead.
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
 * environments have a small reap-latency window. A short retry loop
 * absorbs that without making the test timing-fragile.
 */
async function isAlive(pid: number): Promise<boolean> {
  // Probe across a short retry window so a post-tripAll reap on
  // Windows (where `taskkill /T /PID` returns before the OS scrubs
  // the PID) has time to propagate. Any ESRCH (or EPERM, since the
  // test never creates foreign-PID processes) is conclusive that
  // the process is gone; return false on the first failed probe.
  // If every probe in the window succeeds, treat the process as
  // alive. The original short-circuit on `attempt === 0` defeated
  // the retry intent and could let a reap-in-progress probe report
  // "alive" before the OS finished.
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildFixture(): Promise<MediumTierKillSwitchFixture> {
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

// Run the full substrate contract suite against the real impl.
runMediumTierKillSwitchContract('ProcessSupervisor (real spawn)', buildFixture);

describe('ProcessSupervisor: input validation', () => {
  it('arm() rejects non-positive PIDs', async () => {
    const ks = new ProcessSupervisor();
    await expect(ks.arm(0)).rejects.toThrow(/positive integer/);
    await expect(ks.arm(-1)).rejects.toThrow(/positive integer/);
    await expect(ks.arm(1.5)).rejects.toThrow(/positive integer/);
  });

  it('disarm() rejects non-positive PIDs', async () => {
    const ks = new ProcessSupervisor();
    await expect(ks.disarm(0)).rejects.toThrow(/positive integer/);
  });

  it('tripAll() is a no-op when nothing is armed', async () => {
    const ks = new ProcessSupervisor();
    await ks.tripAll();
    await ks.tripAll(); // still a no-op
  });
});

describe('ProcessSupervisor: platform branching', () => {
  it('POSIX branch signals SIGTERM then SIGKILL', async () => {
    const signals: Array<{ pid: number; signal: string }> = [];
    const ks = new ProcessSupervisor({
      platform: 'linux',
      killEscalationMs: 5,
      posixSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
    });
    await ks.arm(12_345);
    await ks.tripAll();
    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(signals.every((s) => s.pid === 12_345)).toBe(true);
  });

  it('Windows branch shells out to taskkill once per PID', async () => {
    const calls: number[] = [];
    const ks = new ProcessSupervisor({
      platform: 'win32',
      windowsTerminate: async (pid) => {
        calls.push(pid);
      },
    });
    await ks.arm(54_321);
    await ks.arm(99_999);
    await ks.tripAll();
    expect(calls.sort()).toEqual([54_321, 99_999]);
  });

  it('POSIX signal errors are swallowed (best-effort contract)', async () => {
    const ks = new ProcessSupervisor({
      platform: 'linux',
      killEscalationMs: 0,
      posixSignal: () => {
        throw new Error('ESRCH');
      },
    });
    await ks.arm(12_345);
    // Must not reject - tripAll() is best-effort by contract.
    await expect(ks.tripAll()).resolves.toBeUndefined();
  });

  it('Windows taskkill errors are swallowed (best-effort contract)', async () => {
    const ks = new ProcessSupervisor({
      platform: 'win32',
      windowsTerminate: async () => {
        throw new Error('access denied');
      },
    });
    await ks.arm(54_321);
    await expect(ks.tripAll()).resolves.toBeUndefined();
  });
});
