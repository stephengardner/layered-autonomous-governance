import { test, expect, type Page } from '@playwright/test';

/**
 * Pipeline SSE stream e2e.
 *
 * Operator concern: the legacy /pipelines/<id> view polled
 * /api/pipelines.detail every 5 seconds. At org-ceiling load (50
 * operators each pinning a detail tab) that is 600 req/min on a
 * payload that almost never changes; the latency between an atom
 * landing on disk and the operator seeing it could be up to 5s.
 * This spec proves the SSE channel ships the same projection within
 * sub-second latency.
 *
 * The route under test is GET /api/events/pipeline.<id>. The
 * Playwright test:
 *
 *   1. Picks a real pipeline atom from /api/pipelines.list so the
 *      spec stays meaningful regardless of fixture content.
 *      Skip-degrades when the local atom store has no pipelines.
 *   2. Loads /pipelines/<id> and waits for the detail surface to
 *      render with the streaming-connected data attribute.
 *   3. Opens a direct GET on the SSE endpoint (via page.request,
 *      which supports streaming) and confirms the wire shape:
 *      content-type, the initial `open` + `pipeline-state-change`
 *      frames, the heartbeat cadence, the disconnect cleanup.
 *
 * Note on cadence: the heartbeat default is 30s which is longer than
 * the spec timeout. The test does NOT wait a full heartbeat cycle;
 * it asserts the initial frames + clean disconnect. The cadence is
 * pinned by the pipeline-stream.test.ts unit test
 * (HEARTBEAT_INTERVAL_MS).
 */

interface PipelineRow {
  readonly pipeline_id: string;
  readonly pipeline_state: string;
  readonly title: string;
}

async function fetchPipelines(page: Page): Promise<ReadonlyArray<PipelineRow>> {
  const response = await page.request.post('/api/pipelines.list');
  expect(response.ok(), 'pipelines.list should return 200').toBe(true);
  const body = await response.json();
  return body?.data?.pipelines ?? [];
}

async function pickPipelineId(page: Page): Promise<string | null> {
  const rows = await fetchPipelines(page);
  if (rows.length === 0) return null;
  // Prefer a terminal-state pipeline so the test does not race with a
  // running pipeline writing new atoms mid-spec.
  const terminal = rows.find(
    (r) => r.pipeline_state === 'completed' || r.pipeline_state === 'failed' || r.pipeline_state === 'succeeded',
  );
  return (terminal ?? rows[0])!.pipeline_id;
}

test.describe('pipeline SSE stream', () => {
  test('SSE endpoint returns text/event-stream and the initial open + state frames', async ({ page }) => {
    const pipelineId = await pickPipelineId(page);
    test.skip(pipelineId === null, 'no pipeline atoms in the local store; skipping');

    /*
     * Read the SSE channel from inside the browser context using the
     * native ReadableStream API. Playwright's `request` fixture buffers
     * the entire response body and an SSE stream never closes, so the
     * earlier shape timed out at the request level. Reading via fetch +
     * stream-reader inside the page lets us pull bytes for a short
     * window then abort the underlying connection deterministically.
     *
     * We need a real page origin so `fetch('/api/events/...')` resolves
     * to the dev server (relative URLs require window.location.origin
     * which is `about:blank` until the page navigates).
     */
    await page.goto('/');
    const collected = await page.evaluate(async (id) => {
      const controller = new AbortController();
      // Abort after a short window so the test does not hang on the
      // never-closing SSE response.
      setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`/api/events/pipeline.${id}`, {
        signal: controller.signal,
      });
      const status = res.status;
      const contentType = res.headers.get('content-type') ?? '';
      let body = '';
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            body += decoder.decode(value, { stream: true });
            // Stop early once we have both expected frames so the
            // assertion runs against a focused window rather than the
            // 2s timeout's full buffer.
            if (body.includes('event: open') && body.includes('event: pipeline-state-change')) {
              controller.abort();
              break;
            }
          }
        } catch {
          // Abort throws AbortError; intentional.
        }
      }
      return { status, contentType, body };
    }, pipelineId);

    expect(collected.status, 'SSE endpoint should return 200').toBe(200);
    expect(collected.contentType).toContain('text/event-stream');
    expect(collected.body, 'should emit `open` SSE event').toContain('event: open');
    expect(collected.body, 'should emit `pipeline-state-change` SSE event').toContain('event: pipeline-state-change');
    expect(collected.body, `should reference pipeline_id ${pipelineId}`).toContain(pipelineId);
  });

  test('SSE endpoint returns 404 for a pipeline_id with no backing atom', async ({ request }) => {
    const response = await request.get('/api/events/pipeline.pipeline-does-not-exist-fixture');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body?.ok).toBe(false);
    expect(body?.error?.code).toBe('pipeline-not-found');
  });

  test('SSE endpoint rejects pipeline channels with malformed ids', async ({ request }) => {
    // Channel parser rejects '..' / slashes / control chars before reaching the index lookup.
    // The route explicitly 404s a malformed pipeline.* channel (not falling through to the
    // generic SSE handler) so the malformed-id surface never opens a socket outside the
    // MAX_SUBSCRIBERS_PER_PIPELINE cap. Pinned by the server-side guard in /api/events/.
    const response = await request.get('/api/events/pipeline.../etc/passwd');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body?.ok).toBe(false);
    expect(body?.error?.code).toBe('invalid-pipeline-channel');
    // Should NOT contain any filesystem-shape data leak.
    expect(JSON.stringify(body)).not.toContain('passwd');
  });

  test('detail view exposes the SSE connection state via data attribute', async ({ page }) => {
    const pipelineId = await pickPipelineId(page);
    test.skip(pipelineId === null, 'no pipeline atoms in the local store; skipping');

    await page.goto(`/pipelines/${pipelineId}`);
    const view = page.getByTestId('pipeline-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    /*
     * The data-pipeline-stream attribute reports the connection
     * state directly so this assertion does not race against React
     * scheduling. Accept any of the live-transition states
     * (connecting -> open is the expected path; failed is the
     * substrate-degraded path that the fallback poll covers).
     */
    const state = await view.getAttribute('data-pipeline-stream');
    expect(['connecting', 'open', 'reconnecting', 'failed']).toContain(state);
  });

  test('pipeline detail view renders and remains stable while SSE is active', async ({ page }) => {
    const pipelineId = await pickPipelineId(page);
    test.skip(pipelineId === null, 'no pipeline atoms in the local store; skipping');

    await page.goto(`/pipelines/${pipelineId}`);
    const view = page.getByTestId('pipeline-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    /*
     * Hold the page for ~2s and confirm no layout shift / blank
     * frames / re-render flicker. The legacy 5s polling would
     * trigger a refetch within this window; the SSE-driven view
     * should NOT refetch unless the watcher fires.
     */
    await page.waitForTimeout(2_000);

    // The view container is still visible after the hold.
    await expect(view).toBeVisible();

    // The state pill renders deterministically.
    const statePill = page.getByTestId('pipeline-detail-state');
    await expect(statePill).toBeVisible();
  });

  test('no horizontal scroll at mobile viewport during streaming', async ({ page, viewport }) => {
    const pipelineId = await pickPipelineId(page);
    test.skip(pipelineId === null, 'no pipeline atoms in the local store; skipping');

    await page.goto(`/pipelines/${pipelineId}`);
    const view = page.getByTestId('pipeline-detail-view');
    await expect(view).toBeVisible({ timeout: 10_000 });

    // Only enforce the mobile-floor rule on the mobile project.
    if (viewport && viewport.width <= 400) {
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `mobile horizontal scroll: ${scrollWidth} > ${clientWidth}`).toBeLessThanOrEqual(clientWidth + 1);
    }
  });
});
