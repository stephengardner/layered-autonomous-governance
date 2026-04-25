# GitWorktreeProvider (reference adapter)

Git-worktree-backed `WorkspaceProvider` for the agentic actor loop.

## Indie path

```ts
import { GitWorktreeProvider } from './workspace-providers/git-worktree';
const provider = new GitWorktreeProvider({
  repoDir: '/path/to/your/repo',
  copyCredsForRoles: ['lag-ceo'],
});
const ws = await provider.acquire({
  principal: 'cto-actor',
  baseRef: 'main',
  correlationId: 'demo-1',
});
try {
  // agent runs here at ws.path
} finally {
  await provider.release(ws);
}
```

## What this does

- `git worktree add -b agentic/<corr-id> <path> <baseRef>`
- Optional cred copy for listed roles (`<role>.json` + `<role>.pem`).
- Release: `git worktree remove --force` (idempotent).

## What this does NOT

- No process isolation beyond the OS user. For stronger isolation
  (docker, k8s pod), implement a different `WorkspaceProvider`.
- No GC of stale worktrees from crashed runs. Operators should run
  `git worktree prune` periodically.
- No branch deletion on release. Orphan branches accumulate; clean
  them up via `git for-each-ref --format='%(refname:short)' refs/heads/agentic/`
  + `git branch -D` on the ones whose worktree no longer exists.
