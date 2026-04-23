/**
 * GhClient factory for the virtual-org example.
 *
 * Reads a provisioned Actor App record + private key from
 * `<stateDir>/apps/<role>.{json,pem}` and builds an App-backed
 * `GhClient`. The on-disk layout matches `createCredentialsStore`'s
 * convention (same record shape, same key-file path), so credentials
 * produced by the provisioning script load as-is.
 *
 * `fetchImpl` threads into `AppAuthOptions.fetchImpl` so tests can
 * intercept the installation-token mint + downstream REST/GraphQL
 * calls without a live HTTP round-trip. Production omits the option
 * and the adapter uses the built-in `fetch`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppAuthOptions } from '../../external/github-app/app-auth.js';
import { createAppBackedGhClient } from '../../external/github-app/gh-client-adapter.js';
import type { GhClient } from '../../external/github/index.js';

export type VirtualOrgRole = 'lag-ceo' | 'lag-cto' | 'lag-pr-landing';

export interface CreateVirtualOrgGhClientOptions {
  readonly role: VirtualOrgRole;
  /**
   * Directory containing `apps/<role>.json` + `apps/keys/<role>.pem`.
   * Callers typically point at the worktree's `.lag` directory.
   */
  readonly stateDir: string;
  /**
   * Injectable fetch. Tests pass a stub; production omits it so the
   * adapter uses the platform `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Clock shim forwarded to the App JWT signer + token cache. Tests
   * pin this for deterministic expiry math.
   */
  readonly now?: () => number;
}

interface OnDiskAppRecord {
  readonly appId: number;
  readonly installationId?: number;
  readonly slug?: string;
}

export function createVirtualOrgGhClient(
  opts: CreateVirtualOrgGhClientOptions,
): GhClient {
  const appsDir = join(opts.stateDir, 'apps');
  const recordPath = join(appsDir, `${opts.role}.json`);
  const keyPath = join(appsDir, 'keys', `${opts.role}.pem`);

  let recordJson: string;
  try {
    recordJson = readFileSync(recordPath, 'utf8');
  } catch (err) {
    throw new Error(
      `createVirtualOrgGhClient: no App record for role '${opts.role}' at ${recordPath}. `
        + `Provision credentials via bin/lag-actors.js sync. `
        + `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let record: OnDiskAppRecord;
  try {
    record = JSON.parse(recordJson) as OnDiskAppRecord;
  } catch (err) {
    throw new Error(
      `createVirtualOrgGhClient: App record at ${recordPath} is not valid JSON: `
        + `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof record.appId !== 'number') {
    throw new Error(
      `createVirtualOrgGhClient: App record at ${recordPath} is missing numeric 'appId'.`,
    );
  }
  if (typeof record.installationId !== 'number') {
    throw new Error(
      `createVirtualOrgGhClient: App record at ${recordPath} has no 'installationId'. `
        + `Install the App on a repo: https://github.com/apps/${record.slug ?? opts.role}/installations/new`,
    );
  }

  let privateKey: string;
  try {
    privateKey = readFileSync(keyPath, 'utf8');
  } catch (err) {
    throw new Error(
      `createVirtualOrgGhClient: private key for role '${opts.role}' not found at ${keyPath}. `
        + `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const auth: AppAuthOptions = {
    appId: record.appId,
    installationId: record.installationId,
    privateKey,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };

  return createAppBackedGhClient({ auth });
}
