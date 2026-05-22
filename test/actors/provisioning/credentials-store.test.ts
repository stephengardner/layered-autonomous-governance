/**
 * Tests for createCredentialsStore.
 *
 * Coverage targets:
 *   - exists() before and after save()
 *   - save() round-trips the record + private key
 *   - save() rolls back the PEM when the JSON write fails
 *   - update() rejects when the record does not exist
 *   - update() rewrites the record on existing creds
 *   - load() returns null on a missing record
 *   - list() returns every stored record
 *   - list() skips malformed files
 *   - list() returns an empty array when the apps dir does not exist
 *   - assertSafeRole rejects unsafe role names from every entry point
 *
 * Includes the gh-as.mjs interop regression assertion: the on-disk
 * record schema matches what gh-token-for.mjs / store.load() reads.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCredentialsStore,
  type AppCredentialsRecord,
} from '../../../src/actors/provisioning/credentials-store.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lag-creds-'));
});

afterEach(() => {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function mkRecord(over: Partial<AppCredentialsRecord> = {}): AppCredentialsRecord {
  return {
    role: 'lag-cto',
    appId: 12345,
    slug: 'lag-cto-agent',
    owner: 'my-org',
    createdAt: '2026-05-22T00:00:00.000Z',
    description: 'CTO actor for plan deliberation.',
    ...over,
  };
}

const SAMPLE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOQIBAAJB\n-----END RSA PRIVATE KEY-----\n';

describe('createCredentialsStore (paths + identity)', () => {
  it('reflects stateDir + derived appsDir + keysDir', () => {
    const store = createCredentialsStore(stateDir);
    expect(store.stateDir).toBe(stateDir);
    expect(store.appsDir).toBe(join(stateDir, 'apps'));
    expect(store.keysDir).toBe(join(stateDir, 'apps', 'keys'));
  });
});

describe('exists / save / load round-trip', () => {
  it('exists() returns false for an unprovisioned role', () => {
    const store = createCredentialsStore(stateDir);
    expect(store.exists('lag-cto')).toBe(false);
  });

  it('save() writes both record and PEM and exists() flips to true', async () => {
    const store = createCredentialsStore(stateDir);
    const record = mkRecord();
    await store.save(record, SAMPLE_PEM);
    expect(store.exists('lag-cto')).toBe(true);

    const recordOnDisk = JSON.parse(await readFile(join(stateDir, 'apps', 'lag-cto.json'), 'utf8'));
    expect(recordOnDisk.role).toBe('lag-cto');
    expect(recordOnDisk.appId).toBe(12345);
    expect(recordOnDisk.slug).toBe('lag-cto-agent');
    expect(recordOnDisk.owner).toBe('my-org');

    const pemOnDisk = await readFile(join(stateDir, 'apps', 'keys', 'lag-cto.pem'), 'utf8');
    expect(pemOnDisk).toBe(SAMPLE_PEM);
  });

  it('load() returns null for an unknown role', async () => {
    const store = createCredentialsStore(stateDir);
    const result = await store.load('lag-cto');
    expect(result).toBeNull();
  });

  it('load() returns the round-tripped record and private key', async () => {
    const store = createCredentialsStore(stateDir);
    const original = mkRecord({ installationId: 99887 });
    await store.save(original, SAMPLE_PEM);

    const loaded = await store.load('lag-cto');
    expect(loaded).not.toBeNull();
    expect(loaded!.record).toEqual(original);
    expect(loaded!.privateKey).toBe(SAMPLE_PEM);
  });
});

describe('save() failure modes', () => {
  it('rolls back the PEM when the record write fails', async () => {
    // Force the JSON write to fail by occupying the record path with a
    // directory instead of a file. The PEM write to keysDir/<role>.pem
    // succeeds; the subsequent writeFile() call for the JSON record
    // raises EISDIR and triggers the rollback branch which rms the PEM.
    const store = createCredentialsStore(stateDir);
    const record = mkRecord();
    mkdirSync(join(stateDir, 'apps', 'lag-cto.json'), { recursive: true });

    await expect(store.save(record, SAMPLE_PEM)).rejects.toThrow();

    // The orphan PEM should have been removed by the rollback.
    expect(existsSync(join(stateDir, 'apps', 'keys', 'lag-cto.pem'))).toBe(false);
  });
});

describe('update()', () => {
  it('rejects when the record does not exist', async () => {
    const store = createCredentialsStore(stateDir);
    await expect(store.update(mkRecord())).rejects.toThrow(/no credentials/);
  });

  it('rewrites the record on an existing entry', async () => {
    const store = createCredentialsStore(stateDir);
    await store.save(mkRecord(), SAMPLE_PEM);
    await store.update(mkRecord({ installationId: 42 }));

    const loaded = await store.load('lag-cto');
    expect(loaded!.record.installationId).toBe(42);
  });
});

describe('list()', () => {
  it('returns an empty array when the apps dir does not exist', async () => {
    const store = createCredentialsStore(stateDir);
    const records = await store.list();
    expect(records).toEqual([]);
  });

  it('returns every saved record', async () => {
    const store = createCredentialsStore(stateDir);
    await store.save(mkRecord({ role: 'lag-cto' }), SAMPLE_PEM);
    await store.save(mkRecord({ role: 'lag-ceo', appId: 999 }), SAMPLE_PEM);

    const records = await store.list();
    expect(records.length).toBe(2);
    const names = records.map((r) => r.role).sort();
    expect(names).toEqual(['lag-ceo', 'lag-cto']);
  });

  it('skips malformed JSON files without throwing', async () => {
    const store = createCredentialsStore(stateDir);
    await store.save(mkRecord(), SAMPLE_PEM);
    // Drop a malformed file into appsDir.
    writeFileSync(join(stateDir, 'apps', 'broken.json'), '{ not json', 'utf8');

    const records = await store.list();
    expect(records.length).toBe(1);
    expect(records[0]!.role).toBe('lag-cto');
  });

  it('ignores non-json entries', async () => {
    const store = createCredentialsStore(stateDir);
    await store.save(mkRecord(), SAMPLE_PEM);
    writeFileSync(join(stateDir, 'apps', 'README.txt'), 'hello', 'utf8');

    const records = await store.list();
    expect(records.length).toBe(1);
  });
});

describe('assertSafeRole', () => {
  it('rejects exists() with an unsafe role name', () => {
    const store = createCredentialsStore(stateDir);
    expect(() => store.exists('../../etc/passwd')).toThrow(/unsafe role/);
  });

  it('rejects load() with an unsafe role name', async () => {
    const store = createCredentialsStore(stateDir);
    await expect(store.load('UPPER')).rejects.toThrow(/unsafe role/);
  });

  it('rejects save() with an unsafe role name', async () => {
    const store = createCredentialsStore(stateDir);
    await expect(store.save(mkRecord({ role: 'a' }), SAMPLE_PEM)).rejects.toThrow(/unsafe role/);
  });

  it('rejects update() with an unsafe role name', async () => {
    const store = createCredentialsStore(stateDir);
    await expect(store.update(mkRecord({ role: 'BAD/path' }))).rejects.toThrow(/unsafe role/);
  });

  it('rejects a non-string role', () => {
    const store = createCredentialsStore(stateDir);
    // Cast to bypass the static type check; the runtime guard is what
    // this assertion exercises.
    expect(() => store.exists(123 as unknown as string)).toThrow(/unsafe role/);
  });
});

describe('on-disk format matches gh-token-for.mjs expectations', () => {
  // gh-token-for.mjs reads .lag/apps/<role>.json + .lag/apps/keys/<role>.pem
  // and feeds them into fetchInstallationToken. We assert here that the
  // record carries every field the token-mint path destructures so a
  // future refactor that drops a field fails a unit test, not a 5-minute
  // wait on a real gh-as.mjs roundtrip.
  it('on-disk record exposes appId, installationId, slug, owner, description, createdAt', async () => {
    const store = createCredentialsStore(stateDir);
    const original = mkRecord({ installationId: 99887 });
    await store.save(original, SAMPLE_PEM);

    const recordOnDisk = JSON.parse(await readFile(join(stateDir, 'apps', 'lag-cto.json'), 'utf8'));
    // Every field gh-token-for.mjs reads must be present:
    expect(recordOnDisk).toHaveProperty('appId');
    expect(recordOnDisk).toHaveProperty('installationId');
    expect(recordOnDisk).toHaveProperty('slug');
    expect(recordOnDisk).toHaveProperty('owner');
    expect(recordOnDisk).toHaveProperty('description');
    expect(recordOnDisk).toHaveProperty('createdAt');
    expect(recordOnDisk).toHaveProperty('role');
  });

  it('keysDir holds <role>.pem readable by absolute path', async () => {
    const store = createCredentialsStore(stateDir);
    await store.save(mkRecord(), SAMPLE_PEM);
    // gh-token-for.mjs ultimately delegates to createCredentialsStore +
    // load(); confirm the same load() path returns the bytes.
    const loaded = await store.load('lag-cto');
    expect(loaded!.privateKey).toBe(SAMPLE_PEM);
  });
});
