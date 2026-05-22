# SqliteAtomStore (reference adapter)

A SQLite-backed `AtomStore` implementation that gives you strict
cross-process compare-and-swap on `update()`. Pick this over the
default file adapter when:

- Multiple OS processes write to the same atom store, AND you need a
  guarantee that a CAS-bearing `update()` either lands or rejects;
  the file adapter's CAS is best-effort (TOCTOU window between read
  and rename), this one is strict.
- Atom count grows past the file adapter's comfortable range (every
  query reads every JSON file from disk); a single `.db` file with
  indexed columns scales further.
- You want WAL-mode durability semantics without standing up a real
  database server.

## Install

```bash
npm install better-sqlite3
```

`better-sqlite3` is declared as a peer dependency; the adapter does
not bundle it so you control the native build.

## Usage

```ts
import { SqliteAtomStore } from './src/index.js';

// File-backed: data persists at <rootDir>/atoms.db.
const atoms = new SqliteAtomStore({ rootDir: './my-lag-dir' });

// Or in-memory for tests.
const transient = new SqliteAtomStore({ dbPath: ':memory:' });

// CAS update: read, decide, write back with expectedRevision.
const existing = await atoms.get(planId);
if (existing) {
  await atoms.update(planId, {
    plan_state: 'approved',
    expectedRevision: existing.revision ?? 0,
  });
}

atoms.close();
```

## What you get

- `put()` uses SQLite's `PRIMARY KEY` constraint; a duplicate id
  produces `ConflictError` atomically.
- `update()` runs inside an `IMMEDIATE` transaction with a single
  `UPDATE ... WHERE id = ? AND revision = ?` statement. A competing
  writer in another process that bumped the revision between your
  `get()` and `update()` triggers `ConflictError`. This is the
  strict guarantee you cannot get from the file adapter.
- `batchUpdate()` rejects `expectedRevision` per the substrate
  contract (CAS is undefined over a batch).
- WAL mode + 5s `busy_timeout` lets cooperative writers wait
  briefly rather than fail with `SQLITE_BUSY`.

## What this doesn't yet do

- `subscribe()` is not implemented; `capabilities?.hasSubscribe` is
  undefined. SQLite has no `LISTEN/NOTIFY` primitive; a future
  revision could add a WAL-polling subscriber.
- Filter predicates run in memory after a `SELECT *` fetch so the
  shared `matches()` helper remains the single source of truth for
  filter semantics. A production-grade adapter would push hot-path
  predicates into SQL.
- No GC. Atoms are immutable on `put()`; the substrate has no
  deletion verb.

## Tests

Two suites:

- `test/sqlite-adapter.test.ts` runs the shared `runAtomsSpec` so the
  adapter satisfies the same conformance contract as the memory + file
  adapters.
- `test/concurrent-cas.test.ts` proves the cross-process CAS
  guarantee: `N=50` concurrent updates with the same
  `expectedRevision` produce exactly one winner and `N-1`
  `ConflictError` rejections, including across separate
  `SqliteAtomStore` instances sharing one `.db` file.
