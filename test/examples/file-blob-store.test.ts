import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileBlobStore } from '../../examples/blob-stores/file/index.js';
import { runBlobStoreContract } from '../substrate/blob-store-contract.test.js';

let scratch: string;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function makeStore() {
  scratch = await mkdtemp(join(tmpdir(), 'lag-blob-test-'));
  const store = new FileBlobStore(scratch);
  return { store, cleanup: async () => { await rm(scratch, { recursive: true, force: true }); } };
}

runBlobStoreContract('FileBlobStore', makeStore);

describe('FileBlobStore specifics', () => {
  it('writes to a sharded path layout', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const ref = await store.put('hello');
      const hex = ref.replace('sha256:', '');
      const expected = join(scratch, 'blobs', hex.slice(0, 2), hex);
      const s = await stat(expected);
      expect(s.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('computes the same hash as crypto.createHash', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const content = 'check sum';
      const ref = await store.put(content);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(ref).toBe(`sha256:${expected}`);
    } finally {
      await cleanup();
    }
  });

  it('writes file with 0600 mode (POSIX)', async () => {
    const { store, cleanup } = await makeStore();
    try {
      const ref = await store.put('private');
      const hex = ref.replace('sha256:', '');
      const filePath = join(scratch, 'blobs', hex.slice(0, 2), hex);
      const s = await stat(filePath);
      // On Windows file modes are different; only assert on POSIX.
      if (process.platform !== 'win32') {
        expect((s.mode & 0o777)).toBe(0o600);
      }
    } finally {
      await cleanup();
    }
  });

  it('rejects empty rootDir at construction', () => {
    expect(() => new FileBlobStore('')).toThrow(/rootDir/);
  });

  it('get throws for unknown ref (does not silently produce empty)', async () => {
    const { store, cleanup } = await makeStore();
    try {
      // Construct a ref that has not been put.
      const fakeHex = 'b'.repeat(64);
      await expect(store.get(`sha256:${fakeHex}` as never)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
