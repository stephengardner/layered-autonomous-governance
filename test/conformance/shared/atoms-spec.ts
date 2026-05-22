/**
 * AtomStore conformance spec.
 *
 * Every adapter implementing AtomStore must satisfy these cases. Pass the
 * factory in from the adapter's test file:
 *
 *   runAtomsSpec('memory', async () => ({
 *     host: createMemoryHost(),
 *   }));
 *
 *   runAtomsSpec('file', async () => {
 *     const rootDir = await mkdtemp(join(tmpdir(), 'lag-atoms-'));
 *     const host = await createFileHost({ rootDir });
 *     return { host, cleanup: async () => host.cleanup() };
 *   });
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../../src/errors.js';
import type { Host } from '../../../src/interface.js';
import type { AtomId, PrincipalId } from '../../../src/types.js';
import { sampleAtom } from '../../fixtures.js';
import type { TargetFactory } from './types.js';

export function runAtomsSpec(label: string, factory: TargetFactory): void {
  describe(`AtomStore conformance (${label})`, () => {
    let host: Host;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const r = await factory();
      host = r.host;
      cleanup = r.cleanup;
    });

    afterEach(async () => {
      if (cleanup) await cleanup();
    });

    it('put and get round-trip preserves content', async () => {
      const atom = sampleAtom({ content: 'hello world' });
      await host.atoms.put(atom);
      const got = await host.atoms.get(atom.id);
      expect(got).not.toBeNull();
      expect(got?.content).toBe('hello world');
      expect(got?.id).toBe(atom.id);
    });

    it('get returns null for missing id', async () => {
      const got = await host.atoms.get('missing_id' as AtomId);
      expect(got).toBeNull();
    });

    it('put with duplicate id throws ConflictError', async () => {
      const atom = sampleAtom();
      await host.atoms.put(atom);
      await expect(host.atoms.put(atom)).rejects.toBeInstanceOf(ConflictError);
    });

    it('query by layer filter returns only matching atoms', async () => {
      await host.atoms.put(sampleAtom({ id: 'a1' as AtomId, layer: 'L1' }));
      await host.atoms.put(sampleAtom({ id: 'a2' as AtomId, layer: 'L2' }));
      await host.atoms.put(sampleAtom({ id: 'a3' as AtomId, layer: 'L1' }));
      const result = await host.atoms.query({ layer: ['L1'] }, 10);
      expect(result.atoms).toHaveLength(2);
      expect(result.atoms.every(a => a.layer === 'L1')).toBe(true);
    });

    it('query excludes superseded atoms by default', async () => {
      await host.atoms.put(sampleAtom({ id: 'old' as AtomId, superseded_by: ['new' as AtomId] }));
      await host.atoms.put(sampleAtom({ id: 'new' as AtomId }));
      const result = await host.atoms.query({}, 10);
      expect(result.atoms.map(a => a.id)).not.toContain('old');
      expect(result.atoms.map(a => a.id)).toContain('new');
    });

    it('query with superseded: true includes them', async () => {
      await host.atoms.put(sampleAtom({ id: 'old' as AtomId, superseded_by: ['new' as AtomId] }));
      await host.atoms.put(sampleAtom({ id: 'new' as AtomId }));
      const result = await host.atoms.query({ superseded: true }, 10);
      expect(result.atoms.map(a => a.id).sort()).toEqual(['new', 'old']);
    });

    it('query pagination via cursor returns distinct pages', async () => {
      for (let i = 0; i < 5; i++) {
        await host.atoms.put(sampleAtom({ id: `atom_p_${i}` as AtomId }));
      }
      const p1 = await host.atoms.query({}, 2);
      expect(p1.atoms).toHaveLength(2);
      expect(p1.nextCursor).not.toBeNull();
      const p2 = await host.atoms.query({}, 2, p1.nextCursor!);
      expect(p2.atoms).toHaveLength(2);
      const ids1 = new Set(p1.atoms.map(a => a.id));
      const ids2 = new Set(p2.atoms.map(a => a.id));
      for (const id of ids1) expect(ids2.has(id)).toBe(false);
    });

    it('search ranks exact matches above unrelated text', async () => {
      await host.atoms.put(sampleAtom({ id: 'postgres' as AtomId, content: 'we use postgres for the main database' }));
      await host.atoms.put(sampleAtom({ id: 'redis' as AtomId, content: 'we use redis for caching' }));
      await host.atoms.put(sampleAtom({ id: 'mongo' as AtomId, content: 'we use mongodb for logs' }));
      const hits = await host.atoms.search('postgres database', 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.atom.id).toBe('postgres');
    });

    it('search respects filter', async () => {
      await host.atoms.put(sampleAtom({ id: 'd1' as AtomId, content: 'postgres', layer: 'L1' }));
      await host.atoms.put(sampleAtom({ id: 'd2' as AtomId, content: 'postgres', layer: 'L2' }));
      const hits = await host.atoms.search('postgres', 5, { layer: ['L2'] });
      expect(hits.every(h => h.atom.layer === 'L2')).toBe(true);
    });

    it('update modifies confidence', async () => {
      const atom = sampleAtom({ confidence: 0.5 });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { confidence: 0.9 });
      expect(updated.confidence).toBe(0.9);
      const reread = await host.atoms.get(atom.id);
      expect(reread?.confidence).toBe(0.9);
    });

    it('update does not alter content', async () => {
      const atom = sampleAtom({ content: 'original' });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { confidence: 0.1 });
      expect(updated.content).toBe('original');
    });

    it('update supersedes appends to existing', async () => {
      const atom = sampleAtom({ supersedes: ['old_a' as AtomId] });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { supersedes: ['old_b' as AtomId] });
      expect(updated.supersedes).toEqual(['old_a', 'old_b']);
    });

    it('update missing id throws NotFoundError', async () => {
      await expect(
        host.atoms.update('never' as AtomId, { confidence: 0.1 }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('batchUpdate affects all matching atoms', async () => {
      await host.atoms.put(sampleAtom({ id: 'x1' as AtomId, principal_id: 'evil' as PrincipalId, taint: 'clean' }));
      await host.atoms.put(sampleAtom({ id: 'x2' as AtomId, principal_id: 'evil' as PrincipalId, taint: 'clean' }));
      await host.atoms.put(sampleAtom({ id: 'x3' as AtomId, principal_id: 'good' as PrincipalId, taint: 'clean' }));
      const count = await host.atoms.batchUpdate(
        { principal_id: ['evil' as PrincipalId] },
        { taint: 'tainted' },
      );
      expect(count).toBe(2);
      expect((await host.atoms.get('x1' as AtomId))?.taint).toBe('tainted');
      expect((await host.atoms.get('x2' as AtomId))?.taint).toBe('tainted');
      expect((await host.atoms.get('x3' as AtomId))?.taint).toBe('clean');
    });

    it('embed is deterministic across calls', async () => {
      const v1 = await host.atoms.embed('the quick brown fox');
      const v2 = await host.atoms.embed('the quick brown fox');
      expect(v1).toEqual(v2);
    });

    it('similarity is symmetric', async () => {
      const v1 = await host.atoms.embed('postgres database');
      const v2 = await host.atoms.embed('postgres server');
      expect(host.atoms.similarity(v1, v2)).toBeCloseTo(host.atoms.similarity(v2, v1), 10);
    });

    it('similarity of identical vectors is 1', async () => {
      const v = await host.atoms.embed('anything');
      expect(host.atoms.similarity(v, v)).toBeCloseTo(1.0, 6);
    });

    it('contentHash normalizes case and trailing punctuation', () => {
      expect(host.atoms.contentHash('Use Postgres.')).toBe(host.atoms.contentHash('use postgres'));
      expect(host.atoms.contentHash('We Use Postgres!')).toBe(host.atoms.contentHash('we use postgres'));
    });

    it('contentHash differs for semantically different text', () => {
      expect(host.atoms.contentHash('use postgres')).not.toBe(host.atoms.contentHash('use mysql'));
    });

    /**
     * Round-trip the `metadata.reaped_at` + `metadata.reaped_reason` pair
     * documented on `AtomPatch.metadata` in `src/substrate/types.ts`. Future
     * GC code (per the reaper plan at
     * `docs/superpowers/plans/2026-05-09-reaper-pipeline-atom-gc.md`) will
     * write these keys via `host.atoms.update`; this conformance test pins
     * the round-trip so any future adapter (FileAtomStore, MemoryAtomStore,
     * a hypothetical SQLite or Postgres backend) preserves the convention.
     *
     * Pinning at the substrate layer means: a Console projection that hides
     * reaped atoms by default, or an arbitration consumer that floors
     * confidence on reaped atoms, can rely on this metadata being readable
     * after a put + update cycle on every adapter without per-adapter tests.
     */
    it('metadata.reaped_at + metadata.reaped_reason survive put + update round-trip', async () => {
      const atom = sampleAtom({ id: 'reaped-roundtrip' as AtomId, content: 'pipeline root' });
      await host.atoms.put(atom);
      const reapedAt = '2026-05-09T00:00:00.000Z';
      const reapedReason = 'terminal-pipeline-ttl';
      const updated = await host.atoms.update(atom.id, {
        metadata: { reaped_at: reapedAt, reaped_reason: reapedReason },
      });
      expect(updated.metadata['reaped_at']).toBe(reapedAt);
      expect(updated.metadata['reaped_reason']).toBe(reapedReason);
      const reread = await host.atoms.get(atom.id);
      expect(reread).not.toBeNull();
      expect(reread?.metadata['reaped_at']).toBe(reapedAt);
      expect(reread?.metadata['reaped_reason']).toBe(reapedReason);
    });

    /*
     * Revision + compare-and-swap contract. revision starts unset on a
     * fresh put (treated as 0 for back-compat with atoms written before
     * the field existed), increments by exactly 1 on every successful
     * update, and a non-matching expectedRevision rejects with the same
     * ConflictError shape that put-on-duplicate produces. Pinned at the
     * conformance layer so any future adapter (file, bridge, future
     * SQLite or remote) preserves the substrate guarantee.
     */
    it('revision is unset on a fresh put', async () => {
      const atom = sampleAtom({ id: 'cas-fresh' as AtomId });
      await host.atoms.put(atom);
      const stored = await host.atoms.get(atom.id);
      expect(stored?.revision).toBeUndefined();
    });

    it('revision becomes 1 after the first update', async () => {
      const atom = sampleAtom({ id: 'cas-first' as AtomId });
      await host.atoms.put(atom);
      const updated = await host.atoms.update(atom.id, { confidence: 0.5 });
      expect(updated.revision).toBe(1);
    });

    it('revision increments by 1 on each successful update', async () => {
      const atom = sampleAtom({ id: 'cas-monotonic' as AtomId });
      await host.atoms.put(atom);
      const r1 = await host.atoms.update(atom.id, { confidence: 0.4 });
      const r2 = await host.atoms.update(atom.id, { confidence: 0.5 });
      const r3 = await host.atoms.update(atom.id, { confidence: 0.6 });
      expect(r1.revision).toBe(1);
      expect(r2.revision).toBe(2);
      expect(r3.revision).toBe(3);
    });

    it('expectedRevision matching stored revision passes the CAS guard', async () => {
      const atom = sampleAtom({ id: 'cas-match' as AtomId });
      await host.atoms.put(atom);
      const r1 = await host.atoms.update(atom.id, { confidence: 0.5 });
      // r1.revision is 1; passing expectedRevision:1 must succeed.
      const r2 = await host.atoms.update(atom.id, {
        confidence: 0.7,
        expectedRevision: r1.revision,
      });
      expect(r2.confidence).toBe(0.7);
      expect(r2.revision).toBe(2);
    });

    it('expectedRevision mismatch rejects with ConflictError', async () => {
      const atom = sampleAtom({ id: 'cas-mismatch' as AtomId });
      await host.atoms.put(atom);
      // Simulate a racing write: first caller bumps revision to 1.
      await host.atoms.update(atom.id, { confidence: 0.5 });
      // Second caller still has the pre-race read (revision 0) and
      // submits a stale expectedRevision.
      await expect(
        host.atoms.update(atom.id, { confidence: 0.6, expectedRevision: 0 }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('expectedRevision omitted skips the CAS check (back-compat)', async () => {
      const atom = sampleAtom({ id: 'cas-backcompat' as AtomId });
      await host.atoms.put(atom);
      // Two updates back-to-back with no expectedRevision: both succeed.
      // Legacy callers wrote before the CAS surface existed and must keep
      // working until they migrate to expectedRevision.
      const r1 = await host.atoms.update(atom.id, { confidence: 0.4 });
      const r2 = await host.atoms.update(atom.id, { confidence: 0.5 });
      expect(r1.revision).toBe(1);
      expect(r2.revision).toBe(2);
    });

    it('expectedRevision=0 on a fresh atom (no prior update) passes', async () => {
      const atom = sampleAtom({ id: 'cas-from-fresh' as AtomId });
      await host.atoms.put(atom);
      // A fresh atom has no revision field; the CAS guard treats this as
      // revision 0 so the first CAS-aware update can pass expectedRevision:0.
      const updated = await host.atoms.update(atom.id, {
        confidence: 0.5,
        expectedRevision: 0,
      });
      expect(updated.revision).toBe(1);
    });

    it('batchUpdate rejects expectedRevision and leaves matched atoms unchanged', async () => {
      await host.atoms.put(sampleAtom({ id: 'cas-batch-1' as AtomId, principal_id: 'batch-target' as PrincipalId, taint: 'clean' }));
      await host.atoms.put(sampleAtom({ id: 'cas-batch-2' as AtomId, principal_id: 'batch-target' as PrincipalId, taint: 'clean' }));
      // A single expectedRevision value cannot gate N atoms each with
      // their own revision; adapters reject at the substrate boundary
      // BEFORE any matched atom mutates. The post-assertions pin the
      // "reject at the boundary" contract; a future adapter that
      // partially applied the batch before throwing would fail these.
      await expect(
        host.atoms.batchUpdate(
          { principal_id: ['batch-target' as PrincipalId] },
          { taint: 'tainted', expectedRevision: 0 },
        ),
      ).rejects.toThrow(/expectedRevision/);
      expect((await host.atoms.get('cas-batch-1' as AtomId))?.taint).toBe('clean');
      expect((await host.atoms.get('cas-batch-2' as AtomId))?.taint).toBe('clean');
    });

    /**
     * Capability-bit contract: every adapter MUST declare a posture
     * for the cross-process CAS guarantee so consumers can pick a
     * retry strategy without reading per-adapter source. The bit is
     * surfaced via AtomStore.capabilities.hasStrictCrossProcessCas
     * (optional in the type, but every shipped adapter MUST set it
     * explicitly).
     */
    it('declares hasStrictCrossProcessCas in capabilities', () => {
      // The capability getter must exist and the bit must be a
      // concrete boolean (not undefined). Adapters that genuinely do
      // not yet have CAS-shaped semantics declare `false`; new
      // adapters with strict semantics declare `true`. Leaving the
      // bit undefined is a conformance failure under this spec
      // because it forces consumers to guess.
      expect(host.atoms.capabilities).toBeDefined();
      expect(typeof host.atoms.capabilities?.hasStrictCrossProcessCas).toBe('boolean');
    });
  });
}
