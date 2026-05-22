import { describe, it, expect } from 'vitest';
import type { MediumTierKillSwitch } from '../../../src/substrate/kill-switch/index.js';

/*
 * Contract test runner. Any `MediumTierKillSwitch` impl can pass this
 * fixture in to verify it satisfies the interface contract.
 *
 * The fixture exposes:
 *   - `killSwitch`: the impl under test.
 *   - `isAlive(pid)`: probe for whether a PID is alive at the OS level
 *     (the contract calls for `tripAll()` to terminate armed PIDs).
 *   - `spawnGuinea()`: spawn a sacrificial long-lived child the test
 *     can arm + observe through `tripAll()`.
 *   - `cleanup()`: tear down any test resources after the test.
 *
 * This file lives under `examples/` so the example reference impl test
 * can import it without crossing tsconfig project rootDir boundaries
 * (TS6059). The contract runner uses vitest at runtime; it only
 * provides the harness, never registers tests at module load.
 */
export interface MediumTierKillSwitchFixture {
  readonly killSwitch: MediumTierKillSwitch;
  readonly isAlive: (pid: number) => Promise<boolean>;
  readonly spawnGuinea: () => Promise<{ pid: number; done: Promise<void> }>;
  readonly cleanup: () => Promise<void>;
}

export function runMediumTierKillSwitchContract(
  name: string,
  build: () => Promise<MediumTierKillSwitchFixture>,
): void {
  describe(`MediumTierKillSwitch contract: ${name}`, () => {
    it('arm() is idempotent on the same PID', async () => {
      const fixture = await build();
      try {
        const { pid, done } = await fixture.spawnGuinea();
        await fixture.killSwitch.arm(pid);
        await fixture.killSwitch.arm(pid); // second arm: must not throw
        await fixture.killSwitch.tripAll();
        await done.catch(() => undefined);
      } finally {
        await fixture.cleanup();
      }
    });

    it('disarm() is idempotent and a no-op for unknown PIDs', async () => {
      const fixture = await build();
      try {
        // Disarm a PID that was never armed: must not throw.
        await fixture.killSwitch.disarm(999_999);
        const { pid, done } = await fixture.spawnGuinea();
        await fixture.killSwitch.arm(pid);
        await fixture.killSwitch.disarm(pid);
        await fixture.killSwitch.disarm(pid); // second disarm: no-op
        // After disarm, tripAll() must not target the released PID.
        await fixture.killSwitch.tripAll();
        // Process should still be alive immediately after tripAll because
        // it was disarmed before the trip.
        const aliveImmediately = await fixture.isAlive(pid);
        expect(aliveImmediately).toBe(true);
        // Clean up the still-running guinea.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already exited; test still passes.
        }
        await done.catch(() => undefined);
      } finally {
        await fixture.cleanup();
      }
    });

    it('tripAll() terminates an armed PID', async () => {
      const fixture = await build();
      try {
        const { pid, done } = await fixture.spawnGuinea();
        await fixture.killSwitch.arm(pid);
        const aliveBefore = await fixture.isAlive(pid);
        expect(aliveBefore).toBe(true);

        await fixture.killSwitch.tripAll();
        // tripAll() is best-effort signaling, not death-confirmation.
        // Wait for the OS to actually reap the child.
        await done.catch(() => undefined);

        const aliveAfter = await fixture.isAlive(pid);
        expect(aliveAfter).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    });

    it('tripAll() empties the trip set: subsequent arm/disarm starts fresh', async () => {
      const fixture = await build();
      try {
        const first = await fixture.spawnGuinea();
        await fixture.killSwitch.arm(first.pid);
        await fixture.killSwitch.tripAll();
        await first.done.catch(() => undefined);

        // A second tripAll() must be a no-op (trip set is empty).
        await fixture.killSwitch.tripAll();

        // A subsequent arm() on a fresh PID must adopt cleanly.
        const second = await fixture.spawnGuinea();
        await fixture.killSwitch.arm(second.pid);
        await fixture.killSwitch.tripAll();
        await second.done.catch(() => undefined);
        const aliveSecond = await fixture.isAlive(second.pid);
        expect(aliveSecond).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    });
  });
}
