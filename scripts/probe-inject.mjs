#!/usr/bin/env node
/**
 * Probe: empirically determine which PTY injection sequence causes
 * Claude Code's TUI to actually submit a prompt.
 *
 * Method:
 *   1. Snapshot the set of existing jsonls under
 *      ~/.claude/projects/<sanitized-cwd>/
 *   2. Spawn `claude` fresh as a node-pty child (same cwd as this repo)
 *   3. Wait N seconds for the TUI to reach the input prompt
 *   4. Write a candidate sequence carrying a unique marker string
 *   5. Poll the projectDir for a new jsonl; inside it, look for a
 *      line of type "user" whose content contains the marker
 *   6. If the marker appears within TIMEOUT, sequence PASSED
 *      (the TUI actually submitted the draft to create a turn).
 *      If not, sequence FAILED.
 *
 * Why the marker-in-user-entry test is authoritative: Claude Code
 * writes a `user` jsonl record as soon as it accepts a submitted
 * prompt, before the assistant response starts streaming. So the
 * presence of a user record containing our marker is a ground-truth
 * signal that submission happened.
 *
 * Usage:
 *   node scripts/probe-inject.mjs
 *   node scripts/probe-inject.mjs --only A,C
 *   node scripts/probe-inject.mjs --ready-ms 5000 --wait-ms 15000
 *
 * Produces a pass/fail table and names the sequences that worked,
 * so we can point the real injector at a provably-correct one.
 */

import { spawn as ptySpawn } from 'node-pty';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

function sanitize(cwd) { return cwd.replace(/[:\\/]/g, '-'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Each candidate is an async function that receives a write() callback
// and a sleep() helper. It is responsible for delivering the marker
// text to the PTY in whatever way it wants to test.
const CANDIDATES = [
  {
    id: 'A',
    name: 'text + CR (one write)',
    run: async (text, w) => { w(text + '\r'); },
  },
  {
    id: 'B',
    name: 'text, 150ms, CR',
    run: async (text, w, s) => { w(text); await s(150); w('\r'); },
  },
  {
    id: 'C',
    name: 'bracketed paste, CR (one write each)',
    run: async (text, w) => { w('\x1b[200~' + text + '\x1b[201~'); w('\r'); },
  },
  {
    id: 'D',
    name: 'bracketed paste, 150ms, CR',
    run: async (text, w, s) => { w('\x1b[200~' + text + '\x1b[201~'); await s(150); w('\r'); },
  },
  {
    id: 'E',
    name: 'bracketed paste, LF',
    run: async (text, w) => { w('\x1b[200~' + text + '\x1b[201~'); w('\n'); },
  },
  {
    id: 'F',
    name: 'text + LF',
    run: async (text, w) => { w(text + '\n'); },
  },
  {
    id: 'G',
    name: 'text + CR + LF',
    run: async (text, w) => { w(text + '\r\n'); },
  },
  {
    id: 'H',
    name: 'chars one-at-a-time (5ms), CR',
    run: async (text, w, s) => {
      for (const ch of text) { w(ch); await s(5); }
      w('\r');
    },
  },
  {
    id: 'I',
    name: 'bracketed paste, CR, 100ms, CR',
    run: async (text, w, s) => {
      w('\x1b[200~' + text + '\x1b[201~');
      w('\r');
      await s(100);
      w('\r');
    },
  },
];

function parseArgs(argv) {
  const args = { only: null, readyMs: 4000, waitMs: 20_000, verbose: false, resumeSessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only' && i + 1 < argv.length) {
      args.only = new Set(argv[++i].split(',').map((s) => s.trim().toUpperCase()));
    } else if (a === '--ready-ms' && i + 1 < argv.length) {
      args.readyMs = Number(argv[++i]);
    } else if (a === '--wait-ms' && i + 1 < argv.length) {
      args.waitMs = Number(argv[++i]);
    } else if (a === '--resume-session' && i + 1 < argv.length) {
      args.resumeSessionId = argv[++i];
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/probe-inject.mjs [options]
  --only A,C               Only run listed candidates (default: all)
  --ready-ms <n>           TUI settle time before writing (default: 4000)
  --wait-ms <n>            Max time to watch for user entry (default: 20000)
  --resume-session <id>    Resume this session id (tests --resume code path)
  --verbose                Print PTY output and sequence details`);
      process.exit(0);
    }
  }
  return args;
}

async function snapshotJsonls(projectDir) {
  const out = new Set();
  try {
    for (const f of await readdir(projectDir)) {
      if (f.endsWith('.jsonl')) out.add(f);
    }
  } catch { /* project dir may not exist */ }
  return out;
}

async function waitForUserMarker(projectDir, _before, marker, timeoutMs) {
  // Note: scan *all* jsonls (not just new ones). In --resume mode the
  // session's existing jsonl is appended to, not replaced; new user
  // records land inside a pre-existing file. The marker is unique per
  // run, so false matches against historical content are not possible.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      for (const f of await readdir(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = join(projectDir, f);
        let content;
        try { content = await readFile(fp, 'utf8'); } catch { continue; }
        for (const line of content.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type === 'user' && JSON.stringify(obj).includes(marker)) {
            return { passed: true, file: f };
          }
        }
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  return { passed: false, file: null };
}

async function runCandidate(candidate, opts) {
  const projectDir = join(PROJECTS_ROOT, sanitize(REPO_ROOT));
  const before = await snapshotJsonls(projectDir);

  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const claudeArgs = opts.resumeSessionId
    ? ['--resume', opts.resumeSessionId]
    : [];
  const child = ptySpawn(claudeCmd, claudeArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: REPO_ROOT,
    env: process.env,
  });

  let outputLen = 0;
  let output = '';
  child.onData((d) => {
    outputLen += d.length;
    if (opts.verbose) output += d;
  });

  // Settle.
  await sleep(opts.readyMs);

  // Deliver the candidate sequence.
  const marker = `PROBE-${candidate.id}-${Date.now()}`;
  const text = `probe test ${marker}`;
  await candidate.run(text, (s) => child.write(s), sleep);

  // Watch for the user entry.
  const { passed, file } = await waitForUserMarker(projectDir, before, marker, opts.waitMs);

  try { child.kill(); } catch { /* ignore */ }
  // Give the PTY a moment to release file handles.
  await sleep(500);

  return {
    id: candidate.id,
    name: candidate.name,
    passed,
    file,
    marker,
    outputBytes: outputLen,
    outputTail: opts.verbose ? output.slice(-400) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.only
    ? CANDIDATES.filter((c) => args.only.has(c.id))
    : CANDIDATES;

  if (selected.length === 0) {
    console.error('No candidates selected.');
    process.exit(1);
  }

  console.log('Probing PTY injection sequences against Claude Code TUI.');
  console.log(`Cwd:         ${REPO_ROOT}`);
  console.log(`Project dir: ${join(PROJECTS_ROOT, sanitize(REPO_ROOT))}`);
  console.log(`Candidates:  ${selected.length}    Ready-ms: ${args.readyMs}    Wait-ms: ${args.waitMs}`);
  console.log('');

  const results = [];
  for (const c of selected) {
    process.stdout.write(`  [${c.id}] ${c.name.padEnd(40)} `);
    const r = await runCandidate(c, args);
    results.push(r);
    console.log(r.passed ? 'PASS' : 'FAIL');
    if (args.verbose && r.outputTail) {
      console.log('    output tail:');
      console.log(r.outputTail.split('\n').map((l) => '      ' + l).join('\n'));
    }
  }

  console.log('\nSummary:');
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad('ID', 4)} ${pad('NAME', 42)} ${pad('RESULT', 8)} ${pad('JSONL', 40)}`);
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`  ${pad(r.id, 4)} ${pad(r.name, 42)} ${pad(status, 8)} ${pad(r.file || '-', 40)}`);
  }

  const passes = results.filter((r) => r.passed);
  console.log('');
  if (passes.length === 0) {
    console.log('No sequence caused a submission. Inspect PTY output with --verbose to debug further.');
    process.exit(2);
  } else {
    console.log(`Working sequences: ${passes.map((r) => r.id).join(', ')}`);
    console.log('Point the real injector at the simplest one that passed.');
  }
}

main().catch((err) => {
  console.error('probe-inject failed:', err);
  process.exit(1);
});
