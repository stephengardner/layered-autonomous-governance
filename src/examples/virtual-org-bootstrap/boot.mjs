#!/usr/bin/env node
/**
 * Virtual-org bootstrap entry point.
 *
 * Spins up a two-agent deliberation (CTO + Code Author) against a
 * memory-backed substrate and prints the resulting Decision or
 * Escalation. The question prompt comes from argv[2] or stdin; if
 * neither is provided a default smoke prompt is used.
 *
 * Runtime wiring:
 *   - Memory-backed Host (in-process AtomStore, PrincipalStore, Clock).
 *     Replaceable with createFileHost when persistence is wanted; the
 *     downstream code is Host-shape-agnostic.
 *   - Kill-switch watching `.lag/STOP` in the current working directory.
 *   - Real Anthropic SDK client. ANTHROPIC_API_KEY must be set or the
 *     SDK throws at first request; the script deliberately does not
 *     validate the key up-front so operators using a Bedrock or Vertex
 *     setup through the SDK's alternate auth surfaces are not blocked.
 *
 * All substrate imports resolve to `../../../dist/` (the compiled
 * output). Run `npm run build` before `node boot.mjs`.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';

import { Anthropic } from '@anthropic-ai/sdk';

import { createMemoryHost } from '../../../dist/adapters/memory/index.js';
import { createKillSwitch } from '../../../dist/kill-switch/index.js';
import {
  createCanonRenderer,
  createDeliberationSink,
  createReasoningSink,
  loadCanonFixtures,
  loadSeedPrincipals,
  runDeliberation,
} from '../../../dist/examples/virtual-org-bootstrap/boot-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();
const STATE_DIR = resolve(CWD, '.lag');

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });

  const principalsDir = join(HERE, 'principals');
  const canonDir = join(HERE, 'canon');
  const seeds = loadSeedPrincipals({ dir: principalsDir });
  const canonAtoms = loadCanonFixtures(canonDir);

  const host = createMemoryHost();
  for (const seed of seeds) {
    await host.principals.put(seed.principal);
  }
  for (const atom of canonAtoms) {
    await host.atoms.put(atom);
  }

  const killSwitch = createKillSwitch({ stateDir: STATE_DIR });

  const prompt = await readPrompt();
  const question = {
    id: `q-${Date.now()}`,
    type: 'question',
    prompt,
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  };

  const anthropic = new Anthropic();

  const participating = seeds.filter(
    (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
  );

  try {
    const outcome = await runDeliberation({
      question,
      participants: participating,
      atomStore: host.atoms,
      principalStore: host.principals,
      anthropic,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      signal: killSwitch.signal,
    });
    console.log(JSON.stringify(outcome, null, 2));
    const typeCounts = await summarizeAtomCounts(host.atoms);
    console.error(`[boot] atoms written by type: ${JSON.stringify(typeCounts)}`);
  } finally {
    killSwitch.dispose();
  }
}

async function readPrompt() {
  if (process.argv[2]) return process.argv[2];
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const combined = Buffer.concat(chunks).toString('utf8').trim();
    if (combined.length > 0) return combined;
  }
  return 'Smoke test: propose a patch-level version bump rationale.';
}

async function summarizeAtomCounts(atomStore) {
  const page = await atomStore.query({}, 10_000);
  const counts = {};
  for (const atom of page.atoms) {
    const kindTag = typeof atom.metadata?.kind === 'string'
      ? `${atom.type}:${atom.metadata.kind}`
      : atom.type;
    counts[kindTag] = (counts[kindTag] ?? 0) + 1;
  }
  return counts;
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
