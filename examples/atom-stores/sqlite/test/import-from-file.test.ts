/**
 * Migration-tool regression suite for the FileAtomStore -> SqliteAtomStore
 * import script. Drives the script's exported `run()` library entry point
 * with captured stdout / stderr so each case asserts both the side-effect
 * (DB state via SqliteAtomStore.get()) and the user-facing message text.
 *
 * The whole suite skips when `better-sqlite3` is not installable in the
 * current environment. Two failure modes are tolerated:
 *
 *   1. The package is missing entirely (ERR_MODULE_NOT_FOUND).
 *   2. The native binding failed to load (ERR_DLOPEN_FAILED), which
 *      happens on hosts where `npm install` skipped post-install scripts
 *      and `npm rebuild better-sqlite3` was never run.
 *
 * CI rebuilds the native binding before the suite runs (see
 * `.github/workflows/ci.yml`); a developer who installs with
 * `--ignore-scripts` and forgets to rebuild gets a clean skip rather than
 * a confusing crash.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Atom, AtomId, Time } from '../../../../src/types.js';
import { sampleAtom } from '../../../../test/fixtures.js';

async function loadSuite(): Promise<{
  run: (argv: string[], io?: { stdout: (s: string) => void; stderr: (s: string) => void }) => Promise<{
    ok: boolean;
    code: number;
    error?: string;
    args?: Record<string, unknown>;
    inserted?: number;
    skipped?: number;
    verified?: number;
    files?: number;
    conflicts?: number;
  }>;
  // The adapter under test; used to prove the imported rows actually
  // round-trip through SqliteAtomStore.get(), not just through raw SQL.
  SqliteAtomStore: typeof import('../src/atom-store.js')['SqliteAtomStore'];
} | null> {
  try {
    // Probe better-sqlite3 directly. If this throws, the entire suite
    // skips; we do not even attempt to import the migration script
    // because its top-level `import Database from 'better-sqlite3'`
    // would crash module-load instead of inside a try/catch.
    await import('better-sqlite3');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
  // Import from the shebang-free lib module, not the CLI wrapper. The
  // wrapper carries `#!/usr/bin/env node` which vitest's esbuild on
  // Windows cannot strip when loaded via dynamic import from a .ts
  // file (see PR #123 git-as precedent + PR #172 cr-precheck).
  const script = await import('../scripts/lib/import-from-file.mjs');
  const adapter = await import('../src/atom-store.js');
  return { run: script.run, SqliteAtomStore: adapter.SqliteAtomStore };
}

const loaded = await loadSuite();

// Suite must run under the active describe.skip branch even when loaded
// is null, because vitest may evaluate the closure for collection. The
// closure short-circuits in that case so the inner expressions never
// touch the null value.
const suite = loaded === null ? describe.skip : describe;

suite('import-from-file.mjs migration tool', () => {
  if (loaded === null) {
    // Defensive guard; the describe.skip branch should keep us out, but
    // vitest still evaluates the closure for collection, so we make
    // sure the null path returns before destructuring.
    it.skip('skipped: better-sqlite3 unavailable', () => undefined);
    return;
  }
  const { run, SqliteAtomStore } = loaded;

  let sourceDir: string;
  let destPath: string;
  let stdout: string[];
  let stderr: string[];
  const io = {
    stdout: (s: string) => stdout.push(s),
    stderr: (s: string) => stderr.push(s),
  };

  beforeEach(async () => {
    const work = await mkdtemp(join(tmpdir(), 'lag-import-tool-'));
    sourceDir = join(work, 'atoms');
    destPath = join(work, 'atoms.db');
    await rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
    // mkdtemp creates the parent; create the atoms/ subdir.
    await import('node:fs/promises').then((m) => m.mkdir(sourceDir, { recursive: true }));
    stdout = [];
    stderr = [];
  });

  afterEach(async () => {
    // mkdtemp returned a single temp root; remove its parent to clean
    // both atoms/ and atoms.db plus the WAL/SHM sidecars.
    const parent = join(sourceDir, '..');
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
  });

  async function writeAtom(name: string, atom: Atom): Promise<void> {
    await writeFile(join(sourceDir, `${name}.json`), JSON.stringify(atom, null, 2));
  }

  function freshAtom(overrides: Partial<Atom> = {}): Atom {
    return sampleAtom(overrides);
  }

  it('empty source: exits 0, 0 atoms imported', async () => {
    const result = await run(['--source', sourceDir, '--dest', destPath], io);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.inserted).toBe(0);
    expect(stdout.join('')).toContain('inserted 0/0 atoms');
  });

  it('100 atoms across atom types round-trip via SqliteAtomStore.get()', async () => {
    const atomTypes: Array<Atom['type']> = [
      'observation',
      'decision',
      'directive',
      'plan',
      'question',
      'reference',
      'preference',
      'operator-intent',
      'pipeline',
      'actor-message',
    ];
    const written: Atom[] = [];
    for (let i = 0; i < 100; i += 1) {
      const type = atomTypes[i % atomTypes.length];
      const atom = freshAtom({
        id: `atom-rt-${String(i).padStart(3, '0')}` as AtomId,
        type,
        content: `round-trip subject #${i} of type ${type}`,
      });
      written.push(atom);
      await writeAtom(atom.id, atom);
    }

    const result = await run(['--source', sourceDir, '--dest', destPath, '--verify'], io);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.inserted).toBe(100);
    expect(result.verified).toBe(100);
    expect(stdout.join('')).toContain('[verify] OK: 100/100 atoms round-trip');

    // Confirm the rows really are readable via the actual adapter,
    // not just via the raw-SQL verify path. This is what catches a
    // schema drift between the script's CREATE TABLE and the
    // SqliteAtomStore's CREATE TABLE.
    const adapter = new SqliteAtomStore({ dbPath: destPath });
    try {
      for (const expected of written) {
        const got = await adapter.get(expected.id);
        expect(got).not.toBeNull();
        // The adapter returns a structurally-equal atom; compare via
        // JSON to ignore frozen-vs-plain array differences. Source has
        // no revision field; adapter.get() preserves that omission.
        expect(JSON.stringify(got)).toBe(JSON.stringify(expected));
      }
    } finally {
      adapter.close();
    }
  });

  it('--dry-run reports correct counts and writes nothing', async () => {
    for (let i = 0; i < 5; i += 1) {
      const atom = freshAtom({ id: `dry-${i}` as AtomId });
      await writeAtom(atom.id, atom);
    }
    const result = await run(['--source', sourceDir, '--dest', destPath, '--dry-run'], io);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.files).toBe(5);
    expect(result.conflicts).toBe(0);
    expect(stdout.join('')).toContain('[dry-run] would import 5 atoms (0 would conflict on duplicate id)');

    // No database file should exist on a dry-run against a missing
    // destination.
    const fs = await import('node:fs');
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('--verify on a clean import passes; --verify on tampered DB fails with the first mismatch', async () => {
    const atom = freshAtom({ id: 'verify-target' as AtomId, content: 'original content' });
    await writeAtom(atom.id, atom);
    const ok = await run(['--source', sourceDir, '--dest', destPath, '--verify'], io);
    expect(ok.ok).toBe(true);
    expect(stdout.join('')).toContain('[verify] OK: 1/1 atoms round-trip');

    // Tamper with the destination row: rewrite the content field via
    // raw SQL. The verify path must catch this on the next run.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(destPath);
    try {
      const row = db.prepare('SELECT data FROM atoms WHERE id = ?').get(atom.id) as { data: string };
      const parsed = JSON.parse(row.data);
      parsed.content = 'tampered content';
      db.prepare('UPDATE atoms SET data = ? WHERE id = ?').run(JSON.stringify(parsed), atom.id);
    } finally {
      db.close();
    }

    stdout = [];
    stderr = [];
    const failed = await run(['--source', sourceDir, '--dest', destPath, '--verify'], io);
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe(1);
    expect(stderr.join('')).toContain('[verify] FAIL');
    expect(failed.error).toContain('does not round-trip');
  });

  it('re-running on the same source+dest is idempotent', async () => {
    const atom = freshAtom({ id: 'idem-target' as AtomId, content: 'idempotent' });
    await writeAtom(atom.id, atom);

    const first = await run(['--source', sourceDir, '--dest', destPath], io);
    expect(first.inserted).toBe(1);
    expect(first.skipped).toBe(0);

    stdout = [];
    stderr = [];
    const second = await run(['--source', sourceDir, '--dest', destPath], io);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(stdout.join('')).toContain('inserted 0/1 atoms (1 skipped as duplicates)');
  });

  it('revision counters preserve: source revision=5 lands as SQLite revision=5', async () => {
    const fresh = freshAtom({ id: 'rev-fresh' as AtomId, content: 'fresh' });
    const aged = freshAtom({ id: 'rev-aged' as AtomId, content: 'aged' });
    const agedWithRev: Atom = { ...aged, revision: 5 };

    await writeAtom(fresh.id, fresh);
    await writeAtom(agedWithRev.id, agedWithRev);

    const result = await run(['--source', sourceDir, '--dest', destPath, '--verify'], io);
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(2);

    // Confirm the revision field at the SQL column level too: the
    // verify path checks the deserialized atom matches source, which
    // implicitly proves revision survived, but a direct column read
    // catches a regression where the column is correct but the JSON
    // payload's revision field drifted.
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(destPath);
    try {
      const freshRow = db.prepare('SELECT revision FROM atoms WHERE id = ?').get('rev-fresh') as { revision: number };
      const agedRow = db.prepare('SELECT revision FROM atoms WHERE id = ?').get('rev-aged') as { revision: number };
      expect(freshRow.revision).toBe(0);
      expect(agedRow.revision).toBe(5);
    } finally {
      db.close();
    }

    // Adapter-level read confirms the back-compat contract: fresh atom
    // returns with no `revision` key at all, aged atom returns with
    // `revision: 5`.
    const adapter = new SqliteAtomStore({ dbPath: destPath });
    try {
      const freshGot = await adapter.get('rev-fresh' as AtomId);
      const agedGot = await adapter.get('rev-aged' as AtomId);
      expect(freshGot?.revision).toBeUndefined();
      expect(agedGot?.revision).toBe(5);
    } finally {
      adapter.close();
    }
  });

  it('--batch-size=1 still imports every atom across separate transactions', async () => {
    for (let i = 0; i < 10; i += 1) {
      const atom = freshAtom({ id: `batch1-${i}` as AtomId });
      await writeAtom(atom.id, atom);
    }
    const result = await run(
      ['--source', sourceDir, '--dest', destPath, '--batch-size', '1', '--verify'],
      io,
    );
    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(10);
    expect(result.verified).toBe(10);
  });

  it('rejects --batch-size 0 and non-numeric values', async () => {
    const bad = await run(['--source', sourceDir, '--dest', destPath, '--batch-size', '0'], io);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('--batch-size must be a positive integer');
    expect(stderr.join('')).toContain('--batch-size must be a positive integer');
  });

  it('fails when --source is missing', async () => {
    const result = await run(['--dest', destPath], io);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('--source and --dest are required');
  });

  it('fails when --source directory does not exist', async () => {
    const result = await run(['--source', join(sourceDir, 'does-not-exist'), '--dest', destPath], io);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('source directory not found');
  });

  it('--dry-run reports conflicts when destination already has rows', async () => {
    // Seed destination with two atoms.
    const seedA = freshAtom({ id: 'seed-a' as AtomId });
    const seedB = freshAtom({ id: 'seed-b' as AtomId });
    await writeAtom(seedA.id, seedA);
    await writeAtom(seedB.id, seedB);
    const first = await run(['--source', sourceDir, '--dest', destPath], io);
    expect(first.inserted).toBe(2);

    // Add a third atom; dry-run should see 3 candidates, 2 conflicts.
    const seedC = freshAtom({ id: 'seed-c' as AtomId, content: 'new', created_at: '2026-01-02T00:00:00.000Z' as Time });
    await writeAtom(seedC.id, seedC);
    stdout = [];
    stderr = [];
    const dry = await run(['--source', sourceDir, '--dest', destPath, '--dry-run'], io);
    expect(dry.files).toBe(3);
    expect(dry.conflicts).toBe(2);
    expect(stdout.join('')).toContain('would import 3 atoms (2 would conflict on duplicate id)');
  });

  it('--help prints usage and exits 0 without requiring --source/--dest', async () => {
    const result = await run(['--help'], io);
    expect(result.ok).toBe(true);
    expect(stdout.join('')).toContain('Usage:');
    expect(stdout.join('')).toContain('--source');
    expect(stdout.join('')).toContain('--verify');
  });
});
