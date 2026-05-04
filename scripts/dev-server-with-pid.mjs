#!/usr/bin/env node
/**
 * Spawn a long-running dev-server child (tsx watch, vite, or any
 * other watcher) and record its PID + the launcher PID into the
 * shared PID record. On exit, remove the record so the next
 * pre-flight cleanup sees a clean slot.
 *
 * Wraps `dev:server` in apps/console/package.json so the recorded
 * PIDs match the actual children running. When this wrapper is
 * SIGTERM'd cleanly, it forwards the signal to the child and
 * removes the PID record. When it crashes uncleanly (process
 * killed by SIGKILL, VM panic, OS shutdown), the PID record is
 * left behind; the next dev-server-cleanup run consumes it.
 *
 * Usage:
 *   node scripts/dev-server-with-pid.mjs <cmd> [args...]
 *
 * Example (wired in apps/console/package.json):
 *   "dev:server": "node ../../scripts/dev-server-with-pid.mjs tsx watch server/index.ts"
 *
 * Cross-platform: spawns the child with `shell: false` and
 * forwards SIGINT/SIGTERM. Does NOT use detached:true so Ctrl+C
 * in the parent terminal still propagates through `concurrently`
 * to the child the same way the bare `tsx watch` invocation
 * always did. The PID record is the load-bearing mechanism, not
 * detached process groups.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readPidRecord,
  removePidRecord,
  writePidRecord,
} from './lib/dev-server-cleanup.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const PID_FILE = resolve(REPO_ROOT, 'apps', 'console', '.lag-dev-servers.pid.json');

const argv = process.argv.slice(2);
if (argv.length === 0) {
  process.stderr.write(
    'usage: node scripts/dev-server-with-pid.mjs <cmd> [args...]\n',
  );
  process.exit(2);
}

const [cmd, ...cmdArgs] = argv;
// On Windows, Node's child_process.spawn requires shell:true to
// resolve `tsx` (a .cmd shim) on PATH. Without shell:true the
// invocation fails with ENOENT. POSIX is fine without shell.
const useShell = process.platform === 'win32';

const child = spawn(cmd, cmdArgs, {
  stdio: 'inherit',
  shell: useShell,
  windowsHide: true,
});

// Append our PIDs (launcher + child) to the existing record so a
// concurrently-driven `npm run dev` accumulates BOTH `dev:server`
// and `dev:web` entries (when both wire through this wrapper).
// When only one half wires through, the other half is still
// covered by the scan-fallback in dev-server-cleanup.mjs.
function appendPids() {
  if (typeof child.pid !== 'number') return;
  const existing = readPidRecord(PID_FILE);
  const existingPids = existing?.pids ?? [];
  const merged = Array.from(new Set([...existingPids, process.pid, child.pid]));
  writePidRecord(PID_FILE, {
    pids: merged,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    repoRoot: REPO_ROOT,
    entry: cmdArgs.find((a) => a.endsWith('.ts')) ?? cmdArgs.join(' '),
  });
}
appendPids();

let exiting = false;
function cleanup() {
  if (exiting) return;
  exiting = true;
  // Best-effort: trim our pids from the record. If the file is
  // gone (predev cleanup ran while we were exiting), nothing to do.
  const existing = readPidRecord(PID_FILE);
  if (existing === null) return;
  const remaining = existing.pids.filter(
    (p) => p !== process.pid && p !== child.pid,
  );
  if (remaining.length === 0) {
    removePidRecord(PID_FILE);
  } else {
    writePidRecord(PID_FILE, {
      pids: remaining,
      startedAt: existing.startedAt ?? new Date().toISOString(),
      repoRoot: existing.repoRoot ?? REPO_ROOT,
      entry: existing.entry ?? cmdArgs.find((a) => a.endsWith('.ts')) ?? cmdArgs.join(' '),
    });
  }
}

function forward(sig) {
  return () => {
    if (child.pid && !child.killed) {
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };
}

process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
process.on('exit', cleanup);

child.on('exit', (code, signal) => {
  cleanup();
  // Mirror the child's exit. When killed by signal, exit code
  // 128+signum follows the convention every shell wrapper uses.
  if (signal) {
    process.exit(128 + (typeof signal === 'string' ? signalToNumber(signal) : 0));
  }
  process.exit(typeof code === 'number' ? code : 0);
});

child.on('error', (err) => {
  process.stderr.write(`[lag-dev-with-pid] spawn failed: ${err instanceof Error ? err.message : String(err)}\n`);
  cleanup();
  process.exit(1);
});

function signalToNumber(sig) {
  // Lookup table for the small set of signals that actually
  // terminate dev-server children. Anything else falls back to 0
  // so the exit code is 128 (caller can treat as "abnormal exit").
  switch (sig) {
    case 'SIGHUP': return 1;
    case 'SIGINT': return 2;
    case 'SIGTERM': return 15;
    case 'SIGKILL': return 9;
    default: return 0;
  }
}
