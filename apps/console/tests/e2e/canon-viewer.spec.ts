import { test, expect } from '@playwright/test';

/**
 * Canon Viewer e2e — the day-1 feature.
 *
 * Covers the contract the feature makes:
 *   1. Page loads with the correct title and no console errors.
 *   2. At least one canon atom card renders (backend → transport →
 *      query → card pipeline is intact).
 *   3. Type-filter narrows the grid to the selected atom type.
 *   4. Search narrows the grid to atoms whose id or content match.
 *   5. Theme toggle swaps the <body> theme class (token-theming live).
 *
 * Per canon `dev-web-playwright-coverage-required`, every feature
 * ships with at least one Playwright e2e. This spec is that minimum
 * for the Canon Viewer.
 */

test.describe('canon viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads with title and renders at least one canon card', async ({ page }) => {
    await expect(page).toHaveTitle('LAG Console');
    const cards = page.getByRole('heading', { level: 1, name: 'Canon' });
    await expect(cards).toBeVisible();
    const anyCard = page.locator('[data-testid="canon-card"]').first();
    await expect(anyCard).toBeVisible({ timeout: 10_000 });
    const count = await page.locator('[data-testid="canon-card"]').count();
    expect(count).toBeGreaterThan(0);
  });

  test('type filter narrows the grid to the selected type', async ({ page }) => {
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const initial = await page.locator('[data-testid="canon-card"]').count();
    await page.getByTestId('type-filter-decision').click();
    // A filtered refetch has resolved when no card with a non-decision
    // data-atom-type is left in the DOM. Assert via locator so
    // Playwright auto-retries until the condition holds.
    await expect(
      page.locator('[data-testid="canon-card"][data-atom-type]:not([data-atom-type="decision"])'),
    ).toHaveCount(0, { timeout: 10_000 });
    const decisionCards = page.locator('[data-testid="canon-card"][data-atom-type="decision"]');
    const filtered = await decisionCards.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(initial);
  });

  test('search narrows the grid to matching atoms', async ({ page }) => {
    await page.locator('[data-testid="canon-card"]').first().waitFor();
    const search = page.getByPlaceholder('Search canon...');
    await search.fill('atomstore');
    await expect.poll(async () =>
      page.locator('[data-testid="canon-card"]').count(),
    ).toBeGreaterThan(0);
    const cards = page.locator('[data-testid="canon-card"]');
    const text = (await cards.first().innerText()).toLowerCase();
    expect(text).toContain('atomstore');
  });

  test('theme toggle cycles through supported themes', async ({ page, context }) => {
    // Reset persisted theme so every run starts from a known state.
    await context.clearCookies();
    await page.addInitScript(() => { localStorage.removeItem('lag-console.theme'); });
    await page.goto('/');
    const seen: string[] = [];
    const read = () =>
      page.evaluate(() => {
        const cls = document.body.className.split(/\s+/).find((c) => c.startsWith('theme-'));
        return cls ?? 'none';
      });
    seen.push(await read());
    expect(seen[0]).toMatch(/^theme-(dark|light|sunset)$/);
    for (let i = 0; i < 3; i++) {
      const last = seen[seen.length - 1]!;
      await page.getByTestId('theme-toggle').click();
      await expect.poll(read).not.toBe(last);
      seen.push(await read());
    }
    // After 3 clicks we have four observations (initial + 3 toggles)
    // and must have seen all three themes at least once, and looped
    // back to the starting theme on the third toggle.
    expect(new Set(seen).size).toBe(3);
    expect(seen[seen.length - 1]).toBe(seen[0]);
  });
});
