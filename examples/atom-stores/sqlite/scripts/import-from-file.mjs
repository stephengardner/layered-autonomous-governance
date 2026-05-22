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
 * The implementation lives in `lib/import-from-file.mjs` (shebang-free
 * so the regression suite can import it from a `.ts` spec under
 * vitest; the shebang on this wrapper would otherwise trip vitest's
 * esbuild on Windows). The wrapper is the executable entrypoint; the
 * lib module is the import surface.
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
import { run } from './lib/import-from-file.mjs';

run(process.argv.slice(2)).then((result) => {
  process.exit(result.code);
}).catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
