import { expect, test } from '@playwright/test';

/*
 * Storage key is namespaced through storage.service which prefixes
 * every key with `lag-console.` (apps/console/CLAUDE.md principle 10).
 * The resolved key is what the browser sees in localStorage; assert
 * against it directly to keep the persistence contract testable
 * without reaching into the hook's internals.
 */
const STORAGE_KEY = 'lag-console.pinned-plans';

test.describe('Pinned plans persistence', () => {
  test.beforeEach(async ({ page }) => {
    /*
     * Clear both the new key and any pre-migration entry so a stale
     * dev profile does not pollute the run. The hook no longer reads
     * the legacy key, but clearing it keeps the test environment
     * deterministic across machines.
     */
    await page.addInitScript((keys) => {
      try {
        for (const key of keys) {
          window.localStorage.removeItem(key);
        }
      } catch {
        /* ignore */
      }
    }, [STORAGE_KEY, 'lag-pinned-plans']);
  });

  /*
   * Skip until PinButton + PinnedPlansRow are wired into PlansView /
   * PlanCard. The components shipped in PR #312 (with this spec) but
   * the integration step was deferred to a follow-up draft pass, so
   * `data-plan-atom-id` (or `data-atom-id`) is set on the card but
   * the per-card Pin button is not yet rendered. Until the
   * integration lands, the spec asserts a contract that does not
   * exist; skip rather than burn a CI slot on a known-deferred
   * feature.
   *
   * Re-enable by removing this skip after the wire-up PR lands.
   */
  test.skip('pin, persist across reload, then unpin', async ({ page }) => {
    await page.goto('/plans');

    const pinnedRow = page.getByTestId('pinned-plans-row');
    await expect(pinnedRow).toHaveCount(0);

    /*
     * Show all bucket states so the test is not dependent on the
     * default `active` filter leaving a plan-card visible. PlansView
     * persists the filter to localStorage; setting it explicitly +
     * reloading is the same mechanic as clicking the chip but without
     * the chip-click race.
     */
    await page.evaluate(() => {
      localStorage.setItem('lag-console.plans-filter-bucket', JSON.stringify('all'));
    });
    await page.reload();

    const firstCard = page.getByTestId('plan-card').first();
    await firstCard.waitFor({ timeout: 10_000 });
    /*
     * The PlansView card emits `data-atom-id` (the canonical AnyAtom
     * id attribute), not `data-plan-atom-id`. Read the right
     * attribute so the rest of the persistence assertion runs.
     */
    const planId = await firstCard.getAttribute('data-atom-id');
    expect(planId).toBeTruthy();

    const pinButton = firstCard.getByRole('button', { name: /^Pin plan / });
    await pinButton.click();

    await expect(page.getByTestId('pinned-plans-row')).toBeVisible();
    const pinnedCard = page
      .getByTestId('pinned-plans-grid')
      .locator(`[data-pinned-card-id="${planId}"]`);
    await expect(pinnedCard).toBeVisible();
    await expect(
      pinnedCard.getByRole('button', { name: new RegExp(`^Unpin plan `) }),
    ).toHaveAttribute('aria-pressed', 'true');

    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    expect(stored && JSON.parse(stored)).toContain(planId);

    await page.reload();
    await expect(
      page
        .getByTestId('pinned-plans-grid')
        .locator(`[data-pinned-card-id="${planId}"]`),
    ).toBeVisible();

    const unpinButton = page
      .getByTestId('pinned-plans-grid')
      .locator(`[data-pinned-card-id="${planId}"]`)
      .getByRole('button', { name: /^Unpin plan / });
    await unpinButton.click();

    await expect(page.getByTestId('pinned-plans-row')).toHaveCount(0);

    const storedAfter = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    const parsed = storedAfter ? JSON.parse(storedAfter) : [];
    expect(parsed).not.toContain(planId);
  });
});
