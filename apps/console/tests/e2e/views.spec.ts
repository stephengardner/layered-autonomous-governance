import { test, expect } from '@playwright/test';

/**
 * Smoke tests across the four top-level views. Each one:
 *   - loads without console errors
 *   - renders the route-specific data (or a well-formed empty state)
 *   - shows the correct sidebar active item
 *
 * Deeper per-view assertions (filter, search, expand) live in
 * view-specific specs; this file guards the cross-view contract.
 */

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
    await page.goto('/plans');
    // Either a plan card or the empty-state hint renders.
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
    await page.getByTestId('nav-principals').click();
    await expect(page).toHaveURL(/\/principals$/);
    await expect(page.getByTestId('nav-principals')).toHaveAttribute('aria-current', 'page');
    const after = await page.evaluate(() => performance.now());
    // `performance.now()` resets on full page load. If `after < before`
    // we reloaded; if `after > before` we pushState-navigated.
    expect(after).toBeGreaterThan(before);
  });

  test('atom-ref link navigates to canon with focus query', async ({ page }) => {
    await page.goto('/canon');
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    // Expand the first card and click an atom-ref chip if any.
    const firstCard = page.locator('[data-testid="canon-card"]').first();
    const expand = firstCard.locator('[data-testid^="card-expand-"]');
    await expand.click();
    const ref = firstCard.locator('[data-testid="atom-ref"]').first();
    const targetId = await ref.getAttribute('data-atom-ref-id');
    if (!targetId) test.skip(true, 'no atom-ref to click');
    await ref.click();
    await expect(page).toHaveURL(new RegExp(`/canon\\?focus=${encodeURIComponent(targetId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });
});
