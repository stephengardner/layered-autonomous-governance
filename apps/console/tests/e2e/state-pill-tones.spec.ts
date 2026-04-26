import { test, expect, type Page } from '@playwright/test';

/**
 * State-pill-tones e2e: every plan_state value the runtime can emit
 * must paint the pill in a deliberate semantic color, not the muted
 * gray that an unmapped fallback produces.
 *
 * Regression context: STATE_TONE in PlansView.tsx (and the mirror in
 * PlanLifecycleView.tsx) covered only proposed / draft / pending /
 * approved / rejected. The autonomous-loop reconciler emits four more
 * terminal-or-in-flight values - succeeded, failed, executing,
 * abandoned - and those rendered through the `?? 'var(--text-tertiary)'`
 * fallback as muted gray. Operators looking at the Plans view could
 * not visually distinguish a green-light terminal-positive (succeeded)
 * from a red-light terminal-negative (failed). This was a foundational
 * UX bug, not a nit.
 *
 * Coverage:
 *   - Discover the actual states present in the atom store via
 *     /api/plans.list (avoids brittle pinning of specific atom ids).
 *   - For each state class with a deliberate color, assert the pill's
 *     computed `color` is NOT the muted-gray (`--text-tertiary`)
 *     resolved value AND IS the resolved value of the expected token.
 *   - Run the same assertions on the Plans view and the Plan Lifecycle
 *     row view, since both surfaces share the STATE_TONE map.
 *   - Sanity assert via getComputedStyle on a known token element
 *     that the page's CSS custom properties resolve as expected
 *     (proves the test is reading the same color space the user sees).
 *
 * Why computed-style readback (not snapshot images): tones are tokenized
 * and theme-dependent. A pixel snapshot would lock the test to one
 * theme and fail any palette tweak. Reading getComputedStyle().color
 * from the live element compares the token resolution end-to-end while
 * staying theme-agnostic.
 */

interface PlanShape {
  readonly id: string;
  readonly plan_state?: string;
}

const SEMANTIC_FALLBACK = 'var(--text-tertiary)';

/*
 * Map test-state -> the CSS custom property the pill MUST resolve to.
 * Mirrors STATE_TONE in src/features/plans-viewer/PlansView.tsx and
 * src/features/plan-lifecycle-viewer/PlanLifecycleView.tsx. Updates here
 * must keep parity with both source files.
 *
 * `abandoned` and `draft` deliberately use --text-tertiary; their pill
 * IS gray on purpose, so we exclude them from the "must not be gray"
 * branch but still assert the color matches the explicit token.
 */
const EXPECTED_TONE: Record<string, { token: string; muted: boolean }> = {
  proposed: { token: '--accent', muted: false },
  draft: { token: '--text-tertiary', muted: true },
  pending: { token: '--status-warning', muted: false },
  approved: { token: '--status-success', muted: false },
  rejected: { token: '--status-danger', muted: false },
  executing: { token: '--status-info', muted: false },
  succeeded: { token: '--status-success', muted: false },
  failed: { token: '--status-danger', muted: false },
  abandoned: { token: '--text-tertiary', muted: true },
};

/**
 * Read the resolved RGB(A) string for a CSS custom property on the
 * page's root element. Uses an offscreen probe so we get the same
 * color-channel format the browser uses for `color:` (rgb / rgba),
 * which getComputedStyle() returns regardless of how the source CSS
 * spelled it (hex, hsl, var()).
 */
async function resolveToken(page: Page, token: string): Promise<string> {
  return await page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    document.body.appendChild(probe);
    const resolved = window.getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);
}

async function readPillColor(page: Page, selector: string): Promise<string> {
  return await page.locator(selector).first().evaluate((el) => {
    return window.getComputedStyle(el).color;
  });
}

test.describe('plan_state pill tones', () => {
  test('every state present in the store renders with its semantic token, not muted gray', async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/plans.list');
    expect(response.ok(), 'plans.list endpoint should return 200').toBe(true);
    const body = await response.json();
    const plans: ReadonlyArray<PlanShape> = body?.data ?? body ?? [];
    expect(plans.length, 'atom store must contain at least one plan').toBeGreaterThan(0);

    // Group present states by name so we can pick one representative
    // pill per state class.
    const presentStates = new Set<string>();
    for (const p of plans) {
      const s = p.plan_state ?? 'unknown';
      if (EXPECTED_TONE[s]) presentStates.add(s);
    }

    test.skip(
      presentStates.size === 0,
      'no plan_state values present in store match a known semantic mapping; cannot exercise tone correctness',
    );

    await page.goto('/plans');
    await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 10_000 });

    // Resolve the muted-gray reference once so we can assert "NOT this"
    // on the non-muted states.
    const mutedGray = await resolveToken(page, '--text-tertiary');
    expect(mutedGray, 'muted-gray token should resolve').toMatch(/rgb/);

    for (const state of presentStates) {
      const expected = EXPECTED_TONE[state]!;
      const expectedColor = await resolveToken(page, expected.token);

      const pillSelector = `[data-testid="plan-card-state"][data-plan-state="${state}"]`;
      const pillCount = await page.locator(pillSelector).count();
      expect(pillCount, `plans view should render at least one pill for state '${state}'`)
        .toBeGreaterThan(0);

      const pillColor = await readPillColor(page, pillSelector);
      expect(
        pillColor,
        `state '${state}' pill should resolve to ${expected.token}`,
      ).toBe(expectedColor);

      if (!expected.muted) {
        expect(
          pillColor,
          `state '${state}' pill must not render as muted gray (regression: STATE_TONE missing entry)`,
        ).not.toBe(mutedGray);
      }
    }
  });

  test('lifecycle row view paints the same semantic tones for the same states', async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/plans.list');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    const plans: ReadonlyArray<PlanShape> = body?.data ?? body ?? [];
    expect(plans.length).toBeGreaterThan(0);

    const presentStates = new Set<string>();
    for (const p of plans) {
      const s = p.plan_state ?? 'unknown';
      if (EXPECTED_TONE[s]) presentStates.add(s);
    }
    test.skip(presentStates.size === 0, 'no semantic states present');

    await page.goto('/plan-lifecycle');
    await expect(page.locator('[data-testid="plan-lifecycle-row"]').first()).toBeVisible({
      timeout: 10_000,
    });

    const mutedGray = await resolveToken(page, '--text-tertiary');

    for (const state of presentStates) {
      const expected = EXPECTED_TONE[state]!;
      const expectedColor = await resolveToken(page, expected.token);

      const pillSelector = `[data-testid="plan-lifecycle-row-state"][data-plan-state="${state}"]`;
      const pillCount = await page.locator(pillSelector).count();
      if (pillCount === 0) {
        // The state exists in the store but no row may have rendered
        // yet (e.g. truncated list). Skip this iteration rather than
        // fail; the plans-view test already covered tone correctness.
        continue;
      }

      const pillColor = await readPillColor(page, pillSelector);
      expect(
        pillColor,
        `lifecycle row for state '${state}' should resolve to ${expected.token}`,
      ).toBe(expectedColor);

      if (!expected.muted) {
        expect(pillColor, `lifecycle row '${state}' must not be muted gray`).not.toBe(mutedGray);
      }
    }
  });

  test('failed and succeeded states are visually distinct (the operator-flagged regression)', async ({
    page,
    request,
  }) => {
    /*
     * The exact regression the operator flagged: 'succeeded' and
     * 'failed' pills both rendered as muted gray because STATE_TONE
     * had no entry for either. After the fix they must resolve to
     * --status-success (green) and --status-danger (red) respectively,
     * and they must not collide with each other.
     *
     * Skip if neither state is present in the store; the test asserts
     * a property that requires an example to compare against.
     */
    const response = await request.post('/api/plans.list');
    const body = await response.json();
    const plans: ReadonlyArray<PlanShape> = body?.data ?? body ?? [];
    const hasSucceeded = plans.some((p) => p.plan_state === 'succeeded');
    const hasFailed = plans.some((p) => p.plan_state === 'failed');
    test.skip(
      !hasSucceeded && !hasFailed,
      'neither succeeded nor failed plans in store; cannot exercise the regression',
    );

    await page.goto('/plans');
    await expect(page.getByTestId('plan-card').first()).toBeVisible({ timeout: 10_000 });

    const successColor = await resolveToken(page, '--status-success');
    const dangerColor = await resolveToken(page, '--status-danger');
    expect(successColor, 'success token should resolve').not.toBe(dangerColor);

    if (hasSucceeded) {
      const pill = page
        .locator('[data-testid="plan-card-state"][data-plan-state="succeeded"]')
        .first();
      await expect(pill).toBeVisible();
      const c = await pill.evaluate((el) => window.getComputedStyle(el).color);
      expect(c, 'succeeded pill must paint --status-success').toBe(successColor);
    }
    if (hasFailed) {
      const pill = page
        .locator('[data-testid="plan-card-state"][data-plan-state="failed"]')
        .first();
      await expect(pill).toBeVisible();
      const c = await pill.evaluate((el) => window.getComputedStyle(el).color);
      expect(c, 'failed pill must paint --status-danger').toBe(dangerColor);
    }
  });
});
