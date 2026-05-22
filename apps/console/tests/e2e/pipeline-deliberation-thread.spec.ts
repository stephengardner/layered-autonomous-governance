import { test, expect, type Page } from '@playwright/test';

/**
 * Pipeline cross-stage deliberation thread spec.
 *
 * The substrate's planning-pipeline runner emits one
 * `pipeline-cross-stage-reprompt` atom per cross-stage re-prompt event.
 * The Console renders these as a chain (FROM_STAGE -> TO_STAGE handoffs)
 * via `PipelineDeliberationThread` on /pipelines/<id>.
 *
 * The substrate atom is dormant unless `pol-cross-stage-reprompt-default`
 * is seeded, so the assertions here drive the rendering against
 * stub responses on /api/pipeline.deliberation so the spec stays
 * deterministic regardless of the dev machine's atom store.
 *
 * Runs in both desktop AND mobile projects per canon
 * `dev-mobile-first-no-horizontal-scroll-on-mobile`.
 */

const FIXTURE_PIPELINE_ID = 'pipeline-fixture-deliberation-pr5';

interface DeliberationEntryFixture {
  readonly atom_id: string;
  readonly pipeline_id: string;
  readonly correlation_id: string;
  readonly from_stage: string;
  readonly to_stage: string;
  readonly attempt: number;
  readonly thread_parent: string | null;
  readonly verified_cited_atom_ids_origin: string;
  readonly finding: {
    readonly severity: 'critical' | 'major' | 'minor';
    readonly category: string;
    readonly message: string;
    readonly cited_atom_ids: ReadonlyArray<string>;
    readonly cited_paths: ReadonlyArray<string>;
    readonly reprompt_target: string;
  };
  readonly principal_id: string;
  readonly created_at: string;
}

interface DeliberationResultFixture {
  readonly pipeline_id: string;
  readonly entries: ReadonlyArray<DeliberationEntryFixture>;
  readonly computed_at: string;
}

function buildEntry(
  overrides: Partial<DeliberationEntryFixture> & { atom_id: string },
): DeliberationEntryFixture {
  return {
    atom_id: overrides.atom_id,
    pipeline_id: FIXTURE_PIPELINE_ID,
    correlation_id: 'corr-fixture',
    from_stage: 'dispatch-stage',
    to_stage: 'plan-stage',
    attempt: 1,
    thread_parent: null,
    verified_cited_atom_ids_origin: 'pipeline-seed',
    finding: {
      severity: 'critical',
      category: 'drafter-refused',
      message:
        'Drafter refused to open PR: target file lacks the section the plan promised.',
      cited_atom_ids: ['plan-cited-1', 'plan-cited-2'],
      cited_paths: ['design/foo.md'],
      reprompt_target: 'plan-stage',
    },
    principal_id: 'cto-actor',
    created_at: '2026-05-21T11:50:00.000Z',
    ...overrides,
  };
}

function buildDeliberationFixture(
  entries: ReadonlyArray<DeliberationEntryFixture>,
): DeliberationResultFixture {
  return {
    pipeline_id: FIXTURE_PIPELINE_ID,
    entries,
    computed_at: '2026-05-21T12:00:00.000Z',
  };
}

function buildPipelineDetailFixture() {
  // Minimal fixture for /api/pipelines.detail so the parent
  // PipelineDetailView renders without 404. The deliberation thread
  // mounts under the stages section regardless of pipeline state.
  return {
    pipeline: {
      id: FIXTURE_PIPELINE_ID,
      pipeline_state: 'running',
      mode: 'substrate-deep',
      principal_id: 'cto-actor',
      correlation_id: 'corr-fixture',
      title: 'Fixture pipeline for deliberation thread assertions',
      content: 'fixture content',
      seed_atom_ids: ['atom-seed-1'],
      stage_policy_atom_id: null,
      started_at: '2026-05-21T11:00:00.000Z',
      completed_at: null,
    },
    stages: [
      {
        stage_name: 'plan-stage',
        state: 'succeeded' as const,
        index: 0,
        duration_ms: 1000,
        cost_usd: 0.01,
        last_event_at: '2026-05-21T11:30:00.000Z',
        output_atom_id: null,
      },
      {
        stage_name: 'dispatch-stage',
        state: 'running' as const,
        index: 1,
        duration_ms: 500,
        cost_usd: 0.005,
        last_event_at: '2026-05-21T11:45:00.000Z',
        output_atom_id: null,
      },
    ],
    events: [],
    findings: [],
    audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
    failure: null,
    resumes: [],
    agent_turns: [],
    total_cost_usd: 0.015,
    total_duration_ms: 1500,
    current_stage_name: 'dispatch-stage',
    current_stage_index: 1,
    total_stages: 2,
    last_event_at: '2026-05-21T11:45:00.000Z',
    dispatch_summary: null,
  };
}

async function mockRoutes(
  page: Page,
  deliberation: DeliberationResultFixture | null,
): Promise<void> {
  // Stub the pipeline detail endpoint so the parent view renders.
  await page.route('**/api/pipelines.detail', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: buildPipelineDetailFixture() }),
    });
  });
  // Stub the lifecycle endpoint so the post-dispatch section renders
  // its empty placeholder without trying to resolve real atoms.
  await page.route('**/api/pipelines.lifecycle', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          dispatch_record: null,
          plan_id: null,
          code_author_invocation: null,
          observation: null,
          merge: null,
        },
      }),
    });
  });
  await page.route('**/api/pipeline.intent-outcome', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'pipeline-not-found', message: 'fixture' },
      }),
    });
  });
  await page.route('**/api/pipeline.error-state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { state: 'ok' },
      }),
    });
  });
  // Canon search resolves empty so AtomRef hover-cards do not 404.
  await page.route('**/api/canon.list*', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('search')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: [] }),
      });
      return;
    }
    await route.continue();
  });
  // The deliberation endpoint itself.
  await page.route('**/api/pipeline.deliberation', async (route) => {
    if (deliberation === null) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: buildDeliberationFixture([]),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: deliberation }),
    });
  });
}

test.describe('pipeline deliberation thread', () => {
  test('renders the thread with seeded cross-stage atoms', async ({ page }) => {
    const entries = [
      buildEntry({
        atom_id: 'pipeline-cross-stage-reprompt-corr-fixture-dispatch-stage-plan-stage-attempt-1-corr-fixture',
        attempt: 1,
        thread_parent: null,
        from_stage: 'dispatch-stage',
        to_stage: 'plan-stage',
        verified_cited_atom_ids_origin: 'pipeline-seed',
        finding: {
          severity: 'critical',
          category: 'drafter-refused',
          message:
            'Drafter refused to open PR: target file lacks the section the plan promised.',
          cited_atom_ids: ['plan-cited-1', 'plan-cited-2'],
          cited_paths: ['design/foo.md', 'docs/bar.md'],
          reprompt_target: 'plan-stage',
        },
        created_at: '2026-05-21T11:50:00.000Z',
      }),
      buildEntry({
        atom_id: 'pipeline-cross-stage-reprompt-corr-fixture-dispatch-stage-plan-stage-attempt-2-corr-fixture',
        attempt: 2,
        thread_parent: 'pipeline-cross-stage-reprompt-corr-fixture-dispatch-stage-plan-stage-attempt-1-corr-fixture',
        from_stage: 'dispatch-stage',
        to_stage: 'plan-stage',
        verified_cited_atom_ids_origin: 'latest-upstream',
        finding: {
          severity: 'major',
          category: 'drafter-refused',
          message:
            'Drafter refused again: new plan still missing the section.',
          cited_atom_ids: ['plan-cited-3'],
          cited_paths: [],
          reprompt_target: 'plan-stage',
        },
        created_at: '2026-05-21T11:55:00.000Z',
      }),
    ];

    await mockRoutes(page, buildDeliberationFixture(entries));
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);

    // Parent detail view renders.
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({
      timeout: 10_000,
    });

    // Thread surface is populated.
    const thread = page.getByTestId('pipeline-deliberation-thread');
    await expect(thread).toBeVisible({ timeout: 10_000 });
    await expect(thread).toHaveAttribute('data-state', 'populated');
    await expect(
      page.getByTestId('pipeline-deliberation-count'),
    ).toHaveText('2');

    // Two entries in the thread.
    const entryRows = page.getByTestId('pipeline-deliberation-entry');
    await expect(entryRows).toHaveCount(2);

    // First entry: attempt 1, head of thread, severity=critical, FROM=dispatch-stage, TO=plan-stage.
    const first = entryRows.first();
    await expect(first).toHaveAttribute('data-attempt', '1');
    await expect(first).toHaveAttribute('data-thread-head', 'true');
    await expect(first).toHaveAttribute('data-severity', 'critical');
    await expect(first).toHaveAttribute('data-from-stage', 'dispatch-stage');
    await expect(first).toHaveAttribute('data-to-stage', 'plan-stage');
    await expect(
      first.getByTestId('pipeline-deliberation-attempt'),
    ).toContainText('attempt 1');
    await expect(
      first.getByTestId('pipeline-deliberation-severity'),
    ).toContainText('critical');
    await expect(
      first.getByTestId('pipeline-deliberation-message'),
    ).toContainText('Drafter refused to open PR');
    await expect(
      first.getByTestId('pipeline-deliberation-citation-origin'),
    ).toContainText('pipeline-seed');
    // First entry has cited atoms + paths.
    await expect(
      first.getByTestId('pipeline-deliberation-cited-atoms'),
    ).toBeVisible();
    await expect(
      first.getByTestId('pipeline-deliberation-cited-paths'),
    ).toBeVisible();
    // No thread-parent block on the head.
    await expect(
      first.getByTestId('pipeline-deliberation-thread-parent'),
    ).toHaveCount(0);

    // Second entry: attempt 2, has thread-parent pointer, severity=major.
    const second = entryRows.nth(1);
    await expect(second).toHaveAttribute('data-attempt', '2');
    await expect(second).toHaveAttribute('data-thread-head', 'false');
    await expect(second).toHaveAttribute('data-severity', 'major');
    await expect(
      second.getByTestId('pipeline-deliberation-attempt'),
    ).toContainText('attempt 2');
    await expect(
      second.getByTestId('pipeline-deliberation-thread-parent'),
    ).toBeVisible();
    await expect(
      second.getByTestId('pipeline-deliberation-citation-origin'),
    ).toContainText('latest-upstream');
    // Second entry has cited atoms but no cited paths.
    await expect(
      second.getByTestId('pipeline-deliberation-cited-atoms'),
    ).toBeVisible();
    await expect(
      second.getByTestId('pipeline-deliberation-cited-paths'),
    ).toHaveCount(0);
  });

  test('renders nothing when zero cross-stage atoms', async ({ page }) => {
    await mockRoutes(page, buildDeliberationFixture([]));
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);

    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({
      timeout: 10_000,
    });
    // The thread surface MUST NOT mount: dormant state.
    await expect(page.getByTestId('pipeline-deliberation-thread')).toHaveCount(
      0,
    );
  });

  test('no horizontal scroll at any viewport width', async ({ page, viewport }) => {
    const entries = [
      buildEntry({
        atom_id: 'pipeline-cross-stage-reprompt-very-long-corr-fixture-attempt-1',
        finding: {
          severity: 'critical',
          category: 'drafter-refused-with-a-very-long-category-name-that-could-otherwise-overflow',
          message:
            'A very long finding message that needs to wrap cleanly on mobile widths so the layout does not introduce a horizontal scroll bar. The substrate caps these but the renderer still has to handle reasonable maximums without breaking the grid.',
          cited_atom_ids: [
            'plan-cited-with-a-very-long-id-that-could-otherwise-overflow-the-card',
          ],
          cited_paths: [
            'design/some/very/deep/nested/path/that/exceeds/typical/widths/and-needs-to-wrap.md',
          ],
          reprompt_target: 'plan-stage',
        },
      }),
    ];
    await mockRoutes(page, buildDeliberationFixture(entries));
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);
    await expect(page.getByTestId('pipeline-deliberation-thread')).toBeVisible({
      timeout: 10_000,
    });

    // No horizontal scroll at the current viewport width (canon
    // dev-mobile-first-no-horizontal-scroll-on-mobile + the desktop
    // bar). Mobile project is iPhone 13 (390px); desktop is the
    // chromium default. The assertion runs in both projects so a
    // regression on either width fails CI.
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
