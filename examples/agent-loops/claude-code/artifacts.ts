/**
 * Post-CLI artifact capture. Runs three git commands inside the
 * workspace to determine whether a commit was made and what files
 * were touched. `workspace.baseRef` is read directly from the
 * substrate `Workspace` shape (provider-set, trusted).
 *
 * Returns `undefined` when HEAD === baseRef (no commit). Executor
 * maps that to `agentic/no-artifacts`.
 */

import { execa, type execa as ExecaType } from 'execa';
import type { Workspace } from '../../../src/substrate/workspace-provider.js';

export interface AgentLoopArtifacts {
  readonly commitSha: string;
  readonly branchName: string;
  readonly touchedPaths: ReadonlyArray<string>;
}

export async function captureArtifacts(
  workspace: Workspace,
  execImpl: typeof ExecaType = execa,
): Promise<AgentLoopArtifacts | undefined> {
  const { stdout: currentSha } = await execImpl('git', ['rev-parse', 'HEAD'], { cwd: workspace.path });
  const { stdout: baseSha } = await execImpl('git', ['rev-parse', workspace.baseRef], { cwd: workspace.path });
  if (currentSha.trim() === baseSha.trim()) {
    return undefined;
  }
  const { stdout: branchName } = await execImpl('git', ['branch', '--show-current'], { cwd: workspace.path });
  const { stdout: namesOnly } = await execImpl(
    'git',
    ['diff', '--name-only', `${workspace.baseRef}..HEAD`],
    { cwd: workspace.path },
  );
  const touchedPaths = namesOnly.split(/\r?\n/).filter((s) => s.length > 0);
  return {
    commitSha: currentSha.trim(),
    branchName: branchName.trim(),
    touchedPaths,
  };
}
