import { test, expect } from '@playwright/test';

/**
 * Operator Control Panel e2e.
 *
 * Covers the contract the feature makes:
 *   1. /control route loads (sidebar link + direct URL).
 *   2. Hero card renders kill-switch state (engaged or not-engaged).
 *   3. Tier banner renders with one of soft|medium|hard.
 *   4. All four metric tiles render with non-empty values.
 *   5. The "Engage Kill Switch" button opens the confirmation
 *      dialog -- and the dialog presents the manual `touch` command,
 *      NOT a button that writes the sentinel.
 *
 * Per canon `dev-web-playwright-coverage-required`, every feature
 * ships with at least one Playwright e2e. This spec is that minimum
 * for the Operator Control Panel.
 */

test.describe('operator control panel', () => {
  test('navigates to /control via sidebar and renders the panel', async ({ page }) => {
    await page.goto('/');
    /*
     * The control link is operator-critical, so we verify both that
     * the sidebar entry exists AND that clicking it routes to the
     * panel. data-testid="nav-control" is the sidebar item; the
     * panel itself surfaces via data-testid="control-panel".
     */
    const navControl = page.getByTestId('nav-control');
    await expect(navControl).toBeVisible();
    await navControl.click();
    await expect(page).toHaveURL(/\/control$/);
    await expect(page.getByTestId('control-panel')).toBeVisible({ timeout: 10_000 });
  });

  test('hero card surfaces the kill-switch state', async ({ page }) => {
    await page.goto('/control');
    const hero = page.getByTestId('control-kill-switch');
    await expect(hero).toBeVisible({ timeout: 10_000 });
    /*
     * The fixture .lag/STOP file may or may not be present; both
     * states are valid. We assert the title is one of the two known
     * copy variants and that the data-engaged attribute is a
     * boolean string ("true" or "false").
     */
    const titleText = (await page.getByTestId('control-kill-switch-title').innerText()).trim();
    expect(['Engaged', 'Not engaged']).toContain(titleText);
    const engagedAttr = await hero.getAttribute('data-engaged');
    expect(['true', 'false']).toContain(engagedAttr);
  });

  test('tier banner renders one of the three known autonomy tiers', async ({ page }) => {
    await page.goto('/control');
    const banner = page.getByTestId('control-tier-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    const tier = await banner.getAttribute('data-tier');
    expect(['soft', 'medium', 'hard']).toContain(tier);
    /*
     * Tier badge mirrors the data-tier; confirm at least one of the
     * three known badges is visible (the active one) so the operator-
     * facing copy stays in sync with the data attribute.
     */
    const activeBadge = page.getByTestId(`control-tier-${tier}`);
    await expect(activeBadge).toBeVisible();
  });

  test('all four metric tiles render with non-empty values', async ({ page }) => {
    await page.goto('/control');
    await page.getByTestId('control-metrics').waitFor({ timeout: 10_000 });
    const ids = [
      'control-metric-actors',
      'control-metric-policies',
      'control-metric-canon',
      'control-metric-operator',
    ];
    for (const id of ids) {
      const tile = page.getByTestId(id);
      await expect(tile).toBeVisible();
      const valueText = (await page.getByTestId(`${id}-value`).innerText()).trim();
      expect(valueText.length).toBeGreaterThan(0);
    }
    /*
     * Sanity check: the actors metric should be a non-negative integer
     * in the dogfooded fixture (we always have at least one governed
     * actor). This catches a broken handler that returns "" or "NaN".
     */
    const actorsValue = (await page.getByTestId('control-metric-actors-value').innerText()).trim();
    expect(actorsValue).toMatch(/^\d+$/);
  });

  test('engage button opens the confirmation dialog with the manual touch command', async ({ page }) => {
    await page.goto('/control');
    const engageButton = page.getByTestId('control-engage-button');
    await expect(engageButton).toBeVisible({ timeout: 10_000 });
    /*
     * Skip the rest of the assertions when the kill switch is already
     * engaged in the fixture -- the button is disabled by design in
     * that state (the dialog gives no new affordance), and clicking
     * a disabled button is a no-op. This keeps the test green
     * regardless of fixture sentinel state.
     */
    if (await engageButton.isDisabled()) {
      return;
    }
    await engageButton.click();
    const dialog = page.getByTestId('control-engage-dialog');
    await expect(dialog).toBeVisible();
    /*
     * The dialog MUST present a manual `touch .lag/STOP` command and
     * MUST NOT offer a UI "really engage" button that writes the
     * sentinel. This is the read-only contract.
     */
    const command = page.getByTestId('control-engage-command');
    await expect(command).toBeVisible();
    const commandText = (await command.innerText()).trim();
    expect(commandText).toContain('touch');
    expect(commandText).toContain('.lag/STOP');
    /*
     * Negative assertion: there is exactly one button in the dialog
     * (Close). A "Confirm engage" or similar would violate the v1
     * read-only contract.
     */
    const dialogButtons = dialog.locator('button');
    await expect(dialogButtons).toHaveCount(1);
    await page.getByTestId('control-engage-dialog-close').click();
    await expect(dialog).toBeHidden();
  });
});
