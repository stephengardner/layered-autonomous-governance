#!/usr/bin/env node
/**
 * gh-as: run a gh CLI command under a provisioned bot identity.
 *
 * Usage:
 *   node scripts/gh-as.mjs <role> <gh-args...>
 *
 * Examples:
 *   node scripts/gh-as.mjs lag-cto pr create --title "..." --body "..."
 *   node scripts/gh-as.mjs lag-pr-landing api repos/o/r/pulls/1/comments
 *
 * Mints a fresh installation token for <role> via gh-token-for.mjs,
 * sets it as GH_TOKEN in the child process environment, and execs
 * `gh <gh-args...>`. The child's stdout/stderr are piped through so
 * the caller sees gh's output verbatim.
 *
 * The token exists only for the duration of the child process;
 * it is not written to disk, not logged, and not inherited by the
 * parent shell. Each invocation is a fresh short-lived token (GitHub
 * Apps cap installation tokens at ~1 hour).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createCredentialsStore,
} from '../dist/actors/provisioning/index.js';
import {
  fetchInstallationToken,
} from '../dist/external/github-app/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(REPO_ROOT, '.lag');

async function main() {
  const role = process.argv[2];
  const ghArgs = process.argv.slice(3);
  if (!role || ghArgs.length === 0) {
    console.error('Usage: node scripts/gh-as.mjs <role> <gh-args...>');
    console.error('Example: node scripts/gh-as.mjs lag-cto pr create --title T --body B');
    process.exit(2);
  }

  const store = createCredentialsStore(STATE_DIR);
  const loaded = await store.load(role);
  if (loaded === null) {
    console.error(`[gh-as] no credentials for role '${role}'. Run: node bin/lag-actors.js sync`);
    process.exit(2);
  }
  if (loaded.record.installationId === undefined) {
    console.error(`[gh-as] role '${role}' provisioned but not installed on a repo.`);
    console.error(`Install: https://github.com/apps/${loaded.record.slug}/installations/new`);
    console.error(`Then:    node bin/lag-actors.js demo-pr --role ${role} --repo <owner/repo>`);
    process.exit(2);
  }

  // Wrap the mint in the same error shape as gh-token-for.mjs so
  // operators see one consistent `[gh-as] ...` one-liner on failure
  // instead of a raw V8 unhandled-rejection stack trace.
  let token;
  try {
    token = await fetchInstallationToken({
      appId: loaded.record.appId,
      privateKey: loaded.privateKey,
      installationId: loaded.record.installationId,
    });
  } catch (err) {
    console.error(`[gh-as] token mint failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Exec gh with GH_TOKEN overridden for this child only. GH_TOKEN
  // beats any cached `gh auth` state; the parent shell is unaffected.
  //
  // shell:true ONLY on win32: the gh distribution on Windows ships as
  // a .cmd/.bat shim (gh.cmd, not gh.exe in every install). Node's
  // `spawn` with shell:false does NOT resolve .cmd/.bat via PATH, so
  // on Windows the invocation fails with ENOENT. shell:true hands the
  // lookup to cmd.exe which DOES resolve the shim. On Linux/macOS we
  // keep shell:false to avoid the shell-metacharacter injection
  // surface that shell:true would open up; the forwarded GH_TOKEN
  // argv is safe but user-passed args flow through unchecked.
  const isWindows = process.platform === 'win32';
  const child = spawn('gh', ghArgs, {
    env: {
      ...process.env,
      GH_TOKEN: token.token,
      // Defensive: some deployments have GITHUB_TOKEN set too.
      GITHUB_TOKEN: token.token,
    },
    stdio: 'inherit',
    shell: isWindows,
  });

  // A process can terminate two ways: normal exit (code is a number,
  // signal is null) or killed by a signal (code is null, signal is a
  // string like 'SIGTERM'). Forwarding only `code` here masked signal
  // terminations as exit 0; CI would treat a killed gh child as
  // success. Translate a signal termination to a non-zero exit so the
  // downstream check (GitHub Actions, make, shell && chain) fails
  // loudly. 128 + (Unix signal number) is the POSIX convention; we
  // don't have the signal number in Node's callback, so use a single
  // stable non-zero (1) with the signal name surfaced on stderr.
  child.on('exit', (code, signal) => {
    if (signal !== null) {
      console.error(`[gh-as] gh child terminated by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`[gh-as] failed to spawn gh: ${err?.message ?? err}`);
    process.exit(1);
  });
}

await main();
