import { transport } from './transport';

/**
 * Bot-identity health + substrate-probe projection. Mirrors the
 * server's `SystemHealthResponse` contract
 * (`apps/console/server/system-health.ts`).
 *
 * Why the duplicated types: the Console transport contract is dotted-
 * method JSON over a wire, not a shared TypeScript package. A future
 * shared-types module would erase the duplication; for v1 the manual
 * mirror is reviewer-discoverable and keeps the client build free of
 * a server-source import.
 *
 * Refresh cadence: callers compose this service with TanStack Query's
 * `refetchInterval` (the System Health page uses 30 seconds because a
 * bot token typically expires in an hour and operators do not need
 * sub-minute resolution on identity health). Faster polling would
 * over-mint installation tokens against GitHub's API without
 * meaningful operator-visible benefit.
 */

export type IdentityStatus = 'fresh' | 'stale' | 'network-error' | 'not-provisioned';

export interface BotIdentityHealth {
  readonly role: string;
  readonly login: string | null;
  readonly appId: number | null;
  readonly installationId: number | null;
  readonly expiresAt: string | null;
  readonly status: IdentityStatus;
  readonly lastCheckedAt: string;
  readonly ageMs: number | null;
  readonly detail: string | null;
}

export interface BotIdentityHealthResponse {
  readonly identities: ReadonlyArray<BotIdentityHealth>;
}

/**
 * Traffic-light status for the substrate probes (claim-reaper
 * cadence, tunnel reachability, atom-store free space). Distinct
 * from `IdentityStatus` because the bot-identity surface has four
 * outcomes (one of which is neutral, not green/yellow/red).
 */
export type ProbeStatus = 'green' | 'yellow' | 'red';

/**
 * Substrate probe row. Server returns one per probe family with a
 * stable `id` so the UI can render distinct rows + deep-link to the
 * corresponding runbook from each.
 */
export interface ProbeRow {
  readonly id: 'claim-reaper-cadence' | 'tunnel-reachability' | 'atom-store-free-space';
  readonly status: ProbeStatus;
  readonly summary: string;
  readonly detail: string;
  readonly runbookHref: string;
  readonly lastCheckedAt: string;
}

export interface SystemHealthResponse {
  readonly identities: ReadonlyArray<BotIdentityHealth>;
  readonly probes: ReadonlyArray<ProbeRow>;
}

/**
 * Back-compat surface: the standalone bot-identity endpoint stays
 * live for any older client; new callers use `getSystemHealth`.
 */
export async function getBotIdentityHealth(
  signal?: AbortSignal,
): Promise<BotIdentityHealthResponse> {
  return transport.call<BotIdentityHealthResponse>(
    'system-health.bot-identities',
    undefined,
    signal ? { signal } : undefined,
  );
}

/**
 * Aggregated System Health surface: bot-identity rows plus the three
 * substrate probes (claim-reaper cadence, tunnel reachability,
 * atom-store free space). One backend call per refresh.
 */
export async function getSystemHealth(
  signal?: AbortSignal,
): Promise<SystemHealthResponse> {
  return transport.call<SystemHealthResponse>(
    'system-health.all',
    undefined,
    signal ? { signal } : undefined,
  );
}
