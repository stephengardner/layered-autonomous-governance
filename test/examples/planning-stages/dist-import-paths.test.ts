/**
 * Public-surface smoke test for the built planning-stage adapters.
 *
 * Why: TypeScript resolves source-relative imports like
 * `../../../src/runtime/...` at compile-time without complaint, but the
 * resulting JS in dist/examples/ retains those literal paths. After a
 * clean `tsc -b tsconfig.examples.json`, dist/ flattens src/ (no
 * dist/src/), so the dispatch-stage's value import of runDispatchTick
 * threw ERR_MODULE_NOT_FOUND at runtime startup. Other stages survived
 * only because their src/ imports were types-only.
 *
 * This test imports every built planning-stage entry from its dist
 * artifact and asserts the import resolves. It is a build-validation
 * gate: any future stage that imports a value from src/ via a
 * compile-only-correct path is caught here, not at first runtime use.
 *
 * Skips gracefully if dist/examples/planning-stages is missing, matching
 * the quickstart smoke test pattern. CI runs `npm run build` before
 * `npm test`, so the skip only fires on a manual run before a first
 * build.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const DIST_DIR = resolve(REPO_ROOT, 'dist', 'examples', 'planning-stages');

const STAGE_DIRS = [
  'brainstorm',
  'spec',
  'plan',
  'review',
  'dispatch',
] as const;

describe('public surface: built planning-stage adapters', () => {
  for (const dir of STAGE_DIRS) {
    it(`dist/examples/planning-stages/${dir}/index.js loads`, async (ctx) => {
      const entry = resolve(DIST_DIR, dir, 'index.js');
      if (!existsSync(entry)) {
        ctx.skip();
        return;
      }
      const url = pathToFileURL(entry).href;
      const mod = await import(url);
      expect(mod).toBeDefined();
      // Each stage exports either a stage value (brainstorm, spec,
      // plan, review) or a factory (dispatch). Either way the module
      // must export at least one symbol; an empty namespace would
      // suggest a build-side regression.
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    });
  }
});
