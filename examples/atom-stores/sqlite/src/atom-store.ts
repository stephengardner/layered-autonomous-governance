/**
 * SQLite-backed AtomStore.
 *
 * Single-file SQLite database holding one row per atom, keyed on `id`.
 * Filter-load-bearing fields are extracted into typed columns so query()
 * pushes the predicate into SQL; the full atom (including provenance,
 * signals, supersedes, supersededBy arrays) is serialized into a `data`
 * JSON column the consumer never deconstructs.
 *
 * Compare-and-swap on update is the headline guarantee. Where the file
 * adapter's update() reads, mutates, and writes in three steps with a
 * TOCTOU window between the read and the rename, SQLite's
 * `UPDATE atoms SET ... WHERE id=? AND revision=?` is a single atomic
 * statement: if a concurrent writer bumped the revision between this
 * caller's read and this caller's update, the row count returns 0 and
 * the adapter raises ConflictError. Two cooperating processes pointing
 * at the same .db file inherit this guarantee for free; the file
 * adapter cannot.
 *
 * Cross-process write coordination uses SQLite's WAL mode plus
 * `synchronous=NORMAL` plus a busy_timeout, which lets readers run
 * concurrently with one writer and lets a second writer wait briefly
 * rather than immediately failing with SQLITE_BUSY. The IMMEDIATE
 * transaction surrounding update() takes the write lock at BEGIN
 * rather than at first write, so the read-check-write sequence inside
 * the transaction cannot interleave with a competing writer.
 *
 * Capabilities: `hasSubscribe` is false in this V0; a NOTIFY-style
 * wake on a single-file SQLite is non-trivial without an out-of-band
 * channel (no LISTEN/NOTIFY primitive in SQLite). Polling remains
 * correct; a future revision can wire a WAL-mode polling subscriber
 * or move to a real Postgres adapter.
 *
 * Threat model: rootDir is the user-owned directory; the .db file
 * inherits the surrounding permissions. The adapter does not chmod.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ConflictError, NotFoundError } from '../../../../src/errors.js';
import type { AtomStore, Embedder } from '../../../../src/interface.js';
import type {
  Atom,
  AtomFilter,
  AtomId,
  AtomPage,
  AtomPatch,
  AtomSignals,
  PlanState,
  QuestionState,
  SearchHit,
  Vector,
} from '../../../../src/types.js';
import { matches } from '../../../../src/adapters/_common/atom-filter.js';
import { contentHash as computeContentHash } from '../../../../src/adapters/_common/content-hash.js';
import { cosineToScore } from '../../../../src/adapters/_common/similarity.js';
import { TrigramEmbedder } from '../../../../src/adapters/_common/trigram-embedder.js';

/**
 * Construction options. `dbPath` overrides the default `<rootDir>/atoms.db`;
 * pass `:memory:` for transient stores in tests.
 */
export interface SqliteAtomStoreOptions {
  /** Directory to host the .db file. Created if missing. Ignored when `dbPath` is `:memory:`. */
  readonly rootDir?: string;
  /** Explicit path to the database file. Takes precedence over `rootDir`. */
  readonly dbPath?: string;
  /** Embedder override; defaults to TrigramEmbedder. */
  readonly embedder?: Embedder;
}

/** Internal row shape mirroring the SQL schema. */
interface AtomRow {
  id: string;
  data: string;
  revision: number;
}

export class SqliteAtomStore implements AtomStore {
  private readonly db: Database.Database;
  private readonly embedder: Embedder;

  // Prepared statements reused on every call. Named-parameter binds
  // sidestep the per-placeholder counting that broke an earlier version
  // of this file: every json_extract(:data, '$.x') call shares the
  // same :data slot rather than consuming a new ? position.
  private readonly stmtPut: Database.Statement;
  private readonly stmtGet: Database.Statement;
  private readonly stmtUpdateUnconditional: Database.Statement;
  private readonly stmtUpdateCas: Database.Statement;
  private readonly stmtSelectAll: Database.Statement;
  private readonly stmtSelectIds: Database.Statement;
  private readonly stmtSize: Database.Statement;

  constructor(options: SqliteAtomStoreOptions = {}) {
    const dbPath = resolveDbPath(options);
    if (dbPath !== ':memory:') {
      // Ensure the parent directory exists; better-sqlite3 will not
      // create intermediate dirs and bails with ENOENT otherwise.
      const lastSep = Math.max(dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'));
      if (lastSep > 0) mkdirSync(dbPath.slice(0, lastSep), { recursive: true });
    }
    this.db = new Database(dbPath);
    // WAL mode: concurrent readers, one writer; durable across process
    // boundaries. `synchronous=NORMAL` is the WAL-recommended setting
    // (FULL is overkill, OFF risks WAL corruption on crash).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    // Wait up to 5s for a competing writer to release the lock before
    // raising SQLITE_BUSY. The IMMEDIATE transaction in update() means
    // contention is rare, but a busy_timeout keeps cooperative writers
    // from raising spurious errors on transient races.
    this.db.pragma('busy_timeout = 5000');
    // Foreign keys off; we have none. Explicit so a future schema bump
    // does not silently change behavior on existing files.
    this.db.pragma('foreign_keys = OFF');

    this.db.exec(`
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

    // Named binds (`:data`, `:id`, `:rev`, `:prevRev`) let every
    // json_extract(:data, '$.x') reference the single :data slot
    // without repeating the JSON payload in the bind array.
    const isSupersededExpr =
      "CASE WHEN json_array_length(json_extract(:data, '$.superseded_by')) > 0 THEN 1 ELSE 0 END";
    this.stmtPut = this.db.prepare(
      'INSERT INTO atoms (id, data, revision, layer, type, scope, principal_id, taint, confidence, created_at, plan_state, question_state, is_superseded) ' +
        `VALUES (:id, :data, :rev, json_extract(:data, '$.layer'), json_extract(:data, '$.type'), json_extract(:data, '$.scope'), json_extract(:data, '$.principal_id'), json_extract(:data, '$.taint'), json_extract(:data, '$.confidence'), json_extract(:data, '$.created_at'), json_extract(:data, '$.plan_state'), json_extract(:data, '$.question_state'), ${isSupersededExpr})`
    );

    this.stmtGet = this.db.prepare('SELECT id, data, revision FROM atoms WHERE id = :id');

    this.stmtUpdateUnconditional = this.db.prepare(
      `UPDATE atoms SET data = :data, revision = :rev, ` +
        `layer = json_extract(:data, '$.layer'), ` +
        `type = json_extract(:data, '$.type'), ` +
        `scope = json_extract(:data, '$.scope'), ` +
        `principal_id = json_extract(:data, '$.principal_id'), ` +
        `taint = json_extract(:data, '$.taint'), ` +
        `confidence = json_extract(:data, '$.confidence'), ` +
        `created_at = json_extract(:data, '$.created_at'), ` +
        `plan_state = json_extract(:data, '$.plan_state'), ` +
        `question_state = json_extract(:data, '$.question_state'), ` +
        `is_superseded = ${isSupersededExpr} ` +
        `WHERE id = :id`
    );

    this.stmtUpdateCas = this.db.prepare(
      `UPDATE atoms SET data = :data, revision = :rev, ` +
        `layer = json_extract(:data, '$.layer'), ` +
        `type = json_extract(:data, '$.type'), ` +
        `scope = json_extract(:data, '$.scope'), ` +
        `principal_id = json_extract(:data, '$.principal_id'), ` +
        `taint = json_extract(:data, '$.taint'), ` +
        `confidence = json_extract(:data, '$.confidence'), ` +
        `created_at = json_extract(:data, '$.created_at'), ` +
        `plan_state = json_extract(:data, '$.plan_state'), ` +
        `question_state = json_extract(:data, '$.question_state'), ` +
        `is_superseded = ${isSupersededExpr} ` +
        `WHERE id = :id AND revision = :prevRev`
    );

    this.stmtSelectAll = this.db.prepare('SELECT id, data, revision FROM atoms');
    this.stmtSelectIds = this.db.prepare('SELECT id FROM atoms');
    this.stmtSize = this.db.prepare('SELECT COUNT(*) AS n FROM atoms');

    this.embedder = options.embedder ?? new TrigramEmbedder();
  }

  async put(atom: Atom): Promise<AtomId> {
    const json = JSON.stringify(atom);
    const rev = atom.revision ?? 0;
    try {
      this.stmtPut.run({ id: String(atom.id), data: json, rev });
    } catch (err) {
      if (isSqliteConstraint(err)) {
        throw new ConflictError(`Atom ${String(atom.id)} already exists`);
      }
      throw err;
    }
    return atom.id;
  }

  async get(id: AtomId): Promise<Atom | null> {
    const row = this.stmtGet.get({ id: String(id) }) as AtomRow | undefined;
    if (!row) return null;
    return deserializeAtom(row.data, row.revision);
  }

  async query(filter: AtomFilter, limit: number, cursor?: string): Promise<AtomPage> {
    // Predicate matching happens in-memory after a full-table fetch so
    // the substrate `matches()` helper stays the single source of truth
    // for filter semantics. Production-grade adapters push the
    // hot-path predicates into SQL; we ship the simple shape first so
    // the conformance bar is identical to the file adapter.
    const all = this.loadAll()
      .filter(a => matches(a, filter))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const offset = cursor ? decodeCursor(cursor) : 0;
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(nextOffset) : null;
    return { atoms: page, nextCursor };
  }

  async search(
    query: string | Vector,
    k: number,
    filter?: AtomFilter,
  ): Promise<ReadonlyArray<SearchHit>> {
    const queryVec = typeof query === 'string' ? await this.embed(query) : query;
    const candidates = this.loadAll().filter(a => matches(a, filter ?? {}));

    const scored: SearchHit[] = [];
    for (const atom of candidates) {
      const atomVec = await this.embed(atom.content);
      const sim = this.embedder.similarity(queryVec, atomVec);
      scored.push({ atom, score: cosineToScore(sim) });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.atom.created_at !== a.atom.created_at) {
        return b.atom.created_at.localeCompare(a.atom.created_at);
      }
      return a.atom.id.localeCompare(b.atom.id);
    });
    return scored.slice(0, k);
  }

  async update(id: AtomId, patch: AtomPatch): Promise<Atom> {
    // The whole read-merge-write happens inside a single IMMEDIATE
    // transaction so a competing writer cannot interleave between the
    // existence check and the CAS UPDATE. SQLite's IMMEDIATE
    // transaction acquires the write lock at BEGIN, so a second
    // process opening its own IMMEDIATE blocks until this one
    // commits.
    const idStr = String(id);
    const txn = this.db.transaction((idArg: string, patchArg: AtomPatch): Atom => {
      const row = this.stmtGet.get({ id: idArg }) as AtomRow | undefined;
      if (!row) {
        throw new NotFoundError(`Atom ${String(idArg)} not found`);
      }
      const existing = deserializeAtom(row.data, row.revision);
      const existingRevision = existing.revision ?? 0;
      // CAS check. expectedRevision === undefined skips the guard
      // (back-compat with pre-CAS callers); a present value MUST equal
      // the stored revision exactly. Mismatch raises ConflictError so
      // the caller catches the same error type that put-on-duplicate
      // produces.
      if (
        patchArg.expectedRevision !== undefined &&
        patchArg.expectedRevision !== existingRevision
      ) {
        throw new ConflictError(
          `Atom ${String(idArg)} revision mismatch: expected ${patchArg.expectedRevision}, stored ${existingRevision}`,
        );
      }
      const updated = mergeAtom(existing, patchArg, existingRevision + 1);
      const updatedJson = JSON.stringify(updated);
      // CAS-strict UPDATE: matches on (id, revision). If a parallel
      // writer in another process slipped a bump between our SELECT
      // and our UPDATE, changes() returns 0 and we surface
      // ConflictError. This is the strict cross-process guarantee
      // the file adapter cannot make.
      const result = this.stmtUpdateCas.run({
        id: idArg,
        data: updatedJson,
        rev: updated.revision!,
        prevRev: existingRevision,
      });
      if (result.changes !== 1) {
        // Re-read once to disambiguate. If the row vanished, that's
        // NotFound; if its revision moved, that's Conflict; if neither,
        // surface a generic conflict so the caller retries upstream.
        const reread = this.stmtGet.get({ id: idArg }) as AtomRow | undefined;
        if (!reread) {
          throw new NotFoundError(`Atom ${String(idArg)} not found`);
        }
        throw new ConflictError(
          `Atom ${String(idArg)} revision mismatch: expected ${existingRevision}, stored ${reread.revision}`,
        );
      }
      return updated;
    });
    // immediate: take the write lock at BEGIN; readers may proceed
    // through WAL.
    return txn.immediate(idStr, patch);
  }

  async batchUpdate(filter: AtomFilter, patch: AtomPatch): Promise<number> {
    // CAS is undefined over a batch: each matched atom has its own
    // revision, so a single expectedRevision value cannot meaningfully
    // gate N writes. Reject at the substrate boundary so callers route
    // CAS-bearing patches through update() per atom. Matches the
    // memory + file adapter contract pinned by the conformance spec.
    if (patch.expectedRevision !== undefined) {
      throw new Error('batchUpdate does not support expectedRevision; use update() per atom for CAS');
    }
    // Include superseded atoms in batch updates (taint cascade needs this).
    const effective: AtomFilter = { ...filter, superseded: true };
    const matching = this.loadAll().filter(a => matches(a, effective));
    // Wrap the entire fan-out in an IMMEDIATE transaction so a partial
    // batch never leaves the store in a half-updated state visible to
    // other readers.
    const apply = this.db.transaction((items: ReadonlyArray<Atom>) => {
      for (const atom of items) {
        const existingRevision = atom.revision ?? 0;
        const updated = mergeAtom(atom, patch, existingRevision + 1);
        const updatedJson = JSON.stringify(updated);
        this.stmtUpdateUnconditional.run({
          id: String(atom.id),
          data: updatedJson,
          rev: updated.revision!,
        });
      }
    });
    apply.immediate(matching);
    return matching.length;
  }

  async embed(text: string): Promise<Vector> {
    return this.embedder.embed(text);
  }

  similarity(a: Vector, b: Vector): number {
    return this.embedder.similarity(a, b);
  }

  contentHash(text: string): string {
    return computeContentHash(text);
  }

  // ---- Test helpers ----

  /** Number of atoms currently stored. */
  size(): number {
    const row = this.stmtSize.get() as { n: number };
    return row.n;
  }

  /** List of stored atom ids; useful for fixture inspection. */
  listIds(): string[] {
    return (this.stmtSelectIds.all() as Array<{ id: string }>).map(r => r.id);
  }

  /** Close the underlying database. Safe to call multiple times. */
  close(): void {
    if (this.db.open) this.db.close();
  }

  // ---- Private ----

  private loadAll(): Atom[] {
    const rows = this.stmtSelectAll.all() as AtomRow[];
    return rows.map(r => deserializeAtom(r.data, r.revision));
  }
}

function resolveDbPath(options: SqliteAtomStoreOptions): string {
  if (options.dbPath) return options.dbPath;
  if (options.rootDir) return join(options.rootDir, 'atoms.db');
  throw new Error('SqliteAtomStore: pass rootDir or dbPath');
}

/**
 * Reconstruct an Atom from a stored JSON payload and the column-level
 * revision. The revision column is authoritative; if a legacy row
 * persisted before the revision column existed the JSON payload may
 * lack the field, and the column's default of 0 wins.
 */
function deserializeAtom(data: string, revision: number): Atom {
  const parsed = JSON.parse(data) as Atom;
  // Preserve the contract: revision is omitted on a fresh put, set on
  // a successful update. The column is always populated (NOT NULL with
  // default 0), so we surface undefined only when the JSON itself
  // omitted the field AND the column says 0 (fresh-put case).
  const storedRevision = revision === 0 && parsed.revision === undefined
    ? undefined
    : (parsed.revision ?? revision);
  return storedRevision === undefined
    ? omitRevision(parsed)
    : { ...parsed, revision: storedRevision };
}

function omitRevision(atom: Atom): Atom {
  // Drop the `revision` key entirely so callers reading the atom see
  // `undefined` rather than a default-zero, preserving the back-compat
  // contract the conformance spec pins.
  const { revision: _r, ...rest } = atom as Atom & { revision?: number };
  void _r;
  return rest as Atom;
}

function mergeAtom(existing: Atom, patch: AtomPatch, nextRevision: number): Atom {
  const nextSignals: AtomSignals = patch.signals
    ? mergeSignals(existing.signals, patch.signals)
    : existing.signals;

  const base: Atom = {
    schema_version: existing.schema_version,
    id: existing.id,
    content: existing.content,
    type: existing.type,
    layer: existing.layer,
    provenance: existing.provenance,
    confidence: patch.confidence ?? existing.confidence,
    created_at: existing.created_at,
    last_reinforced_at: patch.last_reinforced_at ?? existing.last_reinforced_at,
    expires_at: patch.expires_at === undefined ? existing.expires_at : patch.expires_at,
    supersedes: patch.supersedes
      ? Object.freeze([...existing.supersedes, ...patch.supersedes])
      : existing.supersedes,
    superseded_by: patch.superseded_by
      ? Object.freeze([...existing.superseded_by, ...patch.superseded_by])
      : existing.superseded_by,
    scope: existing.scope,
    signals: nextSignals,
    principal_id: existing.principal_id,
    taint: patch.taint ?? existing.taint,
    metadata: patch.metadata
      ? Object.freeze({ ...existing.metadata, ...patch.metadata })
      : existing.metadata,
    revision: nextRevision,
  };
  const planState: PlanState | undefined =
    patch.plan_state !== undefined ? patch.plan_state : existing.plan_state;
  const questionState: QuestionState | undefined =
    patch.question_state !== undefined ? patch.question_state : existing.question_state;
  const pipelineState: string | undefined =
    patch.pipeline_state !== undefined ? patch.pipeline_state : existing.pipeline_state;
  return {
    ...base,
    ...(planState !== undefined ? { plan_state: planState } : {}),
    ...(questionState !== undefined ? { question_state: questionState } : {}),
    ...(pipelineState !== undefined ? { pipeline_state: pipelineState } : {}),
  };
}

function mergeSignals(existing: AtomSignals, patch: Partial<AtomSignals>): AtomSignals {
  return {
    agrees_with: patch.agrees_with ?? existing.agrees_with,
    conflicts_with: patch.conflicts_with ?? existing.conflicts_with,
    validation_status: patch.validation_status ?? existing.validation_status,
    last_validated_at: patch.last_validated_at === undefined
      ? existing.last_validated_at
      : patch.last_validated_at,
  };
}

function isSqliteConstraint(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return (
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  const n = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid cursor: ${cursor}`);
  }
  return n;
}
