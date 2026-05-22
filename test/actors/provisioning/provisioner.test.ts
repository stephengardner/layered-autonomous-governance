/**
 * Tests for provisionRole orchestration.
 *
 * The orchestrator walks: exists-check, risk-assess, optional approval,
 * callback-server start, openBrowser, awaitCallback, convertManifestCode,
 * store.save. Every external seam is injected; we mock convertManifestCode
 * and startCallbackServer at the module level, and supply a stub
 * CredentialsStore + approveHighRisk + openBrowser via the request shape.
 *
 * Coverage targets each step's success path AND its failure path:
 *   - exists() short-circuit
 *   - low-risk: skip approval
 *   - high-risk: approval granted
 *   - high-risk: approval denied
 *   - callback rejects (returns failed)
 *   - convertManifestCode rejects with 401 / 403 / 5xx / timeout
 *   - store.save rejects
 *   - openBrowser throws (gracefully logs)
 *   - successful end-to-end happy path returns provisioned outcome
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// The orchestrator at src/runtime/actors/provisioning/provisioner.ts
// imports convertManifestCode from '../../../external/github-app/app-client.js'
// and startCallbackServer from './callback-server.js'. vi.mock paths
// resolve against the importer; we supply absolute-ish paths that
// match what vitest sees post-resolution.
vi.mock('../../../src/external/github-app/app-client.js', () => ({
  convertManifestCode: vi.fn(),
}));

vi.mock('../../../src/runtime/actors/provisioning/callback-server.js', () => ({
  startCallbackServer: vi.fn(),
}));

// eslint-disable-next-line import/first
import { provisionRole } from '../../../src/actors/provisioning/provisioner.js';
// eslint-disable-next-line import/first
import { convertManifestCode } from '../../../src/external/github-app/app-client.js';
// eslint-disable-next-line import/first
import { startCallbackServer } from '../../../src/runtime/actors/provisioning/callback-server.js';
// eslint-disable-next-line import/first
import type {
  AppCredentialsRecord,
  CredentialsStore,
} from '../../../src/actors/provisioning/credentials-store.js';
// eslint-disable-next-line import/first
import type { RoleDefinition } from '../../../src/actors/provisioning/schema.js';

function mkRole(over: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name: 'lag-cto',
    displayName: 'LAG CTO',
    description: 'Decision-bearing actor for architectural plans.',
    permissions: { contents: 'read' },
    events: [],
    ...over,
  };
}

function mkHighRiskRole(): RoleDefinition {
  return mkRole({ permissions: { contents: 'write', administration: 'admin' } });
}

interface StubStoreOptions {
  readonly existsByRole?: Set<string>;
  readonly saveImpl?: (record: AppCredentialsRecord, pem: string) => Promise<void>;
}

function mkStore(opts: StubStoreOptions = {}): CredentialsStore & {
  saveCalls: Array<{ record: AppCredentialsRecord; privateKey: string }>;
} {
  const existsByRole = opts.existsByRole ?? new Set<string>();
  const saveCalls: Array<{ record: AppCredentialsRecord; privateKey: string }> = [];
  const store = {
    stateDir: '/stub',
    appsDir: '/stub/apps',
    keysDir: '/stub/apps/keys',
    saveCalls,
    exists(role: string) { return existsByRole.has(role); },
    async load() { return null; },
    async save(record: AppCredentialsRecord, privateKey: string) {
      saveCalls.push({ record, privateKey });
      if (opts.saveImpl) await opts.saveImpl(record, privateKey);
      existsByRole.add(record.role);
    },
    async update() { /* not used in these tests */ },
    async list() { return []; },
  };
  return store;
}

const CONVERTED = {
  id: 12345,
  slug: 'lag-cto-agent',
  owner: { login: 'my-org', type: 'Organization' },
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOQIB\n-----END RSA PRIVATE KEY-----\n',
  webhook_secret: null,
  client_id: 'Iv1.abc',
  client_secret: 'cs-xyz',
};

beforeEach(() => {
  vi.mocked(convertManifestCode).mockReset();
  vi.mocked(startCallbackServer).mockReset();
  // Default startCallbackServer: returns a handle whose awaitCallback
  // resolves with a valid code+state. Individual tests override.
  vi.mocked(startCallbackServer).mockResolvedValue({
    startUrl: 'http://127.0.0.1:12345/start',
    redirectUrl: 'http://127.0.0.1:12345/callback',
    awaitCallback: async () => ({ code: 'gh-code-abc', state: 'state-xyz' }),
    stop: async () => {},
  });
});

describe('provisionRole', () => {
  it('returns already-provisioned when the credentials store reports the role exists', async () => {
    const role = mkRole();
    const store = mkStore({ existsByRole: new Set(['lag-cto']) });

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('already-provisioned');
    if (outcome.kind === 'already-provisioned') {
      expect(outcome.role).toBe('lag-cto');
    }
    expect(store.saveCalls.length).toBe(0);
  });

  it('skips the approval callback for a low-risk role', async () => {
    const role = mkRole();
    const store = mkStore();
    const approveHighRisk = vi.fn(async () => false);
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('provisioned');
    expect(approveHighRisk).not.toHaveBeenCalled();
  });

  it('returns skipped-by-operator when approveHighRisk denies', async () => {
    const role = mkHighRiskRole();
    const store = mkStore();
    const approveHighRisk = vi.fn(async () => false);

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('skipped-by-operator');
    expect(approveHighRisk).toHaveBeenCalledTimes(1);
    expect(store.saveCalls.length).toBe(0);
  });

  it('proceeds when approveHighRisk grants approval on a high-risk role', async () => {
    const role = mkHighRiskRole();
    const store = mkStore();
    const approveHighRisk = vi.fn(async () => true);
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk,
      openBrowser: () => {},
    });
    expect(approveHighRisk).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('provisioned');
  });

  it('returns failed when the callback server rejects (timeout / state mismatch)', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(startCallbackServer).mockResolvedValueOnce({
      startUrl: 'http://127.0.0.1:12345/start',
      redirectUrl: 'http://127.0.0.1:12345/callback',
      awaitCallback: async () => { throw new Error('callback timed out after 50ms'); },
      stop: async () => {},
    });

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('callback');
      expect(outcome.error).toContain('timed out');
    }
  });

  it('returns failed when convertManifestCode rejects with a 401', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(convertManifestCode).mockRejectedValueOnce(
      new Error('convertManifestCode failed: 401 Unauthorized :: {"message":"Bad credentials"}'),
    );

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('conversion');
      expect(outcome.error).toContain('401');
    }
  });

  it('returns failed when convertManifestCode rejects with a 403', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(convertManifestCode).mockRejectedValueOnce(
      new Error('convertManifestCode failed: 403 Forbidden :: {"message":"Resource not accessible"}'),
    );

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('403');
    }
  });

  it('returns failed when convertManifestCode rejects with a 5xx', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(convertManifestCode).mockRejectedValueOnce(
      new Error('convertManifestCode failed: 502 Bad Gateway :: upstream error'),
    );

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('502');
    }
  });

  it('returns failed when convertManifestCode rejects with a network timeout', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(convertManifestCode).mockRejectedValueOnce(new Error('fetch timeout'));

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('timeout');
    }
  });

  it('returns failed when store.save throws (disk full / permission denied)', async () => {
    const role = mkRole();
    const store = mkStore({
      saveImpl: async () => { throw new Error('EACCES: permission denied'); },
    });
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('store.save');
      expect(outcome.error).toContain('EACCES');
    }
  });

  it('logs but does not fail when openBrowser throws', async () => {
    const role = mkRole();
    const store = mkStore();
    const log = vi.fn();
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => { throw new Error('xdg-open: not found'); },
      log,
    });
    expect(outcome.kind).toBe('provisioned');
    const logLines = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logLines).toContain('openBrowser failed');
  });

  it('returns provisioned with the credentials saved on the happy path', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);
    const onProgress = vi.fn();

    const outcome = await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
      onProgress,
    });
    expect(outcome.kind).toBe('provisioned');
    if (outcome.kind === 'provisioned') {
      expect(outcome.role).toBe('lag-cto');
      expect(outcome.appId).toBe(12345);
      expect(outcome.slug).toBe('lag-cto-agent');
      expect(outcome.owner).toBe('my-org');
    }
    expect(store.saveCalls.length).toBe(1);
    const saved = store.saveCalls[0]!;
    expect(saved.record.role).toBe('lag-cto');
    expect(saved.record.appId).toBe(12345);
    expect(saved.record.slug).toBe('lag-cto-agent');
    expect(saved.record.owner).toBe('my-org');
    expect(saved.privateKey).toBe(CONVERTED.pem);

    // Progress beats sent throughout the flow.
    const stages = onProgress.mock.calls.map((c) => c[0] as string);
    expect(stages).toContain('starting-callback-server');
    expect(stages).toContain('opening-browser');
    expect(stages).toContain('awaiting-callback');
    expect(stages).toContain('exchanging-code');
    expect(stages).toContain('saving-credentials');
  });

  it('threads the timeoutMs through to startCallbackServer', async () => {
    const role = mkRole();
    const store = mkStore();
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
      timeoutMs: 1234,
    });
    const callArgs = vi.mocked(startCallbackServer).mock.calls[0]![0];
    expect(callArgs.timeoutMs).toBe(1234);
  });

  it('threads the role.organization through to startCallbackServer', async () => {
    const role = mkRole({ organization: 'my-org' });
    const store = mkStore();
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });
    const callArgs = vi.mocked(startCallbackServer).mock.calls[0]![0];
    expect(callArgs.organization).toBe('my-org');
  });

  it('builds the manifest with the role displayName + permissions + events', async () => {
    const role = mkRole({
      displayName: 'LAG CTO',
      permissions: { contents: 'read', issues: 'write' },
      events: ['push'],
    });
    const store = mkStore();
    vi.mocked(convertManifestCode).mockResolvedValue(CONVERTED);

    await provisionRole({
      role,
      store,
      approveHighRisk: async () => true,
      openBrowser: () => {},
    });

    const callArgs = vi.mocked(startCallbackServer).mock.calls[0]![0];
    const manifestStr = callArgs.buildManifestJson('http://127.0.0.1:12345/callback');
    const manifest = JSON.parse(manifestStr);
    expect(manifest.name).toBe('LAG CTO');
    expect(manifest.url).toBe('http://127.0.0.1:12345/callback');
    expect(manifest.redirect_url).toBe('http://127.0.0.1:12345/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(manifest.default_events).toEqual(['push']);
    expect(manifest.description).toBe(role.description);
  });
});
