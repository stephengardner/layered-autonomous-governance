import { test, expect, type Page } from '@playwright/test';

/**
 * Timeline view smoke spec.
 *
 * Closes the 2026-05-30 audit gap: the /timeline route ships a
 * principal-chain temporal view (TimelineView) but had no dedicated
 * e2e covering it. The view is a projection over the canon + activity
 * + principal atom sets, so it works against the substrate's real atom
 * store without any seed fixture.
 *
 * Coverage:
 *   - /timeline loads and exits the loading state
 *   - at least one principal row renders (the substrate always has at
 *     least the operator principal)
 *   - mobile viewport renders without horizontal scroll
 */

async function loadTimelineView(page: Page): Promise<void> {
  await page.goto('/timeline');
  // The view emits a `timeline-loading` testid while data fetches.
  // After load, the row container holds at least one principal row.
  await expect.poll(
    () => page.locator('[data-testid="timeline-row"]').count(),
    { timeout: 15_000, intervals: [200, 500] },
  ).toBeGreaterThanOrEqual(1);
}

test.describe('timeline view', () => {
  test('loads and renders at least one principal row', async ({ page }) => {
    await loadTimelineView(page);
    // Sanity assertion after the helper's poll converged.
    const rows = await page.locator('[data-testid="timeline-row"]').count();
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  test('no horizontal scroll at the running viewport', async ({ page, viewport }) => {
    await loadTimelineView(page);

    /*
     * The timeline view itself is a wide horizontal canvas (atoms
     * positioned by created_at along the x-axis); horizontal scroll
     * INSIDE the grid is expected. What's NOT expected is the page
     * body overflowing the viewport. We assert the document-level
     * scrollWidth stays bounded to clientWidth.
     *
     * The +1 tolerance absorbs a single sub-pixel rounding step that
     * browser layout engines emit when the viewport width is an odd
     * value (e.g. 393 on iPhone 13). A legitimate 1px overflow would
     * still fail the parent app's design tokens (rem-multiple values
     * never produce exactly 1px overflow); the tolerance only relaxes
     * the pure pixel-rounding edge.
     */
    const docOverflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(
      docOverflow.scrollWidth,
      `width=${viewport?.width ?? 'unknown'} scrollWidth=${docOverflow.scrollWidth} clientWidth=${docOverflow.clientWidth}`,
    ).toBeLessThanOrEqual(docOverflow.clientWidth + 1);
  });
});
