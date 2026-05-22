/**
 * Tests for loadRoleRegistry + findRole.
 *
 * Coverage targets: success path on a real roles.json fixture, missing
 * file rejection, malformed-JSON rejection, schema-validation rejection,
 * and findRole hit / miss behavior.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRole,
  loadRoleRegistry,
} from '../../../src/actors/provisioning/role-loader.js';
import type { RoleRegistry } from '../../../src/actors/provisioning/schema.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lag-role-loader-'));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function writeRoles(content: string): string {
  const path = join(tempDir, 'roles.json');
  writeFileSync(path, content, 'utf8');
  return path;
}

const VALID_REGISTRY = {
  version: 1,
  actors: [
    {
      name: 'lag-cto',
      displayName: 'LAG CTO',
      description: 'Decision-bearing actor for architectural plans.',
      permissions: { contents: 'read' },
      events: [],
    },
    {
      name: 'lag-ceo',
      displayName: 'LAG CEO',
      description: 'Operator-proxy actor for human-routed work.',
      permissions: { contents: 'write', pull_requests: 'write' },
      events: ['pull_request'],
    },
  ],
};

describe('loadRoleRegistry', () => {
  it('loads and parses a valid roles file', async () => {
    const path = writeRoles(JSON.stringify(VALID_REGISTRY, null, 2));
    const registry = await loadRoleRegistry(path);
    expect(registry.version).toBe(1);
    expect(registry.actors.length).toBe(2);
    expect(registry.actors[0]!.name).toBe('lag-cto');
  });

  it('rejects a missing file', async () => {
    const missing = join(tempDir, 'does-not-exist.json');
    await expect(loadRoleRegistry(missing)).rejects.toThrow(/not found/);
  });

  it('rejects malformed JSON', async () => {
    const path = writeRoles('{ not json');
    await expect(loadRoleRegistry(path)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a registry that fails schema validation', async () => {
    const path = writeRoles(JSON.stringify({
      version: 1,
      actors: [{
        name: 'TOO_LONG_AND_UPPERCASE',
        displayName: 'X',
        description: 'short',
        permissions: {},
        events: [],
      }],
    }));
    await expect(loadRoleRegistry(path)).rejects.toThrow(/schema validation failed/);
  });

  it('rejects an empty actors array via schema validation', async () => {
    const path = writeRoles(JSON.stringify({ version: 1, actors: [] }));
    await expect(loadRoleRegistry(path)).rejects.toThrow(/schema validation failed/);
  });

  it('rejects version other than 1', async () => {
    const path = writeRoles(JSON.stringify({
      version: 2,
      actors: VALID_REGISTRY.actors,
    }));
    await expect(loadRoleRegistry(path)).rejects.toThrow(/schema validation failed/);
  });
});

describe('findRole', () => {
  const registry: RoleRegistry = VALID_REGISTRY as RoleRegistry;

  it('returns the matching actor', () => {
    const role = findRole(registry, 'lag-cto');
    expect(role).not.toBeNull();
    expect(role?.name).toBe('lag-cto');
  });

  it('returns null when no actor matches', () => {
    const role = findRole(registry, 'nonexistent');
    expect(role).toBeNull();
  });

  it('returns null for an empty actors list', () => {
    const empty: RoleRegistry = { version: 1, actors: [] as never as RoleRegistry['actors'] };
    expect(findRole(empty, 'anything')).toBeNull();
  });
});
