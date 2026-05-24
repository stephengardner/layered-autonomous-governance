import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke tests across the four top-level views. Each one:
 *   - loads without console errors
 *   - renders the route-specific data (or a well-formed empty state)
 *   - shows the correct sidebar active item
 *
 * Deeper per-view assertions (filter, search, expand) live in
 * view-specific specs; this file guards the cross-view contract.
 *
 * Mobile/desktop dual nav: the sidebar renders both a desktop nav
 * (`data-testid="nav-<id>"`) and a mobile bottom-tab bar
 * (`data-testid="mobile-nav-<id>"` for the 4 critical items, plus an
 * overflow drawer for the rest). At iPhone-13-class viewports the
 * desktop nav is `display:none`. Tests that click a nav item must
 * route through the visible chrome: the mobile bar for `dashboard`,
 * `control`, `canon`, `plans`; the overflow drawer for everything
 * else (e.g. `principals`).
 */

/**
 * Click a sidebar item by id. Picks the visible chrome:
 *   - desktop:  data-testid="nav-<id>"
 *   - mobile bar (4 critical items): data-testid="mobile-nav-<id>"
 *   - mobile overflow (everything else): opens drawer + clicks
 *     data-testid="mobile-nav-overflow-item-<id>"
 *
 * The active-attribute assertion still uses the desktop testid -- the
 * desktop anchor stays in the DOM at mobile widths (just hidden via
 * `display:none`), so `aria-current="page"` is still readable from it.
 */
async function clickNav(page: Page, id: string): Promise<void> {
  const viewport = page.viewportSize();
  const isMobile = viewport ? viewport.width <= 768 : false;
  if (!isMobile) {
    await page.getByTestId(`nav-${id}`).click();
    return;
  }
  const mobileBar = page.getByTestId(`mobile-nav-${id}`);
  if (await mobileBar.isVisible().catch(() => false)) {
    await mobileBar.click();
    return;
  }
  // Item lives in the overflow drawer.
  await page.getByTestId('mobile-nav-more').click();
  const overflowItem = page.getByTestId(`mobile-nav-overflow-item-${id}`);
  await overflowItem.click();
}

test.describe('views smoke', () => {
  test('canon renders at least one canon-card', async ({ page }) => {
    await page.goto('/canon');
    await expect(page.locator('[data-testid="canon-card"]').first()).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-canon');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('principals renders at least one principal-card', async ({ page }) => {
    await page.goto('/principals');
    await expect(page.locator('[data-testid="principal-card"]').first()).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-principals');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('activities renders at least one activity-item', async ({ page }) => {
    await page.goto('/activities');
    await expect(page.locator('[data-testid="activity-item"]').first()).toBeVisible({ timeout: 10_000 });
    const active = page.getByTestId('nav-activities');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('plans renders a plan-card or empty state', async ({ page }) => {
    /*
     * The Plans view defaults to the `active` bucket filter. To keep
     * this test asserting the bare "view mounts" property (and not
     * implicitly asserting "the dataset has an active plan"), opt
     * into the `all` bucket so the assertion is independent of which
     * states happen to be present.
     */
    await page.goto('/plans');
    await page.evaluate(() => {
      localStorage.setItem('lag-console.plans-filter-bucket', JSON.stringify('all'));
    });
    await page.reload();
    const hasCard = page.locator('[data-testid="plan-card"]').first();
    const empty = page.locator('[data-testid="plans-empty"]');
    await Promise.race([
      hasCard.waitFor({ state: 'visible', timeout: 10_000 }),
      empty.waitFor({ state: 'visible', timeout: 10_000 }),
    ]);
    const active = page.getByTestId('nav-plans');
    await expect(active).toHaveAttribute('aria-current', 'page');
  });

  test('clicking a sidebar item navigates without page reload', async ({ page }) => {
    await page.goto('/canon');
    const before = await page.evaluate(() => performance.now());
    await clickNav(page, 'principals');
    await expect(page).toHaveURL(/\/principals$/);
    // The desktop anchor stays in DOM at every viewport and carries the
    // active aria-current attribute; reading from it works regardless of
    // whether the user clicked it directly (desktop) or routed through
    // the mobile overflow drawer.
    await expect(page.getByTestId('nav-principals')).toHaveAttribute('aria-current', 'page');
    const after = await page.evaluate(() => performance.now());
    // `performance.now()` resets on full page load. If `after < before`
    // we reloaded; if `after > before` we pushState-navigated.
    expect(after).toBeGreaterThan(before);
  });

  test('atom-ref link navigates to /<view>/<id>', async ({ page }) => {
    await page.goto('/canon');
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    // Expand cards until one yields an atom-ref chip. Earlier the test
    // hard-coded "first card" but canon ordering is unstable across
    // viewports (mobile may render a card first that has zero refs
    // since `refs` is a derived field; the desktop spec passed because
    // index 0 happened to carry refs). Walk a small candidate window
    // so the test asserts the cross-surface link contract without
    // depending on which card lands first.
    const cards = page.locator('[data-testid="canon-card"]');
    const cardCount = await cards.count();
    const limit = Math.min(cardCount, 5);
    let found: { id: string; route: string; ref: ReturnType<typeof page.locator> } | null = null;
    for (let i = 0; i < limit; i++) {
      const card = cards.nth(i);
      const expand = card.locator('[data-testid^="card-expand-"]');
      await expand.click();
      const ref = card.locator('[data-testid="atom-ref"]').first();
      const refCount = await card.locator('[data-testid="atom-ref"]').count();
      if (refCount === 0) {
        // collapse and try the next card
        await expand.click();
        continue;
      }
      const targetId = await ref.getAttribute('data-atom-ref-id');
      const targetRoute = await ref.getAttribute('data-atom-ref-target');
      if (targetId && targetRoute) {
        found = { id: targetId, route: targetRoute, ref };
        break;
      }
      await expand.click();
    }
    if (!found) test.skip(true, 'no atom-ref to click in the first 5 canon cards');
    await found!.ref.click();
    const escaped = encodeURIComponent(found!.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/${found!.route}/${escaped}$`));
  });

  test('plan card is clickable → opens in focus mode', async ({ page }) => {
    await page.goto('/plans');
    // Show all states so the test isn't dependent on the default
    // active-bucket filter having matches.
    await page.evaluate(() => {
      localStorage.setItem('lag-console.plans-filter-bucket', JSON.stringify('all'));
    });
    await page.reload();
    const firstCard = page.locator('[data-testid="plan-card"]').first();
    await firstCard.waitFor();
    const planId = await firstCard.getAttribute('data-atom-id');
    if (!planId) test.skip(true, 'no plan card to click');
    const link = firstCard.locator('[data-testid="plan-card-link"]');
    await link.click();
    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/plans/${escaped}$`));
    await expect(page.getByTestId('focus-banner')).toBeVisible();
  });

  test('graph view renders nodes from the substrate', async ({ page }) => {
    await page.goto('/graph');
    await expect(page.locator('[data-testid="graph-svg"]')).toBeVisible();
    await expect.poll(() => page.locator('[data-testid="graph-node"]').count(), { timeout: 10_000 })
      .toBeGreaterThan(10);
  });

  test('kill-switch pill renders in header', async ({ page }) => {
    await page.goto('/canon');
    await expect(page.getByTestId('kill-switch-pill')).toBeVisible();
    // The pill renders in a loading state (no data-tier attribute) until
    // /api/kill-switch.read settles. Poll for the tier attribute so the
    // test passes regardless of whether the network request was already
    // cached or had to round-trip on a fresh load. Without this, mobile
    // viewports (which mount slower under animation) can read the
    // loading pill before the query resolves and see `null`.
    await expect.poll(
      async () => await page.getByTestId('kill-switch-pill').getAttribute('data-tier'),
      { timeout: 10_000 },
    ).toMatch(/^(off|soft|medium|hard)$/);
  });

  /*
   * Regression guard for the canon focus flash: when navigating
   * directly to /canon/<id>, the page should never briefly render
   * the unfiltered canon grid. We sample the visible card set on
   * every animation frame for 500ms after navigation and assert
   * that the count never exceeded the search-match cardinality.
   *
   * Earlier this test asserted <= 1 but backend search is a
   * substring filter — any atom whose CONTENT cites the focused
   * id also matches (e.g. "per arch-atomstore-source-of-truth").
   * A handful of legitimate matches is not a flash. 10 is a
   * generous ceiling — the pre-fix flash exceeded 70.
   */
  test('/canon/:id never flashes the unfiltered grid', async ({ page }) => {
    await page.goto('/canon');
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const atomId = 'arch-atomstore-source-of-truth';
    await page.goto(`/canon/${atomId}`);
    const samples: number[] = [];
    const end = Date.now() + 500;
    while (Date.now() < end) {
      samples.push(await page.locator('[data-testid="canon-card"]').count());
      await page.waitForTimeout(25);
    }
    const maxSeen = Math.max(...samples, 0);
    expect(maxSeen, `canon focus flashed unfiltered data: saw up to ${maxSeen} cards`).toBeLessThanOrEqual(10);
    await expect(page.locator(`[data-testid="canon-card"][data-atom-id="${atomId}"]`)).toBeVisible();
  });
});
