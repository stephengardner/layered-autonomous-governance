import { test, expect } from '@playwright/test';

/**
 * Plan Lifecycle e2e: a single plan's autonomous-loop chain rendered
 * as a vertical timeline.
 *
 * Coverage:
 *   - List view loads with plan rows + the new sidebar tab is active.
 *   - Clicking a plan navigates to /plan-lifecycle/<id> and renders
 *     the timeline.
 *   - The timeline includes every state transition the backend
 *     observed (intent, plan, approval, dispatch, observation,
 *     settled — at least the merged plans we have show all six).
 *   - Each transition shows an atom-id link and an ISO-parseable
 *     timestamp.
 *
 * The test relies on at least one merged plan existing in
 * .lag/atoms/. The `plan-ship-docs-actors-six-page-set-as-one-...`
 * plan from PR #180 is the canonical fixture; it has the full chain
 * (intent → plan → approval → dispatch → observation → settled).
 */

test.describe('plan lifecycle', () => {
  test('list view renders plans with the new sidebar tab', async ({ page }) => {
    await page.goto('/plan-lifecycle');
    await expect(page.getByRole('heading', { name: 'Plan Lifecycle' }).first()).toBeVisible({
      timeout: 10_000,
    });
    const active = page.getByTestId('nav-plan-lifecycle');
    await expect(active).toHaveAttribute('aria-current', 'page');
    // At least one plan row should appear.
    await expect(page.locator('[data-testid="plan-lifecycle-row"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('clicking a plan opens the timeline and renders all transitions', async ({ page }) => {
    await page.goto('/plan-lifecycle');
    const firstRow = page.locator('[data-testid="plan-lifecycle-row"]').first();
    await firstRow.waitFor({ state: 'visible', timeout: 10_000 });
    const planId = await firstRow.getAttribute('data-plan-id');
    expect(planId, 'first plan row should carry a plan id').toBeTruthy();

    await firstRow.click();

    const escaped = encodeURIComponent(planId!).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(page).toHaveURL(new RegExp(`/plan-lifecycle/${escaped}$`));

    // Timeline container appears.
    const timeline = page.getByTestId('plan-lifecycle-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // At least one transition is rendered.
    const transitions = page.locator('[data-testid="plan-lifecycle-transition"]');
    const count = await transitions.count();
    expect(count, 'plan lifecycle should have at least one transition').toBeGreaterThan(0);

    // Every transition has an atom-id link with a non-empty data-atom-id.
    const atomLinks = page.locator('[data-testid="plan-lifecycle-transition-atom"]');
    const linkCount = await atomLinks.count();
    expect(linkCount).toBeGreaterThan(0);
    for (let i = 0; i < linkCount; i++) {
      const link = atomLinks.nth(i);
      const atomId = await link.getAttribute('data-atom-id');
      expect(atomId, `transition ${i} should expose an atom id`).toBeTruthy();
      // Also assert the link has visible text content.
      const text = (await link.textContent())?.trim() ?? '';
      expect(text.length, `transition ${i} should render the atom id`).toBeGreaterThan(0);
    }

    // Every <time> element inside the timeline parses as a valid ISO date.
    const times = timeline.locator('time');
    const timesCount = await times.count();
    expect(timesCount).toBeGreaterThan(0);
    for (let i = 0; i < timesCount; i++) {
      const dt = await times.nth(i).getAttribute('datetime');
      expect(dt, `time element ${i} should expose a datetime attribute`).toBeTruthy();
      expect(Number.isNaN(Date.parse(dt!)), `time ${i} should be a valid ISO`).toBe(false);
    }
  });

  test('plan-state-lifecycle stepper renders four steps with status attributes', async ({ page }) => {
    /*
     * Asserts the focused four-step plan_state stepper (proposed ->
     * approved -> executing -> terminal) renders for any plan opened
     * from the list, with correctly attributed status and kind data
     * on every row. This is the e2e contract that closes the loop on
     * the unit-tested projection -- we don't assert which steps are
     * reached vs pending here (depends on the fixture plan), only
     * that the substrate-shape is honoured: four rows, each carries
     * data-step-kind in the canonical set, each carries a status from
     * the canonical set.
     */
    await page.goto('/plan-lifecycle');
    const firstRow = page.locator('[data-testid="plan-lifecycle-row"]').first();
    await firstRow.waitFor({ state: 'visible', timeout: 10_000 });
    await firstRow.click();

    const stepper = page.getByTestId('plan-state-lifecycle');
    await expect(stepper).toBeVisible({ timeout: 10_000 });

    const steps = page.locator('[data-testid="plan-state-lifecycle-step"]');
    await expect(steps).toHaveCount(4);

    const expectedKinds = ['proposed', 'approved', 'executing', 'terminal'];
    const allowedStatuses = new Set(['reached', 'pending', 'skipped']);

    for (let i = 0; i < 4; i++) {
      const step = steps.nth(i);
      const kind = await step.getAttribute('data-step-kind');
      expect(kind, `step ${i} should expose its kind`).toBe(expectedKinds[i]);
      const status = await step.getAttribute('data-step-status');
      expect(status, `step ${i} should expose a recognized status`).toBeTruthy();
      expect(
        allowedStatuses.has(status!),
        `step ${i} status='${status}' should be in {reached,pending,skipped}`,
      ).toBe(true);
    }

    // Proposed always reaches because the atom existing IS the
    // proposed transition; pin that contract here so a regression
    // surfaces with a clear failure rather than as a silently wrong
    // step status downstream.
    const proposed = steps.nth(0);
    await expect(proposed).toHaveAttribute('data-step-status', 'reached');
  });

  test('focused timeline lists every chain phase for a merged plan', async ({ page, request }) => {
    /*
     * Pick a merged-plan fixture dynamically rather than pinning a
     * specific atom id. The previous version baked in a slug from
     * this org's topology (`cod-cto-actor`) and a specific historical
     * PR, which made the test brittle to atom-store rotation and
     * unrunnable for any consumer with different fixtures. The
     * autonomous-loop chain is invariant — operator-intent → plan
     * → approval → dispatch → observation → settled — so we discover
     * any plan that reached `succeeded` and assert the chain shape
     * against it. If no such plan exists, skip with a clear reason
     * (this test asserts a property of completed lifecycles; it
     * cannot be exercised against an empty store).
     */
    const plansResponse = await request.post('/api/plans.list');
    expect(plansResponse.ok(), 'plans.list endpoint should return 200').toBe(true);
    const plansBody = await plansResponse.json();
    const plans: ReadonlyArray<{ id: string; plan_state?: string }> =
      plansBody?.data ?? plansBody ?? [];
    const merged = plans.find((p) => p.plan_state === 'succeeded');
    test.skip(
      !merged,
      'no merged plan in atom store; this test requires a completed lifecycle to assert against',
    );
    const planId = merged!.id;
    await page.goto(`/plan-lifecycle/${planId}`);

    const timeline = page.getByTestId('plan-lifecycle-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // Each of the five visible phase markers should produce at least
    // one transition for a fully-settled plan. (`settled` itself maps
    // to `merge` when pr_state === 'MERGED', so we test for `merge`.)
    const expectedPhases = ['deliberation', 'approval', 'dispatch', 'observation', 'merge'];
    for (const phase of expectedPhases) {
      const found = page.locator(`[data-testid="plan-lifecycle-transition"][data-phase="${phase}"]`);
      const count = await found.count();
      expect(count, `expected at least one '${phase}' transition`).toBeGreaterThan(0);
    }

    // Focus banner shows the plan id we navigated to.
    const banner = page.getByTestId('focus-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(planId);
  });
});
