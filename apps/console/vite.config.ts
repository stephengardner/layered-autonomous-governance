import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Reserved ports (see docs/ports.md). Dashboard = 9080 for the
// browser; backend server = 9081. Vite dev proxies /api -> 9081 so
// the browser sees one origin and we keep CORS simple.
//
// LAG_CONSOLE_PORT / LAG_CONSOLE_BACKEND_PORT are honored when set by
// playwright.config.ts during a parallel-worktree e2e run. Without
// these, the operator's primary dev server (already on 9080) would
// fail strictPort and crash the test boot. Defaults are unchanged
// for the common single-worktree case.
const DASHBOARD_PORT = Number(process.env['LAG_CONSOLE_PORT'] ?? 9080);
const BACKEND_PORT = Number(process.env['LAG_CONSOLE_BACKEND_PORT'] ?? 9081);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
  // `base` is driven at build time from env so the gh-pages artifact
  // (served from `/<repo-name>/...`) and the standalone bundle (served
  // from `/`) share one config. Defaults to `/` for local dev.
  base: process.env['VITE_LAG_BASE'] ?? '/',
  build: {
    // ES2022 target unlocks top-level await, which main.tsx uses to
    // install the demo bundle before React mounts. Also matches
    // tsconfig.app.json's target so tsc and vite agree.
    target: 'es2022',
  },
  server: {
    port: DASHBOARD_PORT,
    strictPort: true, // fail fast if port taken instead of hopping
    // Allow access via the operator's cloudflared quick-tunnel hosts
    // (random *.trycloudflare.com subdomains) so a public preview URL
    // works without each tunnel restart needing a config edit. Local
    // operator-only by default; tunnel exposure remains gated on the
    // operator running cloudflared explicitly.
    allowedHosts: ['localhost', '.trycloudflare.com'],
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
