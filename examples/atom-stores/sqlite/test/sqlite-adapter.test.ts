/**
 * SqliteAtomStore conformance.
 *
 * Runs the shared `runAtomsSpec` to prove the adapter satisfies the
 * same contract as the memory + file adapters, including the strict
 * CAS cases pinned at the substrate layer.
 *
 * Each test gets a fresh in-memory database so cases never bleed
 * state across each other. The CAS guard cases run identically here
 * to the file adapter because the in-process guarantee is the same
 * shape; the cross-process strict CAS guarantee gets its own
 * regression test in `concurrent-cas.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAtomsSpec } from '../../../../test/conformance/shared/atoms-spec.js';
import type { ConformanceTarget } from '../../../../test/conformance/shared/types.js';
import { SqliteAtomStore } from '../src/atom-store.js';

import type { AtomStore, Auditor, CanonStore, Clock, Host, LLM, Notifier, PrincipalStore, Scheduler } from '../../../../src/interface.js';

/**
 * Lift the SqliteAtomStore into the full Host shape the conformance
 * spec consumes. Only `atoms` is exercised by `runAtomsSpec`; the
 * other interfaces never get touched but must be present, so we wire
 * `null as any` stubs the spec never reaches. Adding a stub-host
 * helper in test/ would be cleaner but the brief scopes this PR to
 * the SQLite adapter only.
 */
function hostWithAtomsOnly(atoms: AtomStore): Host {
  const nope = () => {
    throw new Error('AtomStore conformance does not exercise this interface');
  };
  return {
    atoms,
    canon: new Proxy({}, { get: () => nope }) as unknown as CanonStore,
    llm: new Proxy({}, { get: () => nope }) as unknown as LLM,
    notifier: new Proxy({}, { get: () => nope }) as unknown as Notifier,
    scheduler: new Proxy({}, { get: () => nope }) as unknown as Scheduler,
    auditor: new Proxy({}, { get: () => nope }) as unknown as Auditor,
    principals: new Proxy({}, { get: () => nope }) as unknown as PrincipalStore,
    clock: new Proxy({}, { get: () => nope }) as unknown as Clock,
  };
}

async function makeSqliteTarget(): Promise<ConformanceTarget> {
  // File-backed temp database. In-memory would also satisfy the
  // conformance spec, but the file path exercises the same code path
  // a production deployment takes (mkdir, WAL mode, busy_timeout).
  const dir = await mkdtemp(join(tmpdir(), 'lag-sqlite-conf-'));
  const atoms = new SqliteAtomStore({ rootDir: dir });
  const host = hostWithAtomsOnly(atoms);
  return {
    host,
    cleanup: async () => {
      atoms.close();
      try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

runAtomsSpec('sqlite', makeSqliteTarget);

// Adapter-specific size helper + close() idempotence; complements the
// shared spec without duplicating its cases.
describe('SqliteAtomStore adapter-specific', () => {
  let dir: string;
  let atoms: SqliteAtomStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lag-sqlite-spec-'));
    atoms = new SqliteAtomStore({ rootDir: dir });
  });

  afterEach(async () => {
    atoms.close();
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('close() is idempotent', () => {
    atoms.close();
    expect(() => atoms.close()).not.toThrow();
  });

  it('rejects construction without rootDir or dbPath', () => {
    // The defensive throw protects against future plumbing that
    // forgets to pass either option.
    expect(() => new SqliteAtomStore({})).toThrow();
  });

  it('accepts :memory: dbPath for transient stores', () => {
    const transient = new SqliteAtomStore({ dbPath: ':memory:' });
    expect(transient.size()).toBe(0);
    transient.close();
  });
});
