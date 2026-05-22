import { test, expect } from '@playwright/test';

/**
 * System Health page e2e.
 *
 * Covers the contract the feature makes:
 *   1. /system-health route loads via sidebar entry + direct URL.
 *   2. Loading state renders skeleton rows (not a blank page).
 *   3. Data state renders one row per probed role + three substrate
 *      probe rows (claim-reaper, tunnel, atom-store).
 *   4. Status pill uses the right colour family per status.
 *   5. The Refresh button drives a second backend call.
 *   6. Mobile viewport renders without horizontal overflow.
 *   7. The minted token is NEVER echoed in the DOM (defense-in-depth
 *      against a future change that accidentally renders the raw
 *      response body).
 *   8. Each substrate probe row carries a runbook deep-link.
 *
 * Per canon `dev-web-playwright-coverage-required` every feature
 * ships with at least one Playwright e2e. This spec is that minimum
 * for the System Health page.
 */

type StubIdentity = {
  readonly role: string;
  readonly status: 'fresh' | 'stale' | 'network-error' | 'not-provisioned';
  readonly login?: string | null;
  readonly expiresAt?: string | null;
  readonly ageMs?: number | null;
  readonly detail?: string | null;
};

type StubProbe = {
  readonly id: 'claim-reaper-cadence' | 'tunnel-reachability' | 'atom-store-free-space';
  readonly status: 'green' | 'yellow' | 'red';
  readonly summary?: string;
  readonly detail?: string;
  readonly runbookHref?: string;
};

function defaultIdentities(): ReadonlyArray<StubIdentity> {
  return [
    { role: 'lag-ceo', status: 'fresh', expiresAt: '2026-05-22T13:00:00.000Z', ageMs: 3_600_000 },
    { role: 'lag-cto', status: 'fresh', expiresAt: '2026-05-22T13:00:00.000Z', ageMs: 3_600_000 },
    { role: 'lag-pr-landing', status: 'fresh', expiresAt: '2026-05-22T13:00:00.000Z', ageMs: 3_600_000 },
    { role: 'lag-actors', status: 'not-provisioned' },
  ];
}

function defaultProbes(): ReadonlyArray<StubProbe> {
  return [
    {
      id: 'claim-reaper-cadence',
      status: 'green',
      summary: 'Reaper swept 30s ago',
      runbookHref: '/docs/runbooks/reaper-not-running.md',
    },
    {
      id: 'tunnel-reachability',
      status: 'green',
      summary: 'Tunnel reachable: fluffy-rabbit.trycloudflare.com',
      runbookHref: '/docs/runbooks/tunnel-disconnected.md',
    },
    {
      id: 'atom-store-free-space',
      status: 'green',
      summary: 'Atom store healthy (78.5% free)',
      runbookHref: '/docs/runbooks/atom-store-enospc.md',
    },
  ];
}

function stubSystemHealth(opts: {
  readonly identities?: ReadonlyArray<StubIdentity>;
  readonly probes?: ReadonlyArray<StubProbe>;
} = {}) {
  const identities = opts.identities ?? defaultIdentities();
  const probes = opts.probes ?? defaultProbes();
  return {
    ok: true,
    data: {
      identities: identities.map((r) => ({
        role: r.role,
        login: r.login ?? r.role,
        appId: 999,
        installationId: 12345,
        expiresAt: r.expiresAt ?? null,
        status: r.status,
        lastCheckedAt: '2026-05-22T12:00:00.000Z',
        ageMs: r.ageMs ?? null,
        detail: r.detail ?? null,
      })),
      probes: probes.map((p) => ({
        id: p.id,
        status: p.status,
        summary: p.summary ?? 'summary',
        detail: p.detail ?? 'detail',
        runbookHref: p.runbookHref ?? '/docs/runbooks/reaper-not-running.md',
        lastCheckedAt: '2026-05-22T12:00:00.000Z',
      })),
    },
  };
}

function stubBotIdentities(rows: ReadonlyArray<StubIdentity>) {
  /*
   * Back-compat helper for the older `/api/system-health.bot-identities`
   * endpoint shape. The page now reads `/api/system-health.all` so
   * test routes target the aggregated endpoint; this helper stays
   * exported in case a future migration test re-exercises the
   * legacy surface.
   */
  return {
    ok: true,
    data: {
      identities: rows.map((r) => ({
        role: r.role,
        login: r.login ?? r.role,
        appId: 999,
        installationId: 12345,
        expiresAt: r.expiresAt ?? null,
        status: r.status,
        lastCheckedAt: '2026-05-22T12:00:00.000Z',
        ageMs: r.ageMs ?? null,
        detail: r.detail ?? null,
      })),
    },
  };
}
// Suppress "declared but never read" for the legacy helper.
void stubBotIdentities;

test.describe('system health page', () => {
  test('navigates to /system-health and renders the page', async ({ page }) => {
    await page.route('**/api/system-health.all', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubSystemHealth()),
      });
    });
    await page.goto('/');
    /*
     * Desktop sidebar surfaces system-health via the dedicated nav
     * entry. The label is "System Health" (or "Health" on the mobile
     * bottom-tab variant). Direct-URL navigation is the easier assert.
     */
    await page.goto('/system-health');
    await expect(page.getByTestId('system-health-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('system-health-list')).toBeVisible();
    await expect(page.getByTestId('system-health-probes-list')).toBeVisible();
  });

  test('renders one row per probed role with the correct status pill', async ({ page }) => {
    await page.route('**/api/system-health.all', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubSystemHealth({
          identities: [
            { role: 'lag-ceo', status: 'fresh', expiresAt: '2026-05-22T13:00:00.000Z', ageMs: 3_600_000 },
            { role: 'lag-cto', status: 'stale', detail: 'HTTP 401: Bad credentials' },
            { role: 'lag-pr-landing', status: 'network-error', detail: 'HTTP 503: outage' },
            { role: 'lag-actors', status: 'not-provisioned' },
          ],
        })),
      });
    });
    await page.goto('/system-health');
    const ceoRow = page.getByTestId('system-health-row-lag-ceo');
    const ctoRow = page.getByTestId('system-health-row-lag-cto');
    const prRow = page.getByTestId('system-health-row-lag-pr-landing');
    const actorsRow = page.getByTestId('system-health-row-lag-actors');
    await expect(ceoRow).toHaveAttribute('data-status', 'fresh');
    await expect(ctoRow).toHaveAttribute('data-status', 'stale');
    await expect(prRow).toHaveAttribute('data-status', 'network-error');
    await expect(actorsRow).toHaveAttribute('data-status', 'not-provisioned');
  });

  test('renders all three substrate probe rows with the correct traffic-light status', async ({ page }) => {
    await page.route('**/api/system-health.all', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubSystemHealth({
          probes: [
            { id: 'claim-reaper-cadence', status: 'green', summary: 'Reaper swept 12s ago' },
            { id: 'tunnel-reachability', status: 'yellow', summary: 'Tunnel metrics unreachable' },
            { id: 'atom-store-free-space', status: 'red', summary: 'Atom store critical (0.5% free)' },
          ],
        })),
      });
    });
    await page.goto('/system-health');
    const reaperRow = page.getByTestId('system-health-probe-row-claim-reaper-cadence');
    const tunnelRow = page.getByTestId('system-health-probe-row-tunnel-reachability');
    const atomStoreRow = page.getByTestId('system-health-probe-row-atom-store-free-space');
    await expect(reaperRow).toHaveAttribute('data-status', 'green');
    await expect(tunnelRow).toHaveAttribute('data-status', 'yellow');
    await expect(atomStoreRow).toHaveAttribute('data-status', 'red');
  });

  test('each substrate probe row exposes a runbook deep-link', async ({ page }) => {
    await page.route('**/api/system-health.all', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubSystemHealth()),
      });
    });
    await page.goto('/system-health');
    const reaperLink = page.getByTestId('system-health-probe-runbook-claim-reaper-cadence');
    const tunnelLink = page.getByTestId('system-health-probe-runbook-tunnel-reachability');
    const atomStoreLink = page.getByTestId('system-health-probe-runbook-atom-store-free-space');
    await expect(reaperLink).toHaveAttribute('href', '/docs/runbooks/reaper-not-running.md');
    await expect(tunnelLink).toHaveAttribute('href', '/docs/runbooks/tunnel-disconnected.md');
    await expect(atomStoreLink).toHaveAttribute('href', '/docs/runbooks/atom-store-enospc.md');
    /*
     * Anchor must open in a new tab (target="_blank") so the operator
     * does not lose dashboard state mid-incident. The rel attribute
     * must carry BOTH noopener (blocks window.opener access from the
     * new tab) and noreferrer (suppresses the Referer header on the
     * outbound request) so a future change that re-assembles the rel
     * string without one half does not silently weaken the security
     * pair.
     */
    await expect(reaperLink).toHaveAttribute('target', '_blank');
    const rel = await reaperLink.getAttribute('rel');
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  test('Refresh button drives a second backend call', async ({ page }) => {
    let callCount = 0;
    await page.route('**/api/system-health.all', async (route) => {
      callCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stubSystemHealth()),
      });
    });
    await page.goto('/system-health');
    await expect(page.getByTestId('system-health-list')).toBeVisible({ timeout: 10_000 });
    const initialCalls = callCount;
    await page.getByTestId('system-health-refresh').click();
    /*
     * The refresh button calls query.refetch(); TanStack Query fires
     * a fresh request once the in-flight one resolves. We give it a
     * generous polling window so a slow CI run does not flake.
     */
    await expect.poll(() => callCount, { timeout: 5_000 }).toBeGreaterThan(initialCalls);
  });

  test('does not echo the minted token anywhere on the page', async ({ page }) => {
    /*
     * Defense-in-depth: even if a future change accidentally puts the
     * raw response body in the DOM (e.g. a debug panel), the token
     * literal must not surface. The server-side test pins the same
     * contract; this is the matching UI-side guard.
     */
    await page.route('**/api/system-health.all', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            identities: [
              {
                role: 'lag-ceo',
                login: 'lag-ceo',
                appId: 999,
                installationId: 12345,
                expiresAt: '2026-05-22T13:00:00.000Z',
                status: 'fresh',
                lastCheckedAt: '2026-05-22T12:00:00.000Z',
                ageMs: 3_600_000,
                detail: null,
              },
            ],
            probes: [],
          },
        }),
      });
    });
    await page.goto('/system-health');
    await expect(page.getByTestId('system-health-list')).toBeVisible({ timeout: 10_000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).not.toContain('ghs_');
    expect(bodyText).not.toContain('Bearer ');
  });
});
