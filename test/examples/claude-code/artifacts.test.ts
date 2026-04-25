import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';
import { captureArtifacts } from '../../../examples/agent-loops/claude-code/artifacts.js';

async function setupRepo(): Promise<{ ws: Workspace; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'lag-pr3-artifacts-'));
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), 'initial\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-m', 'initial'], { cwd: dir });
  return {
    ws: { id: 'ws-test', path: dir, baseRef: 'main' },
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

describe('captureArtifacts', () => {
  it('returns undefined when HEAD === baseRef (no commit)', async () => {
    const { ws, cleanup } = await setupRepo();
    try {
      const out = await captureArtifacts(ws);
      expect(out).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('returns commitSha + branchName + touchedPaths after a commit on a new branch', async () => {
    const { ws, cleanup } = await setupRepo();
    try {
      await execa('git', ['checkout', '-b', 'feat/x'], { cwd: ws.path });
      await writeFile(join(ws.path, 'README.md'), 'updated\n');
      await writeFile(join(ws.path, 'NEW.md'), 'new\n');
      await execa('git', ['add', '.'], { cwd: ws.path });
      await execa('git', ['commit', '-m', 'change'], { cwd: ws.path });
      const out = await captureArtifacts(ws);
      expect(out).toBeDefined();
      if (!out) throw new Error('unreachable');
      expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(out.branchName).toBe('feat/x');
      expect(out.touchedPaths.sort()).toEqual(['NEW.md', 'README.md']);
    } finally {
      await cleanup();
    }
  });

  it('throws if workspace.path does not exist', async () => {
    const ws: Workspace = { id: 'gone', path: join(tmpdir(), 'lag-pr3-nonexistent-' + Date.now()), baseRef: 'main' };
    await expect(captureArtifacts(ws)).rejects.toThrow();
  });
});
