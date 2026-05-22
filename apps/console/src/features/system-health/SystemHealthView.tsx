import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertCircle, CheckCircle2, HelpCircle, RefreshCw, XCircle } from 'lucide-react';
import { ErrorState } from '@/components/state-display/StateDisplay';
import { Skeleton } from '@/components/skeleton/Skeleton';
import {
  getBotIdentityHealth,
  type BotIdentityHealth,
  type IdentityStatus,
} from '@/services/system-health.service';
import { toErrorMessage } from '@/services/errors';
import styles from './SystemHealthView.module.css';

/**
 * System Health dashboard.
 *
 * Renders per-bot-identity health rows so an operator can see at a
 * glance which provisioned bot identities still authenticate and
 * which are stale, network-flaky, or unprovisioned. Today the only
 * surface is bot-identity health; the page is named broadly because
 * future health probes (claim-reaper cadence, atom-store free space,
 * tunnel reachability) will land as additional rows or sections here.
 *
 * Refresh cadence: 30 seconds via TanStack Query refetchInterval. Bot
 * tokens normally live for an hour, so sub-minute resolution would
 * over-mint installation tokens against GitHub's API without
 * actionable operator-visible benefit. The Refresh button drives a
 * manual refetch when an operator wants a "right now" snapshot.
 *
 * Mobile-first: single-column rows below 48rem; a tabular layout at
 * larger widths. Status pills meet the 44x44 touch-target floor only
 * if interactive; today they are purely informational (the row is the
 * click target if any future drill-through lands).
 *
 * Loading state: skeleton rows that match the live layout, so the
 * page does not flicker from blank to populated. Per canon
 * `dev-web-interaction-app-grade-discipline`.
 */
const REFETCH_MS = 30_000;

export function SystemHealthView() {
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(() => Date.now());
  const query = useQuery({
    queryKey: ['system-health', 'bot-identities'],
    queryFn: ({ signal }) => getBotIdentityHealth(signal),
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
  });

  const handleRefresh = () => {
    setLastRefreshedAt(Date.now());
    void query.refetch();
  };

  return (
    <section className={styles.view} data-testid="system-health-view">
      <header className={styles.intro}>
        <div className={styles.introText}>
          <h2 className={styles.heroTitle}>System Health</h2>
          <p className={styles.heroSubtitle}>
            Per-bot-identity health probe. Each row reflects whether
            the role's GitHub App credentials still mint a valid
            installation token. Stale rows mean the App was uninstalled,
            the private key rotated, or the installation revoked, and
            the next push from that bot will fail with a 401.
          </p>
        </div>
        <div className={styles.refreshGroup}>
          <span className={styles.lastRefreshed} data-testid="system-health-last-refreshed">
            {query.dataUpdatedAt > 0
              ? `Last checked ${formatRelative(query.dataUpdatedAt)}`
              : 'Loading...'}
          </span>
          <button
            type="button"
            className={styles.refreshButton}
            onClick={handleRefresh}
            disabled={query.isFetching}
            aria-busy={query.isFetching}
            aria-label="Refresh bot identity health"
            data-testid="system-health-refresh"
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className={query.isFetching ? styles.refreshSpinning : undefined}
            />
            <span className={styles.refreshLabel}>Refresh</span>
          </button>
        </div>
      </header>

      <BotIdentitiesSection query={query} lastRefreshedAt={lastRefreshedAt} />
    </section>
  );
}

/*
 * formatRelative: tiny relative-time formatter shared with other
 * dashboards. Kept local because the substrate's project-wide formatter
 * lives in pipelines-viewer and importing across feature boundaries
 * for one helper would couple this feature to that one. Once a third
 * call site materialises, extract per canon dev-dry-extract-at-second-duplication.
 */
function formatRelative(ms: number): string {
  const deltaSeconds = Math.round((Date.now() - ms) / 1000);
  if (deltaSeconds < 60) return `${Math.max(0, deltaSeconds)}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

function BotIdentitiesSection({
  query,
  lastRefreshedAt,
}: {
  readonly query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getBotIdentityHealth>>>>;
  readonly lastRefreshedAt: number;
}) {
  /*
   * Loading state: render 4 skeleton rows that match the live row
   * shape. This avoids the flash-of-blank pattern that violates
   * dev-web-interaction-app-grade-discipline. lastRefreshedAt is
   * threaded in to key the skeleton block so manual-refresh restarts
   * the skeleton-fade animation; without it, a refetch flips
   * instantly to data with no visible feedback.
   */
  if (query.isPending) {
    return (
      <div className={styles.tableWrap} key={`skeleton-${lastRefreshedAt}`}>
        <ul className={styles.identityList} data-testid="system-health-loading">
          {Array.from({ length: 4 }).map((_, idx) => (
            <li key={idx} className={styles.identityRow}>
              <div className={styles.identityRoleCell}>
                <Skeleton width="6rem" height="1.1rem" />
                <Skeleton width="9rem" height="0.875rem" />
              </div>
              <div className={styles.identityStatusCell}>
                <Skeleton width="4.5rem" height="1.5rem" radius="var(--radius-pill)" />
              </div>
              <div className={styles.identityAgeCell}>
                <Skeleton width="5rem" height="0.875rem" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Could not load bot identity health"
        message={toErrorMessage(query.error)}
        testId="system-health-error"
      />
    );
  }

  const identities = query.data?.identities ?? [];
  if (identities.length === 0) {
    /*
     * Empty state: no roles provisioned at all. The PROBED_ROLES
     * tuple always emits at least one row (even not-provisioned) so
     * this branch is structurally unreachable today; kept as a
     * defensive fallback so a future change that filters rows server-
     * side does not blank the page.
     */
    return (
      <div className={styles.empty} data-testid="system-health-empty">
        <Activity size={32} strokeWidth={1.5} aria-hidden="true" />
        <p>No bot identities reported. Run <code>node bin/lag-actors.js sync</code> to provision.</p>
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <ul className={styles.identityList} data-testid="system-health-list">
        {identities.map((identity) => (
          <IdentityRow key={identity.role} identity={identity} />
        ))}
      </ul>
    </div>
  );
}

function IdentityRow({ identity }: { readonly identity: BotIdentityHealth }) {
  return (
    <li
      className={styles.identityRow}
      data-testid={`system-health-row-${identity.role}`}
      data-status={identity.status}
    >
      <div className={styles.identityRoleCell}>
        <div className={styles.identityRoleName}>{identity.role}</div>
        <div className={styles.identityRoleSub}>
          {identity.login ? `${identity.login}[bot]` : 'not provisioned'}
          {identity.installationId !== null
            ? ` - installation #${identity.installationId}`
            : null}
        </div>
        {identity.detail !== null ? (
          <div className={styles.identityDetail} title={identity.detail}>
            {identity.detail}
          </div>
        ) : null}
      </div>
      <div className={styles.identityStatusCell}>
        <StatusPill status={identity.status} />
      </div>
      <div className={styles.identityAgeCell}>
        {identity.expiresAt !== null ? (
          <>
            <span className={styles.identityAgeLabel}>Token valid for</span>
            <span className={styles.identityAgeValue}>{formatAge(identity.ageMs)}</span>
          </>
        ) : (
          <span className={styles.identityAgeNone}>--</span>
        )}
      </div>
    </li>
  );
}

function StatusPill({ status }: { readonly status: IdentityStatus }) {
  /*
   * data-status drives the pill colour via the CSS module. Pinning
   * the icon here so each status renders with its own glyph; the
   * colour family lives in CSS so a future theme can re-skin without
   * touching JSX.
   */
  const config = {
    fresh: { label: 'Healthy', Icon: CheckCircle2 },
    stale: { label: 'Stale', Icon: AlertCircle },
    'network-error': { label: 'Network error', Icon: XCircle },
    'not-provisioned': { label: 'Not provisioned', Icon: HelpCircle },
  } as const;
  const { label, Icon } = config[status];
  return (
    <span
      className={styles.statusPill}
      data-status={status}
      role="status"
      aria-label={`Status: ${label}`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/*
 * formatAge: humanises the ms-until-expiry value. Negative or null
 * surfaces as "expired" so an operator sees the stale token even when
 * the status pill is already red.
 */
function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '--';
  if (ageMs <= 0) return 'expired';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = minutes - hours * 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

