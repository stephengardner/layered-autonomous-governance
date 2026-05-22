/**
 * Concurrent-writer CAS regression.
 *
 * Proves the strict cross-process compare-and-swap guarantee that the
 * SqliteAtomStore makes and the file adapter does not. N concurrent
 * writers each read the same atom, compute a mutation, and call
 * update() with the SAME expectedRevision; the substrate must
 * guarantee that exactly ONE writer's update lands and the other N-1
 * receive ConflictError. The file adapter's best-effort guard
 * regularly lets two writers through; SQLite's IMMEDIATE transaction
 * plus column-conditioned UPDATE serializes them strictly.
 *
 * The test runs both an in-process N=50 race against a single
 * SqliteAtomStore instance AND a multi-instance variant that
 * simulates separate processes by opening N independent
 * SqliteAtomStore handles against the same .db file. The two-handle
 * shape is the load-bearing one for the audit finding because the
 * cross-process case is the gap the file adapter cannot close.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConflictError } from '../../../../src/errors.js';
import { sampleAtom } from '../../../../test/fixtures.js';
import { SqliteAtomStore } from '../src/atom-store.js';

import type { AtomId } from '../../../../src/types.js';

describe('SqliteAtomStore concurrent CAS', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lag-sqlite-cas-'));
    dbPath = join(dir, 'atoms.db');
  });

  afterEach(async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('N=50 single-instance concurrent updates with same expectedRevision: 1 wins, 49 ConflictError', async () => {
    const atoms = new SqliteAtomStore({ dbPath });
    try {
      const id = 'cas-single-instance' as AtomId;
      await atoms.put(sampleAtom({ id, content: 'race subject' }));
      // Bring the revision to 1 so every concurrent writer reads the
      // same baseline and submits expectedRevision: 1. The race is
      // resolved by the substrate, not by who-read-first.
      const seed = await atoms.update(id, { confidence: 0.5 });
      expect(seed.revision).toBe(1);

      const N = 50;
      const writers = Array.from({ length: N }, (_, i) =>
        atoms.update(id, {
          confidence: 0.1 + i / 1000,
          expectedRevision: 1,
        }),
      );
      const results = await Promise.allSettled(writers);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(N - 1);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      }
      // Post-condition: revision moved from 1 to exactly 2.
      const final = await atoms.get(id);
      expect(final?.revision).toBe(2);
    } finally {
      atoms.close();
    }
  });

  it('N=20 multi-instance concurrent updates (separate handles, same .db): 1 wins, 19 ConflictError', async () => {
    // Each handle simulates a separate process: distinct
    // SqliteAtomStore objects with their own better-sqlite3 Database
    // instance, all pointing at the same file. This is the shape the
    // file adapter cannot serve correctly because two processes can
    // both pass the in-process best-effort guard.
    const N = 20;
    const id = 'cas-multi-handle' as AtomId;

    // Seed with one handle then close it; subsequent handles open
    // fresh against the same file.
    const seedHandle = new SqliteAtomStore({ dbPath });
    await seedHandle.put(sampleAtom({ id, content: 'multi-handle subject' }));
    const seed = await seedHandle.update(id, { confidence: 0.5 });
    expect(seed.revision).toBe(1);
    seedHandle.close();

    // Open N independent handles, each fires one update.
    const handles = Array.from({ length: N }, () => new SqliteAtomStore({ dbPath }));
    try {
      const writers = handles.map((h, i) =>
        h.update(id, {
          confidence: 0.2 + i / 1000,
          expectedRevision: 1,
        }),
      );
      const results = await Promise.allSettled(writers);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(N - 1);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      }

      // Reopen and verify the persisted state: revision moved from 1
      // to exactly 2, and the winning confidence is one of the
      // submitted values.
      const verify = new SqliteAtomStore({ dbPath });
      try {
        const final = await verify.get(id);
        expect(final?.revision).toBe(2);
        expect(final?.confidence).toBeGreaterThanOrEqual(0.2);
        expect(final?.confidence).toBeLessThan(0.3);
      } finally {
        verify.close();
      }
    } finally {
      for (const h of handles) h.close();
    }
  });

  it('serialized updates without expectedRevision bump revision by exactly 1 each', async () => {
    // Smoke test for the monotonic-revision contract on the SQLite
    // adapter. The shared conformance spec covers this for the
    // single-update case; this case proves a 10-update sequence stays
    // monotonic under the SQLite write lock.
    const atoms = new SqliteAtomStore({ dbPath });
    try {
      const id = 'cas-monotonic' as AtomId;
      await atoms.put(sampleAtom({ id, content: 'sequential subject' }));
      for (let i = 1; i <= 10; i++) {
        const out = await atoms.update(id, { confidence: i / 10 });
        expect(out.revision).toBe(i);
      }
      const final = await atoms.get(id);
      expect(final?.revision).toBe(10);
    } finally {
      atoms.close();
    }
  });

  it('expectedRevision: stale reader stays stale (ConflictError) until it re-reads', async () => {
    // Exercises the typical safe-CAS retry loop: a reader observes
    // revision R, attempts an update with expectedRevision: R, gets
    // ConflictError because another writer bumped R, re-reads to get
    // the new revision, and the second attempt succeeds.
    const atoms = new SqliteAtomStore({ dbPath });
    try {
      const id = 'cas-stale-retry' as AtomId;
      await atoms.put(sampleAtom({ id, content: 'stale-retry subject' }));
      const r1 = await atoms.update(id, { confidence: 0.4 });
      expect(r1.revision).toBe(1);

      // Reader A captures revision 1.
      const readerASnapshot = await atoms.get(id);
      // Writer B sneaks in a bump.
      const r2 = await atoms.update(id, { confidence: 0.5 });
      expect(r2.revision).toBe(2);

      // Reader A's stale attempt fails.
      await expect(
        atoms.update(id, {
          confidence: 0.6,
          expectedRevision: readerASnapshot?.revision ?? 0,
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      // Reader A re-reads, retries against the current revision.
      const fresh = await atoms.get(id);
      const retried = await atoms.update(id, {
        confidence: 0.6,
        expectedRevision: fresh?.revision ?? 0,
      });
      expect(retried.revision).toBe(3);
      expect(retried.confidence).toBe(0.6);
    } finally {
      atoms.close();
    }
  });
});
