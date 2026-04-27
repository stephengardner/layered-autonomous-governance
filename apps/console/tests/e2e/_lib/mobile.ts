import { test, expect, devices } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Shared helpers for mobile-only e2e specs.
 *
 * Extracted at N=2/3 per canon `dev-extract-at-n-equals-2`:
 * `skipUnlessMobile` lives in three specs (plans-mobile,
 * canon-mobile, principal-mobile via PR #229) and `gotoFirst*`
 * helpers are per-surface but cohesive enough to live next to
 * the gate. Future mobile specs land here in one motion.
 *
 * The leading underscore on the directory name (`_lib`) keeps
 * Playwright's testDir matcher from picking these as specs while
 * still letting the import path stay relative.
 */

export const MOBILE_WIDTH = devices['iPhone 13'].viewport.width;

/**
 * Mobile-only gate. Each spec calls this in its first line so
 * desktop projects (chromium) skip cleanly. Fail-closed default:
 * unknown viewport (no project profile) is treated as wider-than-
 * mobile so the assertion is skipped, not run against a desktop-
 * shaped page.
 */
export function skipUnlessMobile(viewport: { width: number } | null | undefined): void {
  const width = viewport?.width ?? Number.POSITIVE_INFINITY;
  test.skip(width > MOBILE_WIDTH, 'mobile-only assertion');
}

/**
 * Validate the API envelope and extract the array. The console
 * server returns either `{ ok: true, data: [...] }` or a bare array
 * (legacy shape); anything else is an envelope error and must not
 * be indexed into. Returns the array or null on shape mismatch.
 */
function extractIdArray(body: unknown): ReadonlyArray<{ id: string }> | null {
  if (Array.isArray(body)) return body as ReadonlyArray<{ id: string }>;
  if (body && typeof body === 'object' && 'data' in body) {
    const data = (body as { data: unknown }).data;
    if (Array.isArray(data)) return data as ReadonlyArray<{ id: string }>;
  }
  return null;
}

/**
 * Discover the first plan id at runtime via /api/plans.list and
 * navigate to /plans/<id>. Skips cleanly when the store is empty
 * so a fresh-install workflow does not false-fail. Validates the
 * envelope shape so an error response never gets indexed into.
 */
export async function gotoFirstPlan(page: Page, request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/plans.list', { data: {} });
  expect(res.ok(), 'plans.list endpoint should return 200').toBe(true);
  const body = (await res.json()) as unknown;
  const plans = extractIdArray(body);
  if (plans === null) {
    throw new Error(`plans.list returned a non-array payload: ${JSON.stringify(body).slice(0, 200)}`);
  }
  test.skip(plans.length === 0, 'no plans to focus');
  await page.goto(`/plans/${encodeURIComponent(plans[0]!.id)}`);
}

/**
 * Discover the first canon atom id at runtime via /api/canon.list
 * and navigate to /canon/<id>. Skips cleanly when canon is empty.
 * Validates the envelope shape so an error response never gets
 * indexed into.
 */
export async function gotoFirstCanon(page: Page, request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/canon.list', { data: {} });
  expect(res.ok(), 'canon.list endpoint should return 200').toBe(true);
  const body = (await res.json()) as unknown;
  const atoms = extractIdArray(body);
  if (atoms === null) {
    throw new Error(`canon.list returned a non-array payload: ${JSON.stringify(body).slice(0, 200)}`);
  }
  test.skip(atoms.length === 0, 'no canon atoms to focus');
  await page.goto(`/canon/${encodeURIComponent(atoms[0]!.id)}`);
}
