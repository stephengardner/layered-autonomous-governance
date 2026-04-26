import { test, expect } from '@playwright/test';

/**
 * Plan-failure-detail e2e: when a plan halts with `plan_state ===
 * 'failed'`, the lifecycle view must surface the dispatcher's
 * `dispatch_result.message` (raw + parsed stage) so operators don't
 * have to grep `.lag/atoms/<plan>.json`.
 *
 * Discovers a failed plan dynamically via /api/plans.list — the same
 * pattern plan-lifecycle.spec.ts uses for merged plans. If no failed
 * plan exists in the atom store, skips with a clear reason; this is a
 * property test against an existing failure, not a synthetic fixture.
 */

test.describe('plan failure detail', () => {
  test('failed plan surfaces stage pill + message + hint slot', async ({ page, request }) => {
    const plansResponse = await request.post('/api/plans.list');
    expect(plansResponse.ok(), 'plans.list endpoint should return 200').toBe(true);
    const plansBody = await plansResponse.json();
    const plans: ReadonlyArray<{
      id: string;
      plan_state?: string;
      metadata?: { dispatch_result?: { kind?: string; message?: string } };
    }> = plansBody?.data ?? plansBody ?? [];

    /*
     * Pick the first plan whose plan_state is `failed` AND has a
     * dispatch_result envelope — both gates are required for the
     * backend to populate the `failure` block. Plans flagged failed
     * for some other reason (manual flip, drift) intentionally don't
     * render a FailureCard, and would falsely fail this assertion.
     */
    const failed = plans.find(
      (p) =>
        p.plan_state === 'failed' &&
        p.metadata?.dispatch_result?.kind === 'error' &&
        typeof p.metadata.dispatch_result.message === 'string',
    );
    test.skip(
      !failed,
      'no failed plan with dispatch_result in atom store; this test asserts a property of an existing halt',
    );
    const planId = failed!.id;

    await page.goto(`/plan-lifecycle/${planId}`);

    // The FailureCard appears.
    const card = page.getByTestId('plan-lifecycle-failure');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Stage pill: text always begins with "stage=" (the backend falls
    // back to "unknown" when the message doesn't carry a parseable
    // shape, so the prefix is the invariant).
    const stage = page.getByTestId('plan-lifecycle-failure-stage');
    await expect(stage).toBeVisible();
    const stageText = (await stage.textContent())?.trim() ?? '';
    expect(stageText.startsWith('stage='), `stage pill should begin with "stage=" (got: "${stageText}")`).toBe(true);
    expect(stageText.length, 'stage pill should not be just "stage="').toBeGreaterThan('stage='.length);

    // Preformatted message block carries the raw dispatch_result.message
    // contents (whitespace + multiline preserved).
    const message = page.getByTestId('plan-lifecycle-failure-message');
    await expect(message).toBeVisible();
    const messageText = (await message.textContent()) ?? '';
    expect(messageText.length, 'failure message should be non-empty').toBeGreaterThan(0);
    expect(messageText, 'failure message should match the raw dispatch_result').toContain(
      failed!.metadata!.dispatch_result!.message!,
    );

    // Hint slot is always present — either a heuristic suggestion
    // OR the explicit "no automated hint" sentinel. This guarantees
    // the operator never wonders if the slot was missed.
    const hint = page.getByTestId('plan-lifecycle-failure-hint');
    await expect(hint).toBeVisible();
    const hintText = (await hint.textContent())?.trim() ?? '';
    expect(hintText.length, 'hint slot should always render text').toBeGreaterThan(0);

    // Timeline still renders the `failure` phase node so the chain
    // narrative includes the halt point.
    const timeline = page.getByTestId('plan-lifecycle-timeline');
    await expect(timeline).toBeVisible();
    const failureNode = page.locator(
      '[data-testid="plan-lifecycle-transition"][data-phase="failure"]',
    );
    await expect(failureNode.first()).toBeVisible();
  });
});
