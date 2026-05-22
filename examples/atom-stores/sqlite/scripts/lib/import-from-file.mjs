/**
 * FileAtomStore -> SqliteAtomStore migration tool (library).
 *
 * Shebang-free so the test suite can import this file from a `.ts`
 * spec under vitest. The CLI wrapper at
 * `scripts/import-from-file.mjs` re-exports `run()` from here and adds
 * the `#!/usr/bin/env node` shebang plus the direct-invocation guard.
 *
 * See the wrapper for full usage docs.
 */
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

export const DEFAULT_BATCH_SIZE = 100;

export function parseArgs(argv) {
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
      // Strict canonical-integer regex. Number.parseInt would silently
      // accept '1.5' (-> 1) and '10foo' (-> 10), breaking the
      // "positive integer" contract. /^[1-9]\d*$/ rejects leading
      // zeros, decimals, and trailing garbage.
      const raw = argv[i + 1];
      if (!/^[1-9]\d*$/.test(raw)) {
        throw new Error(`--batch-size must be a positive integer, got ${raw}`);
      }
      args.batchSize = Number(raw);
      i += 1;
    }
  }
  return args;
}

export function helpText() {
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
export function openDestinationDb(dbPath) {
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
export function listAtomFiles(sourceDir) {
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
export function readAtomFile(filePath) {
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
export function importAtoms(db, source, files, batchSize) {
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
export function countConflicts(db, source, files) {
  const lookup = db.prepare('SELECT 1 AS one FROM atoms WHERE id = ?');
  let conflicts = 0;
  for (const name of files) {
    const atom = readAtomFile(join(source, name));
    // Match importAtoms semantics: a malformed atom is a fatal input,
    // not a silent skip. The dry-run must fail on the same files the
    // real import would fail on, otherwise the preview lies about what
    // the destination will look like.
    if (typeof atom.id !== 'string') {
      throw new Error(`Atom in ${name} has missing or non-string id`);
    }
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
export function verifyRoundTrip(db, source, files) {
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
export async function run(argv, io = defaultIo()) {
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

  // Normalize every runtime failure into a RunResult so the CLI never
  // surfaces a raw stack trace and tests can assert on `error` instead
  // of catching a thrown promise. Failures from listAtomFiles,
  // openDestinationDb, importAtoms, and verifyRoundTrip all funnel
  // through this catch.
  try {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`error: ${message}\n`);
    return { ok: false, code: 1, error: message, args };
  }
}

export function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
