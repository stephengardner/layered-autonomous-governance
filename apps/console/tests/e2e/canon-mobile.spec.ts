import { test, expect } from '@playwright/test';
import { skipUnlessMobile, gotoFirstCanon } from './_lib/mobile';

/**
 * Mobile-first assertions for the canon-detail surface (/canon/<id>).
 *
 * Companion to plans-mobile.spec.ts (and principal-mobile.spec.ts via
 * PR #229): same canon discipline (`dev-web-mobile-first-required`),
 * different surface. The canon focus-mode renders one or more
 * CanonCards under a FocusBanner; on a 390px viewport the contract
 * is no horizontal scroll, 44 CSS-pixel tap targets on the controls
 * an operator touches, and a single-column flow.
 *
 * Helpers live in tests/e2e/_lib/mobile.ts (extracted at N=3 per
 * canon `dev-extract-at-n-equals-2`).
 */

test.describe('canon-detail mobile surface', () => {
  test('focus-mode renders FocusBanner + CanonCard in single column', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstCanon(page, request);

    await expect(page.getByTestId('focus-banner')).toBeVisible({ timeout: 10_000 });
    /*
     * The canon focus mode renders the focused atom plus optional
     * supersession-chain context, so >= 1 canon-card is the right
     * cardinality assertion. Wait on first-card visibility BEFORE
     * the cardinality assertion so render-race doesn't false-pass.
     */
    const cards = page.getByTestId('canon-card');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    expect(await cards.count(), 'canon focus mode must render at least one canon-card').toBeGreaterThanOrEqual(1);

    const banner = page.getByTestId('focus-banner');
    const firstCard = cards.first();
    const bannerBox = await banner.boundingBox();
    const cardBox = await firstCard.boundingBox();
    expect(bannerBox, 'focus-banner must be in the layout flow').not.toBeNull();
    expect(cardBox, 'canon-card must be in the layout flow').not.toBeNull();
    /*
     * Stacking assertion: card top edge must be at or below the
     * banner BOTTOM edge (banner.y + banner.height). A simple "card.y
     * > banner.y" allows overlapping cards to pass; the bottom-edge
     * comparison rules that out.
     */
    const bannerBottom = bannerBox!.y + bannerBox!.height;
    expect(cardBox!.y, 'canon-card top must be below focus-banner bottom').toBeGreaterThanOrEqual(bannerBottom);
    /*
     * Center-x equality between the FocusBanner and the first
     * CanonCard proves they share the column; a regression that
     * floats one panel into a side column at the same vertical band
     * would still pass any "below" check.
     */
    const centerX = (b: { x: number; width: number }) => Math.round(b.x + b.width / 2);
    expect(
      Math.abs(centerX(cardBox!) - centerX(bannerBox!)),
      'canon-card must share the focus-banner column on mobile',
    ).toBeLessThanOrEqual(2);
  });

  test('no horizontal scroll at mobile viewport width', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstCanon(page, request);
    await expect(page.getByTestId('canon-card').first()).toBeVisible({ timeout: 10_000 });

    /*
     * Canon prose contains long atom-id refs and code-fences; the
     * markdown components must wrap them. iPhone 13 is 390 CSS px;
     * any extra horizontal pixel violates canon
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

  test('Clear-focus button meets 44px tap-target minimum', async ({ page, request, viewport }) => {
    skipUnlessMobile(viewport);
    await gotoFirstCanon(page, request);
    await expect(page.getByTestId('focus-banner')).toBeVisible({ timeout: 10_000 });

    /*
     * Same FocusBanner component as the principals/plans surfaces;
     * the tap floor lives on the .clear class via
     * --size-touch-target-min. Re-asserting here lets a future
     * regression in the canon-only styling surface fail this spec
     * rather than silently slipping past the other mobile specs.
     */
    const clear = page.getByTestId('focus-clear');
    const box = await clear.boundingBox();
    expect(box, 'clear-focus button must be in the layout flow').not.toBeNull();
    expect(box!.width, `clear width=${box!.width} below 44px floor`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `clear height=${box!.height} below 44px floor`).toBeGreaterThanOrEqual(44);
  });
});
