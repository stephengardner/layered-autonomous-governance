/**
 * BlobStore: content-addressed storage seam.
 *
 * Why this exists
 * ---------------
 * Agent-turn atoms can carry large LLM IO + tool-call payloads (file
 * reads, bash output dumps). Inlining everything blows up atom file
 * size and forfeits dedup. Above the per-actor blob-threshold policy,
 * payloads are externalized to a BlobStore by content hash; the turn
 * atom holds only a small `BlobRef`.
 *
 * Threat model
 * ------------
 * - Blobs are content-addressed; immutability is implicit.
 * - At-rest encryption is out of scope for the initial substrate
 *   surface. Treat blob storage as having the same trust boundary as
 *   the rest of `.lag/`.
 * - Adapters MUST atomic-write to avoid two concurrent `put()` of the
 *   same content corrupting each other.
 * - Adapters MUST NOT expose internal storage paths through the
 *   interface; consumers depend only on `BlobRef`.
 *
 * Pluggability
 * ------------
 * Concrete adapters (file-backed, S3, Postgres LOB, in-memory) live
 * in `examples/blob-stores/`. The interface contract test
 * (`test/substrate/blob-store-contract.test.ts`) is the conformance
 * floor.
 */

import type { BlobRef } from './types.js';

export type { BlobRef } from './types.js';

export interface BlobStore {
  /**
   * Persist `content`. Returns a content-addressed `BlobRef`.
   * Idempotent: identical content yields identical ref. Adapters
   * implementing this MUST be safe under concurrent calls with the
   * same content (atomic write).
   */
  put(content: Buffer | string): Promise<BlobRef>;

  /** Retrieve. Throws if the ref is unknown. Always returns Buffer. */
  get(ref: BlobRef): Promise<Buffer>;

  /** Existence check. Returns false on unknown ref (does not throw). */
  has(ref: BlobRef): Promise<boolean>;
}

const SHA256_PREFIX = 'sha256:';
const HEX_64 = /^[0-9a-f]{64}$/;

export class BlobRefError extends Error {
  constructor(message: string) {
    super(`BlobRef: ${message}`);
    this.name = 'BlobRefError';
  }
}

/**
 * Construct a `BlobRef` from a 64-char lowercase hex sha256 digest.
 * Throws `BlobRefError` on malformed input. Adapter implementations
 * call this after computing the digest of the content they wrote.
 */
export function blobRefFromHash(hexDigest: string): BlobRef {
  if (typeof hexDigest !== 'string') {
    throw new BlobRefError(`expected string, got ${typeof hexDigest}`);
  }
  if (hexDigest.length !== 64) {
    throw new BlobRefError(`length must be 64, got ${hexDigest.length}`);
  }
  if (!HEX_64.test(hexDigest)) {
    throw new BlobRefError('value is not lowercase hex');
  }
  return `${SHA256_PREFIX}${hexDigest}` as BlobRef;
}

/**
 * Parse a `BlobRef` back to its components. Throws `BlobRefError` on
 * malformed input. Useful for adapter-side path computation (sharded
 * file system: `blobs/<first2chars>/<hex>`).
 */
export function parseBlobRef(ref: BlobRef): { readonly algorithm: 'sha256'; readonly hex: string } {
  if (typeof ref !== 'string') {
    throw new BlobRefError(`expected string, got ${typeof ref}`);
  }
  if (!ref.startsWith(SHA256_PREFIX)) {
    throw new BlobRefError(`missing 'sha256:' prefix: ${String(ref).slice(0, 16)}...`);
  }
  const hex = ref.slice(SHA256_PREFIX.length);
  if (!HEX_64.test(hex)) {
    throw new BlobRefError(`unsupported algorithm or malformed body; only sha256 64-char hex accepted`);
  }
  return { algorithm: 'sha256', hex };
}
