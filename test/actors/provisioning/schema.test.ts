/**
 * Tests for the Actor provisioning Zod schemas.
 *
 * Coverage targets: rolePermissionsSchema, roleDefinitionSchema,
 * roleRegistrySchema. All three are pure validators; we exercise the
 * accept path, every constraint, and the strict-mode rejection on
 * extra keys.
 */

import { describe, expect, it } from 'vitest';
import {
  roleDefinitionSchema,
  rolePermissionsSchema,
  roleRegistrySchema,
} from '../../../src/actors/provisioning/schema.js';

describe('rolePermissionsSchema', () => {
  it('accepts an empty permissions object', () => {
    const result = rolePermissionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts every documented permission key with read/write/admin', () => {
    const result = rolePermissionsSchema.safeParse({
      contents: 'read',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
      checks: 'write',
      actions: 'admin',
      statuses: 'write',
      discussions: 'write',
      workflows: 'write',
      administration: 'admin',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown permission level', () => {
    const result = rolePermissionsSchema.safeParse({ contents: 'sudo' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown permission key (strict mode)', () => {
    const result = rolePermissionsSchema.safeParse({ unknown_key: 'read' });
    expect(result.success).toBe(false);
  });
});

describe('roleDefinitionSchema', () => {
  const validRole = {
    name: 'lag-cto',
    displayName: 'LAG CTO',
    description: 'Senior decision-bearing actor for architectural plans.',
    permissions: { contents: 'read' as const },
    events: [],
  };

  it('accepts a minimal valid role', () => {
    const result = roleDefinitionSchema.safeParse(validRole);
    expect(result.success).toBe(true);
  });

  it('accepts a role with all optional fields populated', () => {
    const result = roleDefinitionSchema.safeParse({
      ...validRole,
      organization: 'my-org',
      events: ['pull_request', 'push'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects name shorter than 3 chars', () => {
    const result = roleDefinitionSchema.safeParse({ ...validRole, name: 'ab' });
    expect(result.success).toBe(false);
  });

  it('rejects name longer than 60 chars', () => {
    const long = 'a'.repeat(61);
    const result = roleDefinitionSchema.safeParse({ ...validRole, name: long });
    expect(result.success).toBe(false);
  });

  it('rejects name with uppercase or invalid chars', () => {
    const cases = ['lag_cto', 'lagCTO', 'lag.cto', '-lag', 'lag-'];
    for (const name of cases) {
      const result = roleDefinitionSchema.safeParse({ ...validRole, name });
      expect(result.success).toBe(false);
    }
  });

  it('rejects displayName shorter than 3 chars', () => {
    const result = roleDefinitionSchema.safeParse({ ...validRole, displayName: 'ab' });
    expect(result.success).toBe(false);
  });

  it('rejects description shorter than 10 chars', () => {
    const result = roleDefinitionSchema.safeParse({ ...validRole, description: 'too short' });
    expect(result.success).toBe(false);
  });

  it('rejects description longer than 1024 chars', () => {
    const long = 'x'.repeat(1025);
    const result = roleDefinitionSchema.safeParse({ ...validRole, description: long });
    expect(result.success).toBe(false);
  });

  it('rejects an extra top-level key (strict mode)', () => {
    const result = roleDefinitionSchema.safeParse({ ...validRole, extra: true });
    expect(result.success).toBe(false);
  });

  it('defaults events to an empty array when omitted', () => {
    const { events: _omit, ...withoutEvents } = validRole;
    const result = roleDefinitionSchema.safeParse(withoutEvents);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toEqual([]);
    }
  });
});

describe('roleRegistrySchema', () => {
  const oneActor = {
    name: 'lag-cto',
    displayName: 'LAG CTO',
    description: 'Senior decision-bearing actor for architectural plans.',
    permissions: { contents: 'read' as const },
    events: [],
  };

  it('accepts a minimal valid registry', () => {
    const result = roleRegistrySchema.safeParse({ version: 1, actors: [oneActor] });
    expect(result.success).toBe(true);
  });

  it('rejects version other than 1', () => {
    const result = roleRegistrySchema.safeParse({ version: 2, actors: [oneActor] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty actors array', () => {
    const result = roleRegistrySchema.safeParse({ version: 1, actors: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an extra top-level key (strict mode)', () => {
    const result = roleRegistrySchema.safeParse({
      version: 1,
      actors: [oneActor],
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});
