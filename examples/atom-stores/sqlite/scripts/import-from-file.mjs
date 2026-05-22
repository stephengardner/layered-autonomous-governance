#!/usr/bin/env node
/**
 * FileAtomStore -> SqliteAtomStore migration tool.
 *
 * Reads every `*.json` atom under `<source>/` and bulk-inserts each row
 * into a SQLite `.db` file using the same schema the SqliteAtomStore
 * adapter creates. The destination database is byte-compatible with a
 * `new SqliteAtomStore({ dbPath })` open on the same file: the same
 * indexes, the same column extraction expressions, the same revision
 * column semantics.
 *
 * Revision counters are preserved as-is. An atom written by the file
 * adapter with `revision: 5` lands in SQLite with `revision = 5`; an
 * atom written before the revision field existed (no `revision` key in
 * the JSON) lands with the column default of 0, which matches the
 * SqliteAtomStore.put() contract for fresh atoms.
 *
 * Why this script reads JSON and writes SQL directly instead of using
 * the SqliteAtomStore class: the adapter is TypeScript, and a `.mjs`
 * script cannot `import()` a `.ts` file under Node ESM without a
 * loader. Re-implementing the put statement here keeps the migration
 * tool independent of the TypeScript build and means a solo developer
 * can run it without running `npm run build` first. The schema is
 * mirrored verbatim from `src/atom-store.ts`; a regression test in
 * `test/import-from-file.test.ts` round-trips through the actual
 * SqliteAtomStore.get() so drift between the two is caught
 * mechanically.
 *
 * Usage:
 *
 *   node examples/atom-stores/sqlite/scripts/import-from-file.mjs \
 *     --source ./.lag/atoms \
 *     --dest   ./.lag/atoms.db
 *
 *   # Preview only, no writes:
 *   node ... --source <dir> --dest <db> --dry-run
 *
 *   # Round-trip every atom through SQLite read after import:
 *   node ... --source <dir> --dest <db> --verify
 *
 *   # Tune transaction batch size (default 100):
 *   node ... --source <dir> --dest <db> --batch-size 500
 *
 * Exit codes:
 *   0 - import succeeded (or dry-run completed)
 *   1 - fatal error (missing arg, source not found, verify mismatch)
 */
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const DEFAULT_BATCH_SIZE = 100;

function parseArgs(argv) {
  const args = {
    source: undefined,
    dest: undefined,
    dryRun: argv.includes('--dry-run'),
    verify: argv.includes('--verify'),
    batchSize: DEFAULT_BATCH_SIZE,
    help: argv.includes('--help') || argv.includes('-h'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--source' && argv[i + 1]) {
      args.source = argv[i + 1];
      i += 1;
    } else if (flag === '--dest' && argv[i + 1]) {
      args.dest = argv[i + 1];
      i += 1;
    } else if (flag === '--batch-size' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--batch-size must be a positive integer, got ${argv[i + 1]}`);
      }
      args.batchSize = n;
      i += 1;
    }
  }
  return args;
}

function helpText() {
  return (
    'FileAtomStore -> SqliteAtomStore migration tool\n' +
    '\n' +
    'Usage:\n' +
    '  node import-from-file.mjs --source <dir> --dest <path> [options]\n' +
    '\n' +
    'Required:\n' +
    '  --source <dir>      Directory containing one *.json file per atom\n' +
    '                      (typically <rootDir>/atoms).\n' +
    '  --dest   <path>     Destination SQLite database file. Created if\n' +
    '                      missing; parent directory created if missing.\n' +
    '\n' +
    'Options:\n' +
    '  --dry-run           Preview only; no writes.\n' +
    '  --verify            After import, read every atom back via the same\n' +
    '                      adapter schema and assert JSON-deep-equal vs the\n' +
    '                      source file. Reports the first mismatch.\n' +
    '  --batch-size <N>    Transaction batch size for the bulk insert.\n' +
    `                      Default ${DEFAULT_BATCH_SIZE}. Larger is faster\n` +
    '                      at the cost of memory.\n' +
    '  --help, -h          Show this message.\n'
  );
}

/**
 * Open the destination database with the same pragmas and schema the
 * SqliteAtomStore adapter applies on construction. Mirrors the
 * adapter's CREATE TABLE statement verbatim; a drift here is caught by
 * the regression test in `test/import-from-file.test.ts`.
 */
function openDestinationDb(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && dir !== '.' && dir !== '/') {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS atoms (
      id           TEXT PRIMARY KEY NOT NULL,
      data         TEXT NOT NULL,
      revision     INTEGER NOT NULL DEFAULT 0,
      layer        TEXT NOT NULL,
      type         TEXT NOT NULL,
      scope        TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      taint        TEXT NOT NULL,
      confidence   REAL NOT NULL,
      created_at   TEXT NOT NULL,
      plan_state   TEXT,
      question_state TEXT,
      is_superseded INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_atoms_layer ON atoms(layer);
    CREATE INDEX IF NOT EXISTS idx_atoms_type ON atoms(type);
    CREATE INDEX IF NOT EXISTS idx_atoms_principal ON atoms(principal_id);
    CREATE INDEX IF NOT EXISTS idx_atoms_created_at ON atoms(created_at);
    CREATE INDEX IF NOT EXISTS idx_atoms_plan_state ON atoms(plan_state) WHERE plan_state IS NOT NULL;
  `);
  return db;
}

/**
 * List every `*.json` file in the source directory. Sorted so the
 * preview output is deterministic across runs (useful in golden-file
 * tests).
 */
function listAtomFiles(sourceDir) {
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
}

/**
 * Read + parse one atom file. Bubbles up the JSON parse error with the
 * file path attached so the operator finds the culprit quickly.
 */
function readAtomFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${filePath} as JSON: ${reason}`);
  }
}

/**
 * Bulk-import every JSON file under `source` into `db`, in batches of
 * `batchSize`. Uses `INSERT OR IGNORE` so atoms whose id already
 * exists in the destination are skipped; the function returns the
 * count of inserted vs skipped rows so re-runs are observably
 * idempotent.
 */
function importAtoms(db, source, files, batchSize) {
  const isSupersededExpr =
    "CASE WHEN json_array_length(json_extract(:data, '$.superseded_by')) > 0 THEN 1 ELSE 0 END";
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO atoms (id, data, revision, layer, type, scope, principal_id, taint, confidence, created_at, plan_state, question_state, is_superseded) ' +
      `VALUES (:id, :data, :rev, json_extract(:data, '$.layer'), json_extract(:data, '$.type'), json_extract(:data, '$.scope'), json_extract(:data, '$.principal_id'), json_extract(:data, '$.taint'), json_extract(:data, '$.confidence'), json_extract(:data, '$.created_at'), json_extract(:data, '$.plan_state'), json_extract(:data, '$.question_state'), ${isSupersededExpr})`
  );

  const insertBatch = db.transaction((rows) => {
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const result = stmt.run(row);
      if (result.changes === 1) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }
    return { inserted, skipped };
  });

  let totalInserted = 0;
  let totalSkipped = 0;
  let batch = [];
  for (const name of files) {
    const atom = readAtomFile(join(source, name));
    if (typeof atom.id !== 'string') {
      throw new Error(`Atom in ${name} has missing or non-string id`);
    }
    const rev = typeof atom.revision === 'number' ? atom.revision : 0;
    batch.push({ id: atom.id, data: JSON.stringify(atom), rev });
    if (batch.length >= batchSize) {
      const r = insertBatch(batch);
      totalInserted += r.inserted;
      totalSkipped += r.skipped;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const r = insertBatch(batch);
    totalInserted += r.inserted;
    totalSkipped += r.skipped;
  }
  return { inserted: totalInserted, skipped: totalSkipped };
}

/**
 * Count how many source atom ids already exist in the destination DB.
 * Used by --dry-run to report the would-skip count without writing.
 */
function countConflicts(db, source, files) {
  const lookup = db.prepare('SELECT 1 AS one FROM atoms WHERE id = ?');
  let conflicts = 0;
  for (const name of files) {
    const atom = readAtomFile(join(source, name));
    if (typeof atom.id !== 'string') continue;
    if (lookup.get(atom.id)) conflicts += 1;
  }
  return conflicts;
}

/**
 * Round-trip equality check: every source JSON atom is read back from
 * SQLite by id and compared field-by-field via JSON.stringify equality.
 * The revision-field rule mirrors the SqliteAtomStore deserializer:
 * when source omits revision AND the column is 0, the round-tripped
 * atom also omits revision (back-compat with pre-revision atoms).
 *
 * Returns `{ ok: true, count }` on full match, `{ ok: false, reason }`
 * on the first mismatch. The CLI wrapper exits 1 on failure so a CI
 * run surfaces the mismatch loud.
 */
function verifyRoundTrip(db, source, files) {
  const read = db.prepare('SELECT data, revision FROM atoms WHERE id = ?');
  let checked = 0;
  for (const name of files) {
    const sourcePath = join(source, name);
    const sourceAtom = readAtomFile(sourcePath);
    const row = read.get(sourceAtom.id);
    if (!row) {
      return {
        ok: false,
        reason: `Atom ${sourceAtom.id} (from ${name}) is missing in destination`,
      };
    }
    const stored = JSON.parse(row.data);
    // Reconstruct revision the same way SqliteAtomStore.get() does so
    // the comparison matches what a real adapter.get() would return.
    const reconstructed =
      row.revision === 0 && stored.revision === undefined
        ? omitRevision(stored)
        : { ...stored, revision: stored.revision ?? row.revision };
    const a = JSON.stringify(sourceAtom);
    const b = JSON.stringify(reconstructed);
    if (a !== b) {
      return {
        ok: false,
        reason: `Atom ${sourceAtom.id} (from ${name}) does not round-trip:\n  source:      ${a}\n  destination: ${b}`,
      };
    }
    checked += 1;
  }
  return { ok: true, count: checked };
}

function omitRevision(atom) {
  const copy = { ...atom };
  delete copy.revision;
  return copy;
}

/**
 * Library-friendly entry point. Returns a `RunResult` instead of
 * calling `process.exit` so tests can drive the function and assert on
 * the outcome. `io` lets the test capture stdout / stderr lines without
 * touching the real streams.
 *
 * RunResult shape:
 *   { ok: true,  code: 0, args }
 *   { ok: false, code: 1, error: string, args? }
 */
async function run(argv, io = defaultIo()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`error: ${message}\n`);
    return { ok: false, code: 1, error: message };
  }

  if (args.help) {
    io.stdout(helpText());
    return { ok: true, code: 0, args };
  }
  if (!args.source || !args.dest) {
    const message = '--source and --dest are required (see --help)';
    io.stderr(`error: ${message}\n`);
    return { ok: false, code: 1, error: message, args };
  }
  if (!existsSync(args.source)) {
    const message = `source directory not found: ${args.source}`;
    io.stderr(`error: ${message}\n`);
    return { ok: false, code: 1, error: message, args };
  }

  const files = listAtomFiles(args.source);

  if (args.dryRun) {
    let conflicts = 0;
    if (existsSync(args.dest)) {
      const db = openDestinationDb(args.dest);
      try {
        conflicts = countConflicts(db, args.source, files);
      } finally {
        db.close();
      }
    }
    io.stdout(
      `[dry-run] would import ${files.length} atoms (${conflicts} would conflict on duplicate id)\n`
    );
    return { ok: true, code: 0, args, files: files.length, conflicts };
  }

  const db = openDestinationDb(args.dest);
  let summary;
  try {
    const { inserted, skipped } = importAtoms(db, args.source, files, args.batchSize);
    io.stdout(
      `[import] inserted ${inserted}/${files.length} atoms (${skipped} skipped as duplicates)\n`
    );
    summary = { inserted, skipped };

    if (args.verify) {
      const result = verifyRoundTrip(db, args.source, files);
      if (!result.ok) {
        io.stderr(`[verify] FAIL: ${result.reason}\n`);
        return { ok: false, code: 1, error: result.reason, args, ...summary };
      }
      io.stdout(`[verify] OK: ${result.count}/${files.length} atoms round-trip\n`);
      summary.verified = result.count;
    }
  } finally {
    db.close();
  }
  return { ok: true, code: 0, args, ...summary };
}

function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

/**
 * Direct-invocation guard. Returns true when this module is run as the
 * script Node was started with (e.g. `node import-from-file.mjs ...`)
 * and false when it is imported by another module (e.g. the test
 * suite). Resolves `process.argv[1]` to a `file://` URL so the
 * comparison survives Windows-vs-POSIX path separators.
 */
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  run(process.argv.slice(2)).then((result) => {
    process.exit(result.code);
  }).catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exit(1);
  });
}

export {
  run,
  parseArgs,
  helpText,
  openDestinationDb,
  importAtoms,
  countConflicts,
  verifyRoundTrip,
  listAtomFiles,
};
