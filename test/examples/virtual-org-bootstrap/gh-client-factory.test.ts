/**
 * GhClient factory composition tests.
 *
 * `createVirtualOrgGhClient` reads the provisioned role record +
 * private key from `<stateDir>/apps/<role>.{json,pem}` and builds an
 * App-backed GhClient. Tests exercise the filesystem side without a
 * live GitHub call: a fake `fetchImpl` is threaded through the auth
 * options so the installation-token mint never leaves the process.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createVirtualOrgGhClient,
} from '../../../src/examples/virtual-org-bootstrap/gh-client-factory.js';

// Generate a throwaway RSA key once for the whole suite so the JWT
// signer has real key material without the test directory ever
// carrying secrets on disk.
let RSA_PEM: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  RSA_PEM = privateKey as string;
});

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'vo-ghc-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function seedRole(
  role: 'lag-ceo' | 'lag-cto' | 'lag-pr-landing',
  record: Readonly<Record<string, unknown>>,
): Promise<void> {
  const appsDir = join(stateDir, 'apps');
  const keysDir = join(appsDir, 'keys');
  await mkdir(keysDir, { recursive: true });
  await writeFile(join(appsDir, `${role}.json`), JSON.stringify(record), 'utf8');
  await writeFile(join(keysDir, `${role}.pem`), RSA_PEM, 'utf8');
}

describe('createVirtualOrgGhClient', () => {
  it('returns a GhClient with rest/graphql/executor/raw surface', async () => {
    await seedRole('lag-ceo', {
      role: 'lag-ceo',
      appId: 1234,
      slug: 'lag-ceo',
      owner: 'stephengardner',
      installationId: 5678,
      createdAt: '2026-04-23T00:00:00.000Z',
      description: 'test record',
    });

    const client = createVirtualOrgGhClient({ role: 'lag-ceo', stateDir });
    expect(client).toBeDefined();
    expect(typeof client.rest).toBe('function');
    expect(typeof client.graphql).toBe('function');
    expect(typeof client.executor).toBe('function');
    expect(typeof client.raw).toBe('function');
  });

  it('throws a clear error when the role record is missing', () => {
    // No seed.
    expect(() =>
      createVirtualOrgGhClient({ role: 'lag-cto', stateDir }),
    ).toThrow(/lag-cto/);
  });

  it('threads fetchImpl through the App auth so no live HTTP call is made', async () => {
    await seedRole('lag-ceo', {
      role: 'lag-ceo',
      appId: 1234,
      slug: 'lag-ceo',
      owner: 'stephengardner',
      installationId: 5678,
      createdAt: '2026-04-23T00:00:00.000Z',
      description: 'test record',
    });

    // Two responses: the installation-token mint and a downstream call.
    const tokenResponse = new Response(
      JSON.stringify({
        token: 'ghs_fake_installation_token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
    const restResponse = new Response(
      JSON.stringify({ login: 'lag-ceo[bot]' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(restResponse);

    const client = createVirtualOrgGhClient({
      role: 'lag-ceo',
      stateDir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.rest({ path: '/user', method: 'GET' });
    expect(result).toEqual({ login: 'lag-ceo[bot]' });
    // First call: JWT -> installation token. Second: /user with the
    // installation token.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('.executor throws on use per the App-backed adapter contract', async () => {
    await seedRole('lag-ceo', {
      role: 'lag-ceo',
      appId: 1234,
      slug: 'lag-ceo',
      owner: 'stephengardner',
      installationId: 5678,
      createdAt: '2026-04-23T00:00:00.000Z',
      description: 'test record',
    });

    const client = createVirtualOrgGhClient({ role: 'lag-ceo', stateDir });
    await expect(client.executor(['status'])).rejects.toThrow(/executor/);
  });
});
