/**
 * Impl-specific tests for ProcessSupervisor. The substrate
 * `MediumTierKillSwitch` contract is exercised by
 * `test/conformance/kill-switch.test.ts`; this file covers only the
 * ProcessSupervisor-specific behaviors (input validation, platform
 * branching, best-effort signaling), not the substrate contract.
 */
import { describe, it, expect } from 'vitest';
import { ProcessSupervisor } from '../process-supervisor.js';

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
