import { test, expect } from '@playwright/test';

/**
 * Plans-view bucket-filter e2e.
 *
 * Operator concern: a flat masonry grid of all plan_states drowned the
 * useful surface in failed/stale-proposed atoms, which read as "the
 * system is broken." The fix is a chip filter under StatsHeader that
 * defaults to a clean Active surface, with explicit chips for the
 * closed buckets so anything filtered remains one click away.
 *
 * What this test asserts:
 *   1. The four chips render with counts.
 *   2. The Active chip is the default selected state on a fresh load.
 *   3. Clicking Failed swaps the rendered grid to failed-only plans
 *      and persists the choice (the chip stays selected after
 *      reload).
 *   4. Clicking All shows every plan again.
 *   5. When a focused plan-id is in the URL, the filter is bypassed
 *      so the operator never lands on a "Plan not found" surface
 *      because of bucket mismatch.
 *
 * Discovery is dynamic against /api/plans.list — we read the actual
 * atom set so the test is meaningful against whatever data the
 * backend has, and skips with a clear reason if the dataset can't
 * exercise the assertion.
 */

interface PlanRow {
  readonly id: string;
  readonly plan_state?: string | null;
}

const ACTIVE_STATES = new Set(['proposed', 'approved', 'executing', 'draft', 'pending']);
const FAILED_STATES = new Set(['failed', 'abandoned', 'rejected']);

function bucketFor(state: string | null | undefined): 'active' | 'succeeded' | 'failed' {
  if (typeof state !== 'string' || state.length === 0) return 'active';
  if (state === 'succeeded') return 'succeeded';
  if (FAILED_STATES.has(state)) return 'failed';
  if (ACTIVE_STATES.has(state)) return 'active';
  return 'active';
}

test.describe('plans bucket filter', () => {
  test('default Active hides failed/succeeded; switching chips re-renders + persists', async ({
    page,
    request,
  }) => {
    const plansResponse = await request.post('/api/plans.list');
    expect(plansResponse.ok(), 'plans.list endpoint should return 200').toBe(true);
    const plansBody = await plansResponse.json();
    const plans: ReadonlyArray<PlanRow> = plansBody?.data ?? plansBody ?? [];

    const counts = { active: 0, succeeded: 0, failed: 0, all: plans.length };
    for (const p of plans) counts[bucketFor(p.plan_state)] += 1;

    test.skip(
      counts.active === 0 && counts.succeeded === 0 && counts.failed === 0,
      'no plan atoms in store; nothing for the filter to operate on',
    );

    /*
     * Clear any persisted filter so the test starts from a true
     * fresh-load. localStorage outlives reloads and would otherwise
     * leak state from a prior dev session.
     */
    await page.goto('/plans');
    await page.evaluate(() => localStorage.removeItem('lag-console.plans-filter-bucket'));
    await page.reload();

    const chips = page.getByTestId('plans-filter-chips');
    await expect(chips).toBeVisible({ timeout: 10_000 });

    const activeChip = page.getByTestId('plans-filter-chip-active');
    const succeededChip = page.getByTestId('plans-filter-chip-succeeded');
    const failedChip = page.getByTestId('plans-filter-chip-failed');
    const allChip = page.getByTestId('plans-filter-chip-all');

    // All four chips render and carry the right counts.
    await expect(activeChip).toContainText(String(counts.active));
    await expect(succeededChip).toContainText(String(counts.succeeded));
    await expect(failedChip).toContainText(String(counts.failed));
    await expect(allChip).toContainText(String(counts.all));

    // Active is the default selected chip on a fresh load.
    await expect(activeChip).toHaveAttribute('aria-pressed', 'true');
    await expect(failedChip).toHaveAttribute('aria-pressed', 'false');

    /*
     * Card-count assertion uses a closeTo-style range because the
     * masonry distributes by index parity into two stacks; the total
     * cards rendered equals the bucket count in steady state.
     * Skip-guard: only run the assertion when the bucket has > 0
     * plans (otherwise we land on the EmptyState branch instead of
     * the grid, and getByTestId('plan-card') returns 0 by design).
     */
    if (counts.active > 0) {
      await expect(page.getByTestId('plan-card')).toHaveCount(counts.active);
    }

    /*
     * Click Failed. The chip becomes selected; the rendered grid
     * holds exactly the failed bucket count. If failed === 0 we get
     * the filter-empty state instead of zero cards.
     */
    await failedChip.click();
    await expect(failedChip).toHaveAttribute('aria-pressed', 'true');
    await expect(activeChip).toHaveAttribute('aria-pressed', 'false');

    if (counts.failed > 0) {
      await expect(page.getByTestId('plan-card')).toHaveCount(counts.failed);
    } else {
      await expect(page.getByTestId('plans-filter-empty')).toBeVisible();
    }

    // The choice persists across reload (localStorage round-trip).
    await page.reload();
    await expect(page.getByTestId('plans-filter-chip-failed')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // All shows everything.
    await page.getByTestId('plans-filter-chip-all').click();
    await expect(page.getByTestId('plans-filter-chip-all')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (counts.all > 0) {
      await expect(page.getByTestId('plan-card')).toHaveCount(counts.all);
    }
  });

  test('focus mode bypasses the filter so deep-link to a failed plan still loads', async ({
    page,
    request,
  }) => {
    const plansResponse = await request.post('/api/plans.list');
    const plansBody = await plansResponse.json();
    const plans: ReadonlyArray<PlanRow> = plansBody?.data ?? plansBody ?? [];

    /*
     * Pick a failed plan (or any non-active one). With the default
     * Active filter, navigating directly to /plans/<id> on this plan
     * should still render the card, not "Plan not found."
     */
    const target = plans.find((p) => bucketFor(p.plan_state) !== 'active');
    test.skip(
      !target,
      'no closed-bucket plan in atom store; cannot verify focus-mode bypass',
    );

    await page.goto('/plans');
    await page.evaluate(() => localStorage.removeItem('lag-console.plans-filter-bucket'));

    await page.goto(`/plans/${target!.id}`);
    const card = page.getByTestId('plan-card').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute('data-atom-id', target!.id);

    // Filter chips do NOT render in focus mode (one plan, no need to filter).
    await expect(page.getByTestId('plans-filter-chips')).toHaveCount(0);
  });
});
