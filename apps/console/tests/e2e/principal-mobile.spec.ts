import { test, expect, devices } from '@playwright/test';

/**
 * Mobile-first assertions for the principal-detail surface.
 *
 * The Playwright config already runs every spec under both desktop
 * and mobile projects (devices['iPhone 13']) per canon
 * `dev-web-mobile-first-required`. This spec adds the assertions
 * that are *specifically* about mobile behaviour: no horizontal
 * scroll at 390px, tap targets >= 44 CSS pixels on the controls
 * an operator actually touches (FocusBanner Clear, activity entry
 * buttons), and the focus-mode card stack reflows to a single
 * column.
 *
 * The assertions skip cleanly when the chromium project runs them
 * against a desktop viewport so the spec stays meaningful in the
 * mobile project without producing false negatives in the desktop
 * project. A test.describe.configure pattern would be cleaner once
 * Playwright exposes per-spec project filtering, but the runtime
 * width gate is correct today.
 */

const MOBILE_WIDTH = devices['iPhone 13'].viewport.width;

/*
 * Per canon `dev-extract-at-n-equals-2`: the mobile-only guard
 * appears in every assertion in this file, so it lives behind a
 * named helper. Adding a fifth mobile assertion stays a one-line
 * change instead of another copy of the inline expression.
 */
function skipUnlessMobile(viewport: { width: number } | null | undefined): void {
  test.skip((viewport?.width ?? 0) > MOBILE_WIDTH, 'mobile-only assertion');
}

test.describe('principal-detail mobile surface', () => {
  test.beforeEach(async ({ page }) => {
    /*
     * cto-actor is the canonical principal that ships with both a
     * SKILL.md and ample plan history. The mobile spec uses the same
     * fixture as the desktop principal-drilldown spec so the two
     * bodies of evidence stay aligned.
     */
    await page.goto('/principals/cto-actor');
    await expect(page.getByTestId('principal-card')).toBeVisible({ timeout: 10_000 });
  });

  test('renders FocusBanner + card + skill + activity panels in single column', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * Each panel must be present. The skill / activity panels each
     * have three states (loading / content / empty); the OR locator
     * accepts any non-error terminal state so a fresh-install fixture
     * (no skill md, no activity) doesn't false-fail the test.
     */
    await expect(page.getByTestId('focus-banner')).toBeVisible();
    await expect(page.getByTestId('principal-card')).toHaveCount(1);

    const skillContent = page.getByTestId('principal-skill-content');
    const skillEmpty = page.getByTestId('principal-skill-empty');
    await expect(skillContent.or(skillEmpty)).toBeVisible({ timeout: 10_000 });

    const activityContent = page.getByTestId('principal-activity-content');
    const activityEmpty = page.getByTestId('principal-activity-empty');
    await expect(activityContent.or(activityEmpty)).toBeVisible({ timeout: 15_000 });

    /*
     * Single-column assertion: at 390px the principal panels MUST
     * stack vertically AND share a column. We verify both: top-edge
     * ordering (card -> skill -> activity y values strictly increase)
     * proves vertical sequence, and center-x equality within ±2px
     * proves they share the same column rather than rendering as
     * separate columns that happen to be ordered top-to-bottom.
     * The card may render in any of the focus-mode load states, so
     * we resolve which of skill/activity surfaced (content vs empty)
     * before measuring.
     */
    const card = page.getByTestId('principal-card');
    const skill = (await skillContent.count()) > 0 ? skillContent : skillEmpty;
    const activity = (await activityContent.count()) > 0 ? activityContent : activityEmpty;
    const cardBox = await card.boundingBox();
    const skillBox = await skill.boundingBox();
    const activityBox = await activity.boundingBox();
    expect(cardBox, 'card must be in the layout flow').not.toBeNull();
    expect(skillBox, 'skill panel must be in the layout flow').not.toBeNull();
    expect(activityBox, 'activity panel must be in the layout flow').not.toBeNull();
    expect(skillBox!.y, 'skill panel must stack below card').toBeGreaterThan(cardBox!.y);
    expect(activityBox!.y, 'activity panel must stack below skill').toBeGreaterThan(skillBox!.y);
    /*
     * Center-x comparison defends against a regression where a panel
     * floats into a side-by-side column at the same vertical band as
     * its predecessor; the y-ordering test would still pass but the
     * single-column contract would silently break.
     */
    const centerX = (b: { x: number; width: number }) => Math.round(b.x + b.width / 2);
    const cardCx = centerX(cardBox!);
    expect(
      Math.abs(centerX(skillBox!) - cardCx),
      'skill panel must share the card column on mobile',
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(centerX(activityBox!) - cardCx),
      'activity panel must share the card column on mobile',
    ).toBeLessThanOrEqual(2);
  });

  test('no horizontal scroll at mobile viewport width', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * documentElement.scrollWidth > clientWidth is the canonical
     * "page overflows horizontally" signal. iPhone 13 viewport is
     * 390px; any extra horizontal pixel is a layout bug per canon
     * `dev-web-mobile-first-required` ("horizontal scroll on mobile
     * width <=400px is always a bug").
     */
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll, `page horizontally overflows: scroll=${overflow.scroll} client=${overflow.client}`)
      .toBeLessThanOrEqual(overflow.client);
  });

  test('Clear-focus button meets 44px tap-target minimum', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * FocusBanner exposes a clear-focus action; the operator taps it
     * to leave focus mode. A tap target smaller than 44x44 CSS px
     * fails Apple HIG and is a canon-bound gate per
     * `dev-web-mobile-first-required` ("touch targets meet a 44x44
     * CSS-pixel minimum").
     */
    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible();
    /*
     * The clear control has a stable test id (focus-clear) on the
     * FocusBanner button so we can locate it without depending on the
     * CSS-module-generated class name.
     */
    const clear = page.getByTestId('focus-clear');
    const box = await clear.boundingBox();
    expect(box, 'clear-focus button must be in the layout flow').not.toBeNull();
    expect(box!.width, `clear button width=${box!.width} below 44px tap floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `clear button height=${box!.height} below 44px tap floor`).toBeGreaterThanOrEqual(44);
  });

  test('activity-entry buttons (when present) meet 44px tap-target minimum', async ({ page, viewport }) => {
    skipUnlessMobile(viewport);

    /*
     * If the principal has activity, the feed renders clickable
     * entries. Each entry is the navigable surface to its atom; the
     * tap target must satisfy the 44px floor. When no entries exist
     * (fresh-install fixture), skip rather than false-fail.
     */
    const items = page.getByTestId('principal-activity-item');
    const count = await items.count();
    test.skip(count === 0, 'no activity entries to measure');

    const first = items.first();
    const box = await first.boundingBox();
    expect(box, 'first activity entry must be in the layout flow').not.toBeNull();
    expect(box!.width, `entry width=${box!.width} below 44px tap floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `entry height=${box!.height} below 44px tap floor`).toBeGreaterThanOrEqual(44);
  });
});
