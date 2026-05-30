import { test, expect, type Page } from '@playwright/test';

/**
 * Conversation Thread spec.
 *
 * Drives the /pipelines/<id>/conversation + /deliberation/<id>/conversation
 * surfaces against stubbed conversation endpoints so the assertions
 * stay deterministic regardless of the dev machine's atom store. Runs
 * in both desktop AND mobile projects per canon
 * dev-mobile-first-no-horizontal-scroll-on-mobile.
 *
 * Coverage:
 *   - chronological ordering (entries render in event-array order)
 *   - operator-intent + agent-prompt + agent-response + tool-call +
 *     handoff (stage transition) + dispatch-result all visible
 *   - tool-call args + result render after the operator opens the
 *     toggles
 *   - HandoffDivider draws FROM and TO stage chips between
 *     stage-started events
 *   - ExpandableBody "Show more" toggle reveals truncated content
 *   - link from the pipeline detail surface routes to the conversation
 *     subroute (URL changes + the conversation view mounts)
 *   - link from the deliberation detail surface routes the same way
 *   - no horizontal scroll at the running viewport
 */

const FIXTURE_PIPELINE_ID = 'pipeline-fixture-conversation';
const FIXTURE_PLAN_ID = 'plan-fixture-conversation';

// ----- Event fixture builders -----

type ConversationContentBody = { content: string; content_truncated: boolean };

function intentEvent(content: string, truncated = false) {
  return {
    kind: 'operator-intent' as const,
    atom_id: 'intent-fixture-conversation',
    ts: '2026-05-21T10:00:00.000Z',
    principal_id: 'apex-agent',
    body: { content, content_truncated: truncated },
  };
}

function stageStarted(stage: string, ts: string, suffix: string) {
  return {
    kind: 'stage-started' as const,
    atom_id: `pipeline-stage-event-fixture-${suffix}-enter`,
    ts,
    principal_id: 'cto-actor',
    stage,
  };
}

function agentPrompt(
  body: ConversationContentBody,
  opts: { stage: string; turn_index: number; session_atom_id: string; ts: string; suffix: string },
) {
  return {
    kind: 'agent-prompt' as const,
    atom_id: `agent-turn-fixture-${opts.suffix}-prompt`,
    ts: opts.ts,
    principal_id: 'cto-actor',
    stage: opts.stage,
    turn_index: opts.turn_index,
    session_atom_id: opts.session_atom_id,
    body,
  };
}

function agentResponse(
  body: ConversationContentBody,
  opts: { stage: string; turn_index: number; session_atom_id: string; ts: string; suffix: string; latency_ms: number },
) {
  return {
    kind: 'agent-response' as const,
    atom_id: `agent-turn-fixture-${opts.suffix}-response`,
    ts: opts.ts,
    principal_id: 'cto-actor',
    stage: opts.stage,
    turn_index: opts.turn_index,
    session_atom_id: opts.session_atom_id,
    body,
    latency_ms: opts.latency_ms,
  };
}

function toolCall(opts: {
  ts: string;
  suffix: string;
  stage: string;
  parent_turn_index: number;
  session_atom_id: string;
  tool_name: string;
  args: string;
  result: string;
  tool_call_index?: number;
}) {
  return {
    kind: 'tool-call' as const,
    atom_id: `agent-turn-fixture-${opts.suffix}-tool`,
    tool_call_index: opts.tool_call_index ?? 0,
    ts: opts.ts,
    principal_id: 'cto-actor',
    stage: opts.stage,
    parent_turn_index: opts.parent_turn_index,
    session_atom_id: opts.session_atom_id,
    tool_name: opts.tool_name,
    args: opts.args,
    args_truncated: false,
    result: opts.result,
    result_truncated: false,
  };
}

function dispatchResult(result: 'pr-opened' | 'silent-skip' | 'failed', summary: string, pr_url: string | null) {
  return {
    kind: 'dispatch-result' as const,
    atom_id: 'observation-fixture-conversation',
    ts: '2026-05-21T11:00:00.000Z',
    principal_id: 'code-author-invoker',
    result,
    pr_url,
    summary,
  };
}

function buildPipelineConversationFixture() {
  return {
    pipeline_id: FIXTURE_PIPELINE_ID,
    intent_id: 'intent-fixture-conversation',
    computed_at: '2026-05-21T12:00:00.000Z',
    events: [
      intentEvent('Append a marker to docs/x.md so the substrate validation pass closes.'),
      stageStarted('brainstorm-stage', '2026-05-21T10:00:10.000Z', 'brainstorm'),
      agentPrompt(
        { content: 'You are the brainstorm-stage planner.\nProduce alternatives.', content_truncated: false },
        { stage: 'brainstorm-stage', turn_index: 0, session_atom_id: 'agent-session-bs', ts: '2026-05-21T10:00:11.000Z', suffix: 'brainstorm' },
      ),
      agentResponse(
        // Long content so ExpandableBody collapses by default; we want
        // to see the "Show more" toggle.
        { content: longLines(40), content_truncated: true },
        { stage: 'brainstorm-stage', turn_index: 0, session_atom_id: 'agent-session-bs', ts: '2026-05-21T10:00:13.000Z', suffix: 'brainstorm', latency_ms: 2100 },
      ),
      toolCall({
        ts: '2026-05-21T10:00:14.000Z',
        suffix: 'brainstorm',
        stage: 'brainstorm-stage',
        parent_turn_index: 0,
        session_atom_id: 'agent-session-bs',
        tool_name: 'Read',
        args: '{"path":"docs/x.md"}',
        result: '# x\n\n<!-- markers -->\n',
      }),
      stageStarted('plan-stage', '2026-05-21T10:01:00.000Z', 'plan'),
      agentPrompt(
        { content: 'You are the plan-stage author. Produce a plan from the brainstorm output.', content_truncated: false },
        { stage: 'plan-stage', turn_index: 0, session_atom_id: 'agent-session-plan', ts: '2026-05-21T10:01:01.000Z', suffix: 'plan' },
      ),
      agentResponse(
        { content: 'Plan: append the marker. Done.', content_truncated: false },
        { stage: 'plan-stage', turn_index: 0, session_atom_id: 'agent-session-plan', ts: '2026-05-21T10:01:02.000Z', suffix: 'plan', latency_ms: 870 },
      ),
      dispatchResult('pr-opened', 'PR #999 opened', 'https://github.com/fixture/repo/pull/999'),
    ],
  };
}

function buildDeliberationConversationFixture() {
  return {
    plan_id: FIXTURE_PLAN_ID,
    pipeline_id: FIXTURE_PIPELINE_ID,
    intent_id: 'intent-fixture-conversation',
    computed_at: '2026-05-21T12:00:00.000Z',
    events: [
      intentEvent('Plan-scope conversation fixture.'),
      stageStarted('plan-stage', '2026-05-21T10:01:00.000Z', 'plan-only'),
      agentPrompt(
        { content: 'planner prompt body', content_truncated: false },
        { stage: 'plan-stage', turn_index: 0, session_atom_id: 'agent-session-plan-only', ts: '2026-05-21T10:01:01.000Z', suffix: 'plan-only' },
      ),
      agentResponse(
        { content: 'planner response body', content_truncated: false },
        { stage: 'plan-stage', turn_index: 0, session_atom_id: 'agent-session-plan-only', ts: '2026-05-21T10:01:02.000Z', suffix: 'plan-only', latency_ms: 420 },
      ),
    ],
  };
}

function longLines(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(`line ${i}: lorem ipsum dolor sit amet`);
  }
  return lines.join('\n');
}

// ----- Backend stubs -----

function buildPipelineDetailFixture() {
  return {
    pipeline: {
      id: FIXTURE_PIPELINE_ID,
      pipeline_state: 'completed',
      mode: 'substrate-deep',
      principal_id: 'cto-actor',
      correlation_id: 'corr-fixture',
      title: 'Conversation fixture pipeline',
      content: 'fixture content',
      seed_atom_ids: ['intent-fixture-conversation'],
      stage_policy_atom_id: null,
      started_at: '2026-05-21T10:00:00.000Z',
      completed_at: '2026-05-21T11:00:00.000Z',
    },
    stages: [],
    events: [],
    findings: [],
    audit_counts: { total: 0, critical: 0, major: 0, minor: 0 },
    failure: null,
    resumes: [],
    agent_turns: [],
    total_cost_usd: 0.01,
    total_duration_ms: 60_000,
    current_stage_name: null,
    current_stage_index: 0,
    total_stages: 2,
    last_event_at: '2026-05-21T11:00:00.000Z',
    dispatch_summary: { dispatched: 1, failed: 0 },
  };
}


async function mockBaseRoutes(page: Page): Promise<void> {
  /*
   * The new useConversationStream hook subscribes to the substrate's
   * pipeline SSE stream at /api/events/pipeline.<id>. Stub this with
   * an empty 200 so existing specs that focus on the static-data
   * rendering paths do not produce stray network noise. SSE-specific
   * specs override this route with a real text/event-stream body.
   */
  await page.route('**/api/events/pipeline.*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: open\ndata: {}\n\n',
    });
  });
  await page.route('**/api/pipelines.detail', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: buildPipelineDetailFixture() }),
    });
  });
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
      body: JSON.stringify({ ok: true, data: { state: 'ok' } }),
    });
  });
  await page.route('**/api/pipeline.deliberation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { pipeline_id: FIXTURE_PIPELINE_ID, entries: [], computed_at: '2026-05-21T12:00:00.000Z' },
      }),
    });
  });
  // DeliberationView fetches plans via /api/plans.list and resolves
  // the focus plan id locally; stub the list endpoint with a single
  // matching plan atom so the deliberation detail mounts.
  await page.route('**/api/plans.list', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: [
          {
            id: FIXTURE_PLAN_ID,
            type: 'plan',
            layer: 'L1',
            principal_id: 'cto-actor',
            confidence: 0.88,
            created_at: '2026-05-21T10:00:00.000Z',
            content: '# Conversation fixture plan\n\nbody',
            plan_state: 'succeeded',
            metadata: { alternatives_rejected: ['alt-1'] },
          },
        ],
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
}

async function mockPipelineConversation(page: Page) {
  await page.route('**/api/pipelines.conversation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: buildPipelineConversationFixture() }),
    });
  });
}

async function mockDeliberationConversation(page: Page) {
  await page.route('**/api/deliberations.conversation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: buildDeliberationConversationFixture() }),
    });
  });
}

async function mockEmptyConversation(page: Page) {
  await page.route('**/api/pipelines.conversation', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          pipeline_id: FIXTURE_PIPELINE_ID,
          intent_id: null,
          computed_at: '2026-05-21T12:00:00.000Z',
          events: [],
        },
      }),
    });
  });
}

// ----- Specs -----

test.describe('conversation thread', () => {
  test('renders chronological events with handoffs + tool-call expand', async ({ page }) => {
    await mockBaseRoutes(page);
    await mockPipelineConversation(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}/conversation`);

    // View mounts.
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('conversation-thread-view')).toHaveAttribute('data-scope', 'pipeline');

    // Header carries the intent id chip + event count.
    await expect(page.getByTestId('conversation-thread-pipeline-id')).toBeVisible();
    await expect(page.getByTestId('conversation-thread-intent')).toBeVisible();
    await expect(page.getByTestId('conversation-thread-event-count')).toContainText('9 events');

    // 9 rows: intent + 2 stage-started + 2 prompt + 2 response + tool + dispatch.
    const rows = page.getByTestId('conversation-event');
    await expect(rows).toHaveCount(9);

    // Chronological: the first row is the operator-intent.
    await expect(rows.first()).toHaveAttribute('data-kind', 'operator-intent');
    // Last row is the dispatch-result.
    await expect(rows.last()).toHaveAttribute('data-kind', 'dispatch-result');

    // The tool-call row renders the tool-name + args + result blocks.
    const tool = page.getByTestId('conversation-tool-call');
    await expect(tool).toBeVisible();
    await expect(page.getByTestId('conversation-tool-call-name')).toContainText('Read');
    await expect(page.getByTestId('conversation-tool-call-args')).toBeVisible();
    await expect(page.getByTestId('conversation-tool-call-result')).toBeVisible();

    // Args + result payloads are collapsed by default; clicking the
    // toggle reveals them.
    await expect(page.getByTestId('conversation-tool-call-args-payload')).toHaveCount(0);
    await page.getByTestId('conversation-tool-call-args-toggle').click();
    await expect(page.getByTestId('conversation-tool-call-args-payload')).toBeVisible();
    await expect(page.getByTestId('conversation-tool-call-args-payload')).toContainText('docs/x.md');

    await page.getByTestId('conversation-tool-call-result-toggle').click();
    await expect(page.getByTestId('conversation-tool-call-result-payload')).toBeVisible();
    await expect(page.getByTestId('conversation-tool-call-result-payload')).toContainText('markers');

    // Handoff dividers fire on stage-started + cross-stage-reprompt
    // events. With this fixture the first stage-started (brainstorm)
    // emits a TO-only divider (no prior stage), and the second
    // stage-started (plan) emits a FROM=brainstorm TO=plan divider.
    const handoffs = page.locator('[data-testid^="conversation-handoff-"]');
    expect(await handoffs.count()).toBeGreaterThanOrEqual(1);
    // The brainstorm -> plan handoff carries both FROM and TO chips.
    // We address the FROM chip directly via its kind-specific testid
    // suffix so the assertion is robust to additional handoff rows.
    const fromChips = page.locator('[data-testid$="-from"]');
    const toChips = page.locator('[data-testid$="-to"]');
    await expect(fromChips.first()).toContainText('brainstorm-stage');
    // The first TO chip is the brainstorm-stage divider; check that
    // SOME TO chip carries the plan-stage label.
    const matchedTo = toChips.filter({ hasText: 'plan-stage' });
    expect(await matchedTo.count()).toBeGreaterThanOrEqual(1);

    // Dispatch-result row carries the pr_url link.
    await expect(page.getByTestId('conversation-dispatch-result-pr-url')).toHaveAttribute(
      'href',
      'https://github.com/fixture/repo/pull/999',
    );
    await expect(page.getByTestId('conversation-dispatch-result-outcome')).toContainText('pr-opened');
  });

  /*
   * CR feedback on PR #483 (Major / Quick win): a single agent-turn
   * fans out into N tool-call events that all share the same backing
   * atom_id; per-row uniqueness is carried on `tool_call_index`. This
   * spec verifies the renderer survives a multi-tool turn without
   * React-key collisions or rendering only the first row.
   */
  test('multiple tool calls in one turn render distinct rows sharing one atom_id', async ({ page }) => {
    await mockBaseRoutes(page);
    const SHARED_TURN_ATOM = 'agent-turn-fixture-multitool';
    const SESSION_ID = 'agent-session-multitool';
    await page.route('**/api/pipelines.conversation', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            pipeline_id: FIXTURE_PIPELINE_ID,
            intent_id: 'intent-fixture-conversation',
            computed_at: '2026-05-21T12:00:00.000Z',
            events: [
              intentEvent('multi-tool turn fixture'),
              stageStarted('brainstorm-stage', '2026-05-21T10:00:10.000Z', 'multitool'),
              {
                kind: 'tool-call' as const,
                atom_id: SHARED_TURN_ATOM,
                tool_call_index: 0,
                ts: '2026-05-21T10:00:11.000Z',
                principal_id: 'cto-actor',
                stage: 'brainstorm-stage',
                parent_turn_index: 0,
                session_atom_id: SESSION_ID,
                tool_name: 'Read',
                args: '{"path":"/a"}',
                args_truncated: false,
                result: 'file a',
                result_truncated: false,
              },
              {
                kind: 'tool-call' as const,
                atom_id: SHARED_TURN_ATOM,
                tool_call_index: 1,
                ts: '2026-05-21T10:00:12.000Z',
                principal_id: 'cto-actor',
                stage: 'brainstorm-stage',
                parent_turn_index: 0,
                session_atom_id: SESSION_ID,
                tool_name: 'Edit',
                args: '{"path":"/b"}',
                args_truncated: false,
                result: 'file b',
                result_truncated: false,
              },
              {
                kind: 'tool-call' as const,
                atom_id: SHARED_TURN_ATOM,
                tool_call_index: 2,
                ts: '2026-05-21T10:00:13.000Z',
                principal_id: 'cto-actor',
                stage: 'brainstorm-stage',
                parent_turn_index: 0,
                session_atom_id: SESSION_ID,
                tool_name: 'Write',
                args: '{"path":"/c"}',
                args_truncated: false,
                result: 'file c',
                result_truncated: false,
              },
            ],
          },
        }),
      });
    });
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}/conversation`);
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });

    // 5 rows: intent + stage-started + 3 tool-call events.
    const rows = page.getByTestId('conversation-event');
    await expect(rows).toHaveCount(5);

    // Three tool-call rows render. The renderer keys per row by
    // tool_call_index so atom_id collisions do not collapse the list.
    const toolCalls = page.getByTestId('conversation-tool-call');
    await expect(toolCalls).toHaveCount(3);

    // All three tool-call rows share the same atom_id (the agent-turn
    // atom they were projected from).
    const toolCallEventRows = rows.filter({ has: page.getByTestId('conversation-tool-call') });
    await expect(toolCallEventRows).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(toolCallEventRows.nth(i)).toHaveAttribute('data-atom-id', SHARED_TURN_ATOM);
    }
  });

  test('expandable body collapses long agent-response and toggles open', async ({ page }) => {
    await mockBaseRoutes(page);
    await mockPipelineConversation(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}/conversation`);
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });

    // The brainstorm agent-response body is 40 lines long (above the
    // 30-line collapse threshold). Renders collapsed by default.
    const body = page.getByTestId('conversation-agent-response-body-content').first();
    await expect(body).toBeVisible();
    await expect(body).toHaveAttribute('data-collapsed', 'true');

    // Toggle is visible + clickable.
    const toggle = page.getByTestId('conversation-agent-response-body-toggle').first();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(body).toHaveAttribute('data-collapsed', 'false');

    // The truncated tag appears below the body since content_truncated
    // is true on this fixture event.
    await expect(page.getByTestId('conversation-agent-response-body-truncated').first()).toBeVisible();
  });

  test('empty conversation renders a graceful empty-state', async ({ page }) => {
    await mockBaseRoutes(page);
    await mockEmptyConversation(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}/conversation`);

    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('conversation-thread-empty')).toBeVisible();
    // The event list MUST NOT render when there are zero events.
    await expect(page.getByTestId('conversation-thread')).toHaveCount(0);
  });

  test('Conversation link on pipeline detail navigates to conversation subroute', async ({ page }) => {
    await mockBaseRoutes(page);
    await mockPipelineConversation(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}`);

    // Detail mounts.
    await expect(page.getByTestId('pipeline-detail-view')).toBeVisible({ timeout: 10_000 });

    // Click the conversation link.
    const link = page.getByTestId('pipeline-detail-conversation-link');
    await expect(link).toBeVisible();
    await link.click();

    // The URL flips to the conversation subroute and the conversation
    // view mounts.
    await expect(page).toHaveURL(new RegExp(`/pipelines/${FIXTURE_PIPELINE_ID}/conversation$`));
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });
  });

  test('deliberation scope: click-through from plan detail to plan conversation', async ({ page }) => {
    // Exercise the actual ConversationLink wiring rather than
    // deep-linking past it. CR feedback (PR #484): a broken link or
    // route shape on /deliberation/<id> must fail the suite, not pass
    // silently because the test bypasses the link by URL.
    await mockBaseRoutes(page);
    await mockDeliberationConversation(page);
    await page.goto(`/deliberation/${encodeURIComponent(FIXTURE_PLAN_ID)}`);

    // Detail mounts.
    const link = page.getByTestId('deliberation-detail-conversation-link');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();

    // URL flips to the conversation subroute and the view mounts.
    await expect(page).toHaveURL(new RegExp(`/deliberation/${FIXTURE_PLAN_ID}/conversation$`));
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('conversation-thread-view')).toHaveAttribute('data-scope', 'plan');
    // The plan-scope envelope carries plan_id chip + pipeline_id chip
    // when a pipeline was resolved.
    await expect(page.getByTestId('conversation-thread-plan-id')).toBeVisible();
    await expect(page.getByTestId('conversation-thread-pipeline-id')).toBeVisible();
  });

  /*
   * Live updates via SSE. The useConversationStream hook subscribes
   * to the substrate's pipeline SSE channel and invalidates the
   * conversation query on each atom-change event. This spec mocks
   * both endpoints, lets the initial fetch land, fires a synthetic
   * atom-change event, and verifies the conversation endpoint is
   * called a SECOND time (proving the invalidation path is wired).
   */
  test('SSE atom-change event invalidates the conversation query', async ({ page }) => {
    await mockBaseRoutes(page);
    let conversationFetchCount = 0;
    let resolveStreamRoute: (() => void) | null = null;
    await page.route('**/api/pipelines.conversation', async (route) => {
      conversationFetchCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: buildPipelineConversationFixture() }),
      });
    });
    /*
     * Override the SSE stub from mockBaseRoutes with a real
     * text/event-stream body that emits an atom-change event AFTER a
     * short delay so the initial conversation fetch lands first. The
     * route handler holds the connection open until the test calls
     * `resolveStreamRoute()`, mirroring real SSE semantics.
     */
    await page.unroute('**/api/events/pipeline.*');
    await page.route('**/api/events/pipeline.*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
        body:
          'event: open\ndata: {}\n\n'
          + 'event: atom-change\n'
          + `data: ${JSON.stringify({ pipeline_id: FIXTURE_PIPELINE_ID, atom_id: 'agent-turn-fresh', kind: 'atom.created', at: '2026-05-21T10:00:30.000Z' })}\n\n`,
      });
      void resolveStreamRoute;
    });
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}/conversation`);
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });

    // Wait long enough for the SSE event to land + the invalidate to
    // fire its re-fetch. The 10s polling fallback also fires every
    // 10s; we constrain to <8s so the assertion measures the SSE
    // path, not the poll fallback.
    await expect.poll(
      () => conversationFetchCount,
      { timeout: 8_000, intervals: [200, 500, 1000] },
    ).toBeGreaterThanOrEqual(2);
  });

  test('no horizontal scroll at the running viewport', async ({ page, viewport }) => {
    await mockBaseRoutes(page);
    await mockPipelineConversation(page);
    await page.goto(`/pipelines/${encodeURIComponent(FIXTURE_PIPELINE_ID)}/conversation`);
    await expect(page.getByTestId('conversation-thread-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('conversation-thread')).toBeVisible();

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
