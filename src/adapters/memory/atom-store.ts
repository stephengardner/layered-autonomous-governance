import { ConflictError, NotFoundError } from '../../errors.js';
import type { AtomStore, Embedder } from '../../interface.js';
import type {
  Atom,
  AtomFilter,
  AtomId,
  AtomPage,
  AtomPatch,
  AtomSignals,
  SearchHit,
  Vector,
} from '../../types.js';
import { matches } from '../_common/atom-filter.js';
import { contentHash as computeContentHash } from '../_common/content-hash.js';
import { cosineToScore } from '../_common/similarity.js';
import { TrigramEmbedder } from '../_common/trigram-embedder.js';

/**
 * In-memory atom store.
 *
 * Deterministic: embedding is pure over content; search ordering is stable
 * given identical inputs. Used by conformance suite and simulation.
 */
export class MemoryAtomStore implements AtomStore {
  // In-memory backing store; CAS check runs synchronously against
  // `this.atoms`, so two writers in the same process interleave
  // safely, but two processes pointing at the same store (impossible
  // here by definition) would not. Declared best-effort to match the
  // contract documented on AtomStoreCapabilities.
  readonly capabilities = { hasSubscribe: false, hasStrictCrossProcessCas: false } as const;
  private readonly atoms = new Map<AtomId, Atom>();
  private readonly embedder: Embedder;

  /**
   * Optional embedder override. If omitted, defaults to TrigramEmbedder
   * (deterministic character-trigram + cosine). Inject an Anthropic /
   * onnx / custom embedder for semantic retrieval.
   */
  constructor(embedder?: Embedder) {
    this.embedder = embedder ?? new TrigramEmbedder();
  }

  async put(atom: Atom): Promise<AtomId> {
    if (this.atoms.has(atom.id)) {
      throw new ConflictError(`Atom ${String(atom.id)} already exists`);
    }
    this.atoms.set(atom.id, atom);
    return atom.id;
  }

  async get(id: AtomId): Promise<Atom | null> {
    return this.atoms.get(id) ?? null;
  }

  async query(filter: AtomFilter, limit: number, cursor?: string): Promise<AtomPage> {
    const offset = cursor ? decodeCursor(cursor) : 0;
    const all = Array.from(this.atoms.values())
      .filter(a => matches(a, filter))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    const effectiveFilter: AtomFilter = filter ?? {};
    const candidates = Array.from(this.atoms.values()).filter(a => matches(a, effectiveFilter));

    const scored: SearchHit[] = [];
    for (const atom of candidates) {
      const atomVec = await this.embed(atom.content);
      const sim = this.embedder.similarity(queryVec, atomVec);
      scored.push({ atom, score: cosineToScore(sim) });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable tiebreak: newer first, then id lex.
      if (b.atom.created_at !== a.atom.created_at) {
        return b.atom.created_at.localeCompare(a.atom.created_at);
      }
      return a.atom.id.localeCompare(b.atom.id);
    });
    return scored.slice(0, k);
  }

  async update(id: AtomId, patch: AtomPatch): Promise<Atom> {
    const existing = this.atoms.get(id);
    if (!existing) {
      throw new NotFoundError(`Atom ${String(id)} not found`);
    }
    // Compare-and-swap guard. When expectedRevision is omitted, the
    // update proceeds unconditionally (back-compat). When present,
    // the stored revision must match exactly; a mismatch means
    // another writer raced this caller and the read-modify-write
    // chain is no longer safe.
    //
    // existing.revision ?? 0: atoms written before the revision
    // field existed are treated as revision 0 (matches the put-time
    // default). ConflictError matches the put-collision shape so
    // callers catch one error type for both write-time races.
    const existingRevision = existing.revision ?? 0;
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== existingRevision) {
      throw new ConflictError(
        `Atom ${String(id)} revision mismatch: expected ${patch.expectedRevision}, stored ${existingRevision}`,
      );
    }
    const nextSignals: AtomSignals = patch.signals
      ? mergeSignals(existing.signals, patch.signals)
      : existing.signals;

    const updated: Atom = {
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
      revision: existingRevision + 1,
      ...(patch.plan_state !== undefined
        ? { plan_state: patch.plan_state }
        : existing.plan_state !== undefined
          ? { plan_state: existing.plan_state }
          : {}),
      ...(patch.question_state !== undefined
        ? { question_state: patch.question_state }
        : existing.question_state !== undefined
          ? { question_state: existing.question_state }
          : {}),
      ...(patch.pipeline_state !== undefined
        ? { pipeline_state: patch.pipeline_state }
        : existing.pipeline_state !== undefined
          ? { pipeline_state: existing.pipeline_state }
          : {}),
    };
    this.atoms.set(id, updated);
    return updated;
  }

  async batchUpdate(filter: AtomFilter, patch: AtomPatch): Promise<number> {
    // CAS is undefined over a batch: every matched atom has its own
    // revision, so a single expectedRevision value cannot meaningfully
    // gate N writes. Reject at the substrate boundary so callers route
    // CAS-bearing patches through update() one at a time.
    if (patch.expectedRevision !== undefined) {
      throw new Error('batchUpdate does not support expectedRevision; use update() per atom for CAS');
    }
    // Include superseded atoms in batch updates (taint cascade needs this).
    const effective: AtomFilter = { ...filter, superseded: true };
    const matching = Array.from(this.atoms.values()).filter(a => matches(a, effective));
    for (const atom of matching) {
      await this.update(atom.id, patch);
    }
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

  // ---- Test-only helpers ----

  size(): number {
    return this.atoms.size;
  }
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
