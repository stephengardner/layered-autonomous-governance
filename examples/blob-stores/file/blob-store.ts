/**
 * Reference FileBlobStore.
 *
 * Layout: `<rootDir>/blobs/<first2hex>/<sha256-hex>`
 * Mode:   0o600 (user-only). On Windows this is best-effort; the OS
 *         enforces the equivalent via the user's profile ACLs.
 *
 * Atomic write
 * ------------
 * Write to `<rootDir>/blobs/<first2hex>/.tmp.<random>`, then rename
 * to the final path. Two concurrent `put()` calls of the same content
 * rename to the same final path; the second rename is a no-op or
 * replaces an identical file. Either way the final file is correct.
 *
 * Threat model
 * ------------
 * - `rootDir` MUST be a directory the calling user owns. The
 *   constructor does not chown.
 * - At-rest encryption is out of scope at the substrate level for the
 *   initial surface; treat the blob root as having the same trust
 *   boundary as the rest of `.lag/`.
 * - No path traversal: `BlobRef` parsing is the only source of the
 *   hex suffix; parser rejects malformed input. The shard prefix is
 *   computed by `.slice(0, 2)` of validated hex, so it is always 2
 *   hex chars (no path-escape characters possible).
 *
 * GC
 * --
 * No deletion. Content-addressed blobs are immutable; garbage
 * collection of unreferenced blobs is a separate concern (a future
 * sweeper that walks atom-store referenced blob refs and removes
 * orphans). The `BlobStore` interface intentionally has no `delete`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  blobRefFromHash,
  parseBlobRef,
  type BlobStore,
  type BlobRef,
} from '../../../src/substrate/blob-store.js';

export class FileBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new Error('FileBlobStore: rootDir must be a non-empty string');
    }
  }

  async put(content: Buffer | string): Promise<BlobRef> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hex = createHash('sha256').update(buf).digest('hex');
    const ref = blobRefFromHash(hex);
    const finalPath = this.pathForRef(ref);
    // Idempotence shortcut: if the file already exists, skip the write.
    try {
      const s = await stat(finalPath);
      if (s.isFile()) return ref;
    } catch {
      // not present; proceed to write.
    }
    const dir = join(this.rootDir, 'blobs', hex.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const tmpName = `.tmp.${randomBytes(8).toString('hex')}`;
    const tmpPath = join(dir, tmpName);
    try {
      await writeFile(tmpPath, buf, { mode: 0o600 });
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort temp cleanup; ignore failures here so we don't
      // shadow the original error with a cleanup failure.
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
    return ref;
  }

  async get(ref: BlobRef): Promise<Buffer> {
    return readFile(this.pathForRef(ref));
  }

  async has(ref: BlobRef): Promise<boolean> {
    try {
      const s = await stat(this.pathForRef(ref));
      return s.isFile();
    } catch {
      return false;
    }
  }

  private pathForRef(ref: BlobRef): string {
    const { hex } = parseBlobRef(ref);
    return join(this.rootDir, 'blobs', hex.slice(0, 2), hex);
  }
}
