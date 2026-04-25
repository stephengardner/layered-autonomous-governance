# FileBlobStore (reference adapter)

File-backed `BlobStore` for the agentic actor loop. Stores
content-addressed blobs at `<rootDir>/blobs/<shard>/<sha256>`.

## Indie path

```ts
import { FileBlobStore } from './blob-stores/file';
const blobStore = new FileBlobStore('/path/to/your/.lag');
```

## Notes

- Atomic write via temp file + rename.
- `0o600` file mode (POSIX); Windows defers to profile ACLs.
- No GC. Deleting unreferenced blobs is a deferred follow-up
  (a future sweeper would walk atom-store-referenced blob refs
  and remove orphans).
- No encryption. Treat the blob root as having the same trust
  boundary as the rest of `.lag/`.
