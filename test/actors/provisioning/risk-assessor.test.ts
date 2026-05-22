/**
 * Tests for the role-risk classifier.
 *
 * Drives every mutating permission key to both write and admin levels
 * and confirms the reasons + triggers reflect the operator-facing
 * audit string the provisioner will render.
 */

import { describe, expect, it } from 'vitest';
import { assessRoleRisk } from '../../../src/actors/provisioning/risk-assessor.js';
import type { RoleDefinition, RolePermissions } from '../../../src/actors/provisioning/schema.js';

function mkRole(perms: RolePermissions): RoleDefinition {
  return {
    name: 'lag-cto',
    displayName: 'LAG CTO',
    description: 'Decision-bearing actor for architectural plans.',
    permissions: perms,
    events: [],
  };
}

describe('assessRoleRisk', () => {
  it('classifies a read-only role as low risk', () => {
    const result = assessRoleRisk(mkRole({ contents: 'read', metadata: 'read' }));
    expect(result.level).toBe('low');
    expect(result.triggers).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  it('classifies an empty-permissions role as low risk', () => {
    const result = assessRoleRisk(mkRole({}));
    expect(result.level).toBe('low');
    expect(result.triggers).toEqual([]);
  });

  it('flags contents:write as high risk with the contents-specific reason', () => {
    const result = assessRoleRisk(mkRole({ contents: 'write' }));
    expect(result.level).toBe('high');
    expect(result.triggers).toEqual([{ key: 'contents', level: 'write' }]);
    expect(result.reasons).toContain('contents:write allows direct commits and file changes');
  });

  it('flags administration:admin as high risk with the admin-specific reason', () => {
    const result = assessRoleRisk(mkRole({ administration: 'admin' }));
    expect(result.level).toBe('high');
    expect(result.triggers).toEqual([{ key: 'administration', level: 'admin' }]);
    expect(result.reasons).toContain('administration:admin grants repo-management access');
  });

  it('flags administration:write with the branch-protection reason', () => {
    const result = assessRoleRisk(mkRole({ administration: 'write' }));
    expect(result.level).toBe('high');
    expect(result.reasons).toContain('administration:write grants branch-protection control');
  });

  it('flags workflows:write with the CI-pipelines reason', () => {
    const result = assessRoleRisk(mkRole({ workflows: 'write' }));
    expect(result.level).toBe('high');
    expect(result.reasons).toContain('workflows:write can modify CI pipelines');
  });

  it('flags multiple high-risk permissions and aggregates triggers', () => {
    const result = assessRoleRisk(mkRole({
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
    }));
    expect(result.level).toBe('high');
    expect(result.triggers.length).toBe(3);
    expect(result.triggers.map((t) => t.key)).toContain('contents');
    expect(result.triggers.map((t) => t.key)).toContain('pull_requests');
    expect(result.triggers.map((t) => t.key)).toContain('issues');
  });

  it('uses the generic write-count reason when no specific reason fires', () => {
    // pull_requests:write triggers but has no specific reason wired up;
    // the generic fallback kicks in.
    const result = assessRoleRisk(mkRole({ pull_requests: 'write' }));
    expect(result.level).toBe('high');
    expect(result.triggers).toEqual([{ key: 'pull_requests', level: 'write' }]);
    expect(result.reasons).toContain('1 write-level permission(s) requested');
  });

  it('flags every mutating permission key when set to admin', () => {
    // Exercises the full MUTATING_KEYS loop branch.
    const result = assessRoleRisk(mkRole({
      contents: 'admin',
      pull_requests: 'admin',
      issues: 'admin',
      checks: 'admin',
      actions: 'admin',
      statuses: 'admin',
      discussions: 'admin',
      workflows: 'admin',
      administration: 'admin',
    }));
    expect(result.level).toBe('high');
    expect(result.triggers.length).toBe(9);
  });

  it('classifies read on a mutating-key as low risk', () => {
    const result = assessRoleRisk(mkRole({ contents: 'read', pull_requests: 'read' }));
    expect(result.level).toBe('low');
    expect(result.triggers).toEqual([]);
  });
});
