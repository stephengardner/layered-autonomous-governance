import { describe, it, expect } from 'vitest';
import { blobRefFromHash, parseBlobRef } from '../../src/substrate/blob-store.js';
import type { BlobStore, BlobRef } from '../../src/substrate/blob-store.js';

describe('blobRefFromHash + parseBlobRef', () => {
  it('round-trips a 64-char hex hash', () => {
    const hex = 'a'.repeat(64);
    const ref = blobRefFromHash(hex);
    expect(ref).toBe(`sha256:${hex}`);
    expect(parseBlobRef(ref)).toEqual({ algorithm: 'sha256', hex });
  });

  it('rejects non-hex characters', () => {
    expect(() => blobRefFromHash('z'.repeat(64))).toThrow(/hex/);
  });

  it('rejects wrong length', () => {
    expect(() => blobRefFromHash('a'.repeat(63))).toThrow(/length/);
    expect(() => blobRefFromHash('a'.repeat(65))).toThrow(/length/);
  });

  it('parseBlobRef rejects missing prefix', () => {
    expect(() => parseBlobRef('a'.repeat(64) as BlobRef)).toThrow(/prefix/);
  });

  it('parseBlobRef rejects unsupported algorithm', () => {
    expect(() => parseBlobRef('md5:abc' as BlobRef)).toThrow(/sha256/);
  });
});

/**
 * Contract test runner. Any `BlobStore` impl can pass this fixture in
 * to verify it satisfies the interface contract.
 */
export function runBlobStoreContract(name: string, build: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>) {
  describe(`BlobStore contract: ${name}`, () => {
    it('round-trips bytes', async () => {
      const { store, cleanup } = await build();
      try {
        const ref = await store.put('hello world');
        const back = await store.get(ref);
        expect(back.toString('utf8')).toBe('hello world');
      } finally {
        await cleanup();
      }
    });

    it('put is idempotent: same content yields same ref', async () => {
      const { store, cleanup } = await build();
      try {
        const r1 = await store.put('same content');
        const r2 = await store.put('same content');
        expect(r1).toBe(r2);
      } finally {
        await cleanup();
      }
    });

    it('has() reflects put()', async () => {
      const { store, cleanup } = await build();
      try {
        const ref = await store.put('xyz');
        expect(await store.has(ref)).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('has() returns false for unknown ref', async () => {
      const { store, cleanup } = await build();
      try {
        const fake = blobRefFromHash('0'.repeat(64));
        expect(await store.has(fake)).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('get() throws on unknown ref (does not silently return empty)', async () => {
      // Pin loud-fail behavior so consumers can't accidentally treat
      // a missing blob as an empty payload (which would silently
      // discard tool inputs/outputs in the agentic actor loop).
      const { store, cleanup } = await build();
      try {
        const fake = blobRefFromHash('0'.repeat(64));
        await expect(store.get(fake)).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });
  });
}
