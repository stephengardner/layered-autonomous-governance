/**
 * Pure filesystem helpers used by the substrate.
 *
 * Kept minimal on purpose: substrate modules (canon/section in particular)
 * need a tiny, dependency-free `mkdir -p` primitive. Larger fs utilities
 * (atomic write, read-or-null, JSON helpers) live in the file adapter
 * where they belong; the substrate is not the place to accumulate a
 * generic fs toolkit.
 */

import { mkdir } from 'node:fs/promises';

/** mkdir -p, idempotent. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
