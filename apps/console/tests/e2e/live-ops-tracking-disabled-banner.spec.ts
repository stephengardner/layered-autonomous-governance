import { test, expect, type Route } from '@playwright/test';

/**
 * Pulse "operator session tracking is off" banner e2e.
 *
 * Mocks /api/live-ops.snapshot across three states so the banner's
 * visibility contract is pinned independent of whatever the live
 * atom store happens to contain at test time. The mock fulfills
 * the canonical envelope shape `{ ok: true, data: <snapshot> }`
 * that server/index.ts produces.
 *
 * Coverage:
 *   1. Heartbeat all-zero AND active_sessions empty -> banner visible.
 *   2. Heartbeat last_5m=1 (real activity tracked) -> banner absent
 *      even though active_sessions is empty.
 *   3. Heartbeat all-zero AND active_sessions has one entry -> banner
 *      absent because LAG actor sessions ARE firing.
 *
 * Includes a dismissal sub-test to assert the close button hides the
 * banner and the storage flag survives a page reload (sessionStorage-
 * equivalent affordance via the storage service).
 *
 * Mobile coverage runs automatically: playwright.config.ts registers
 * a `mobile` project (iPhone 13) so every spec executes desktop +
 * mobile per canon dev-web-mobile-first-required.
 */

interface SnapshotOverrides {
  readonly last_60s?: number;
  readonly last_5m?: number;
  readonly last_1h?: number;
  readonly delta?: number;
  readonly active_sessions?: ReadonlyArray<{
    readonly session_id: string;
    readonly principal_id: string;
    readonly started_at: string;
    readonly last_turn_at: string | null;
  }>;
}

function snapshotEnvelope(overrides: SnapshotOverrides = {}) {
  return {
    ok: true,
    data: {
      computed_at: new Date().toISOString(),
      heartbeat: {
        last_60s: overrides.last_60s ?? 0,
        last_5m: overrides.last_5m ?? 0,
        last_1h: overrides.last_1h ?? 0,
        delta: overrides.delta ?? 0,
      },
      active_sessions: overrides.active_sessions ?? [],
      live_deliberations: [],
      in_flight_executions: [],
      recent_transitions: [],
      daemon_posture: {
        kill_switch_engaged: false,
        kill_switch_tier: 'soft' as const,
        autonomy_dial: 0,
        active_elevations: [],
      },
      pr_activity: [],
    },
  };
}

async function mockSnapshot(
  routeFn: (
    url: string,
    handler: (route: Route) => Promise<void> | void,
  ) => Promise<void>,
  overrides: SnapshotOverrides = {},
): Promise<void> {
  await routeFn('**/api/live-ops.snapshot', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshotEnvelope(overrides)),
    });
  });
}

test.describe('live ops tracking-disabled banner', () => {
  /*
   * Each Playwright test runs in a fresh browser context with
   * isolated storage state by default, so the dismiss flag at
   * `lag-console.pulse.tracking-disabled-banner.dismissed` cannot
   * bleed between tests. No explicit beforeEach reset is needed.
   */

  test('banner is visible when heartbeat is zero and active_sessions is empty', async ({ page }) => {
    await mockSnapshot(page.route.bind(page));
    await page.goto('/live-ops');

    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    const banner = page.getByTestId('live-ops-tracking-disabled-banner');
    await expect(banner).toBeVisible();

    /*
     * Accessibility contract: role="status" + aria-live="polite" so
     * screen readers announce the hint without interrupting an
     * in-progress reading. The dismiss button carries an aria-label
     * because its visible content is icon-only.
     */
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toHaveAttribute('aria-live', 'polite');

    /*
     * Message body MUST mention LAG_OPERATOR_ID by name so the
     * operator's grep-history surfaces this banner as the source of
     * truth six months later.
     */
    await expect(banner).toContainText('LAG_OPERATOR_ID');
    await expect(banner).toContainText('Operator session tracking is off');

    /*
     * Docs link points at the canonical getting-started doc and opens
     * in a new tab with rel="noopener noreferrer" per
     * security-correctness-at-write-time.
     */
    const link = page.getByTestId('live-ops-tracking-disabled-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    const rel = await link.getAttribute('rel');
    expect(rel, 'rel attribute should be present').not.toBeNull();
    expect(rel).toMatch(/noopener/);
    expect(rel).toMatch(/noreferrer/);
  });

  test('banner is hidden when heartbeat reports any activity', async ({ page }) => {
    /*
     * One non-zero window means the substrate is observing SOMETHING.
     * The banner would be a false alarm; the autonomous loop is
     * firing and the operator's terminal-session silence is a
     * separate (smaller) concern.
     */
    await mockSnapshot(page.route.bind(page), { last_5m: 1 });
    await page.goto('/live-ops');

    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-ops-heartbeat')).toBeVisible();
    await expect(page.getByTestId('live-ops-tracking-disabled-banner')).toHaveCount(0);
  });

  test('banner is hidden when active_sessions has any entry', async ({ page }) => {
    /*
     * An active session is the strongest signal that tracking works
     * in some channel; suppressing the banner avoids alarming an
     * operator whose autonomous loop is healthy.
     */
    await mockSnapshot(page.route.bind(page), {
      active_sessions: [
        {
          session_id: 'sess-mock-1',
          principal_id: 'mock-actor',
          started_at: new Date().toISOString(),
          last_turn_at: null,
        },
      ],
    });
    await page.goto('/live-ops');

    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-ops-heartbeat')).toBeVisible();
    await expect(page.getByTestId('live-ops-tracking-disabled-banner')).toHaveCount(0);
  });

  test('dismiss button hides the banner and persists across reload', async ({ page }) => {
    /*
     * The dismiss flag lives in storage.service (localStorage-backed),
     * so a reload should NOT re-show the banner. Clearing the flag
     * (manually or via storage clear) brings it back -- exercised by
     * the beforeEach cleanup in subsequent tests.
     */
    await mockSnapshot(page.route.bind(page));
    await page.goto('/live-ops');

    const banner = page.getByTestId('live-ops-tracking-disabled-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });

    const dismiss = page.getByTestId('live-ops-tracking-disabled-dismiss');
    await expect(dismiss).toHaveAttribute('aria-label', 'Dismiss operator session tracking hint');
    await dismiss.click();
    await expect(banner).toHaveCount(0);

    /*
     * Reload preserves the dismissal: the storage flag is read
     * synchronously on banner mount via storage.get, and a true value
     * keeps the banner suppressed.
     */
    await page.reload();
    await expect(page.getByTestId('live-ops-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-ops-tracking-disabled-banner')).toHaveCount(0);
  });
});
