import { describe, it, expect } from 'vitest';
import type { WorkspaceProvider, Workspace, AcquireInput } from '../../src/substrate/workspace-provider.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const SAMPLE_INPUT: AcquireInput = {
  principal: 'test-principal' as PrincipalId,
  baseRef: 'main',
  correlationId: 'corr-test-1',
};

export function runWorkspaceProviderContract(name: string, build: () => WorkspaceProvider) {
  describe(`WorkspaceProvider contract: ${name}`, () => {
    it('acquire returns absolute workspace path', async () => {
      const p = build();
      const ws = await p.acquire(SAMPLE_INPUT);
      try {
        expect(ws.path).toMatch(/^([A-Za-z]:)?[/\\]/);
        expect(ws.baseRef).toBe('main');
      } finally {
        await p.release(ws);
      }
    });

    it('release is idempotent', async () => {
      const p = build();
      const ws = await p.acquire(SAMPLE_INPUT);
      await p.release(ws);
      // Second release MUST NOT throw.
      await p.release(ws);
    });

    it('acquired workspaces have distinct ids', async () => {
      const p = build();
      const a = await p.acquire(SAMPLE_INPUT);
      const b = await p.acquire({ ...SAMPLE_INPUT, correlationId: 'corr-test-2' });
      try {
        expect(a.id).not.toBe(b.id);
      } finally {
        await p.release(a);
        await p.release(b);
      }
    });
  });
}

describe('workspace-provider module', () => {
  it('exports types', () => {
    const ws: Workspace = { id: 'x', path: '/tmp/x', baseRef: 'main' };
    expect(ws.id).toBe('x');
  });
});
