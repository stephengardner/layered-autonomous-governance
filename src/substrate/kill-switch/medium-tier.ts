/**
 * Medium-tier kill switch.
 *
 * The soft-tier `createKillSwitch` controller in this same package
 * delivers an in-process `AbortSignal` that cooperating adapters can
 * subscribe to. The soft tier is enough for I/O calls that honor the
 * signal (fetch, execa, well-behaved child processes), but it cannot
 * interrupt a subprocess that has already escaped the host's await
 * chain - a runaway spawned binary, a child that ignored `SIGTERM`,
 * or a downstream tool the host launched and lost the handle to.
 *
 * The medium tier closes that gap with an out-of-process mechanism:
 * an external supervisor tracks PIDs the host registers via `arm()`
 * and forcibly terminates them on `tripAll()`. Concrete supervisors
 * (POSIX process-group signaler, Windows `taskkill /T`, container
 * runtimes, kubelet-style controllers) implement the contract; this
 * module owns only the seam.
 *
 * Lifecycle:
 *
 *   1. The host spawns a subprocess. The host gets a PID back.
 *   2. The host calls `arm(pid)`. The supervisor adopts the PID into
 *      its trip set.
 *   3. Either:
 *      a. The subprocess exits normally. The host calls `disarm(pid)`
 *         so the supervisor releases the PID and does not double-kill
 *         a recycled PID later.
 *      b. The host observes a halt condition (kill-switch trip,
 *         deadline, operator revocation) and calls `tripAll()`. The
 *         supervisor forcibly terminates every armed PID.
 *
 * Substrate posture:
 *
 *   - Mechanism only. The interface knows nothing about which actor
 *     spawned the PID, which policy decides when to trip, or which
 *     observation atom records the kill.
 *   - Both methods MUST be idempotent. Calling `disarm(pid)` for a
 *     PID that was never armed is a no-op; calling `tripAll()` twice
 *     trips once.
 *   - `tripAll()` is best-effort by contract: the supervisor reports
 *     success when every armed PID has been signaled, not when the
 *     OS has confirmed exit. Callers that need a death-confirmation
 *     wait observe their own child handles after calling `tripAll()`.
 *   - The interface ships with no default. A deployment that does
 *     not register a `MediumTierKillSwitch` continues to run on the
 *     soft tier alone; this preserves the indie-floor default of
 *     zero out-of-process supervisor dependencies.
 */

/**
 * Out-of-process kill-switch contract that lets the host adopt a
 * subprocess PID into a supervised set and forcibly terminate all
 * adopted PIDs on a trip.
 *
 * Implementations are platform-specific (POSIX process group,
 * Windows job object, container runtime, etc.). Selecting which
 * one to wire is a deployment decision, not a framework one.
 */
export interface MediumTierKillSwitch {
  /**
   * Adopt `pid` into the supervisor's trip set. Idempotent: arming
   * the same PID twice keeps it armed once. Returns when the
   * supervisor has acknowledged adoption.
   *
   * Implementations MAY validate that the PID actually exists
   * (`process.kill(pid, 0)` on POSIX, `tasklist /FI` on Windows)
   * and reject when it does not. Callers should arm immediately
   * after spawn so the validation window is narrow.
   */
  arm(pid: number): Promise<void>;

  /**
   * Release `pid` from the supervisor's trip set. Idempotent:
   * disarming a PID that was never armed (or was already disarmed)
   * is a no-op. Callers MUST disarm on normal child exit so the
   * supervisor does not later target a recycled PID.
   */
  disarm(pid: number): Promise<void>;

  /**
   * Forcibly terminate every currently-armed PID. Best-effort:
   * returns when the supervisor has signaled every PID, not when
   * the OS has confirmed exit. Callers that need death-confirmation
   * await their own child handles after this resolves.
   *
   * After `tripAll()` resolves, the supervisor's trip set is
   * empty: a subsequent `arm()` call adopts a fresh PID without
   * inheriting any state from the previous trip.
   */
  tripAll(): Promise<void>;
}
