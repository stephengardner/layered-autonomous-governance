import { transport } from './transport';

/**
 * Bot-identity health projection. Mirrors the server's
 * BotIdentityHealthResponse contract (apps/console/server/system-health.ts).
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

export async function getBotIdentityHealth(
  signal?: AbortSignal,
): Promise<BotIdentityHealthResponse> {
  return transport.call<BotIdentityHealthResponse>(
    'system-health.bot-identities',
    undefined,
    signal ? { signal } : undefined,
  );
}
