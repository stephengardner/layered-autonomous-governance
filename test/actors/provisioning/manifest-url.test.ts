/**
 * Tests for buildManifestUrl.
 *
 * Pure function; no I/O. Coverage targets: owner-less personal-account
 * URL, owner-set org URL, role.organization fallback, the explicit
 * organization parameter overriding the role hint, and the manifest
 * payload shape (permissions + events round-trip).
 */

import { describe, expect, it } from 'vitest';
import { buildManifestUrl } from '../../../src/actors/provisioning/manifest-url.js';
import type { RoleDefinition } from '../../../src/actors/provisioning/schema.js';

function mkRole(over: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name: 'lag-cto',
    displayName: 'LAG CTO',
    description: 'Decision-bearing actor.',
    permissions: { contents: 'read' },
    events: [],
    ...over,
  };
}

describe('buildManifestUrl', () => {
  it('targets /settings/apps/new when no organization is set', () => {
    const url = buildManifestUrl({
      role: mkRole(),
      state: 'state123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    expect(url).toContain('https://github.com/settings/apps/new');
    expect(url).not.toContain('/organizations/');
  });

  it('targets /organizations/<org>/settings/apps/new when role.organization is set', () => {
    const url = buildManifestUrl({
      role: mkRole({ organization: 'my-org' }),
      state: 'state123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    expect(url).toContain('/organizations/my-org/settings/apps/new');
  });

  it('targets the explicit organization parameter when both role.organization and the parameter are present', () => {
    const url = buildManifestUrl({
      role: mkRole({ organization: 'role-org' }),
      organization: 'param-org',
      state: 'state123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    expect(url).toContain('/organizations/param-org/');
    expect(url).not.toContain('/organizations/role-org/');
  });

  it('honors a custom githubBaseUrl', () => {
    const url = buildManifestUrl({
      role: mkRole(),
      state: 'state123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
      githubBaseUrl: 'https://ghe.example.com',
    });
    expect(url.startsWith('https://ghe.example.com/')).toBe(true);
  });

  it('encodes the state query parameter unchanged', () => {
    const url = buildManifestUrl({
      role: mkRole(),
      state: 'abc-DEF_123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('state')).toBe('abc-DEF_123');
  });

  it('embeds the manifest as JSON in the query string', () => {
    const url = buildManifestUrl({
      role: mkRole({ permissions: { contents: 'write', issues: 'read' }, events: ['push'] }),
      state: 'state123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    const parsed = new URL(url);
    const manifestStr = parsed.searchParams.get('manifest');
    expect(manifestStr).toBeTruthy();
    const manifest = JSON.parse(manifestStr!);
    expect(manifest.name).toBe('LAG CTO');
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({ contents: 'write', issues: 'read' });
    expect(manifest.default_events).toEqual(['push']);
    expect(manifest.redirect_url).toBe('http://127.0.0.1:5000/callback');
    expect(manifest.url).toBe('http://127.0.0.1:5000/callback');
  });

  it('uses setupUrl as manifest.url when supplied; redirect_url is unchanged', () => {
    const url = buildManifestUrl({
      role: mkRole(),
      state: 'state123',
      redirectUrl: 'http://127.0.0.1:5000/callback',
      setupUrl: 'http://127.0.0.1:5000/setup',
    });
    const parsed = new URL(url);
    const manifest = JSON.parse(parsed.searchParams.get('manifest')!);
    expect(manifest.url).toBe('http://127.0.0.1:5000/setup');
    expect(manifest.redirect_url).toBe('http://127.0.0.1:5000/callback');
  });

  it('uri-encodes org slugs with special chars', () => {
    const url = buildManifestUrl({
      role: mkRole(),
      organization: 'org with space',
      state: 's',
      redirectUrl: 'http://127.0.0.1:5000/callback',
    });
    expect(url).toContain('/organizations/org%20with%20space/');
  });
});
