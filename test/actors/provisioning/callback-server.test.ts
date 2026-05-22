/**
 * Tests for startCallbackServer.
 *
 * The callback server is the loopback HTTP endpoint GitHub redirects
 * to after the operator approves a new App. Coverage targets:
 *   - successful round-trip via real loopback fetch
 *   - state mismatch rejection on /callback
 *   - missing code/state rejection on /callback
 *   - 404 on an unrelated path
 *   - 409 when callback fires twice
 *   - /start endpoint serves the auto-submitting form HTML
 *   - org URL routing in the form action
 *   - timeout rejection
 *   - manual stop() is idempotent
 *   - escapeHtml protects against angle-brackets in successLabel
 *   - missing req.url returns 400
 */

import { describe, expect, it, afterEach } from 'vitest';
import { startCallbackServer } from '../../../src/actors/provisioning/callback-server.js';
import type { CallbackServerHandle } from '../../../src/actors/provisioning/callback-server.js';

const handles: CallbackServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()!;
    try { await h.stop(); } catch { /* best effort */ }
  }
});

function track(h: CallbackServerHandle): CallbackServerHandle {
  handles.push(h);
  return h;
}

const MANIFEST = (url: string) => JSON.stringify({ name: 'x', url, redirect_url: url });

describe('startCallbackServer', () => {
  it('resolves the awaitCallback promise with the code+state on a valid GET /callback', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: MANIFEST,
    }));

    const callbackUrl = new URL(handle.redirectUrl);
    callbackUrl.searchParams.set('code', 'abc123');
    callbackUrl.searchParams.set('state', 'mystate');
    // Hit the callback endpoint from the test process.
    const fetchPromise = fetch(callbackUrl.toString());
    const result = await handle.awaitCallback();
    expect(result.code).toBe('abc123');
    expect(result.state).toBe('mystate');
    const resp = await fetchPromise;
    expect(resp.status).toBe(200);
  });

  it('rejects on state mismatch with a 400 + error HTML', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: MANIFEST,
    }));

    // Attach the awaitCallback rejection listener BEFORE firing the
    // request so the unhandled-rejection channel never sees the error.
    const awaiting = expect(handle.awaitCallback()).rejects.toThrow(/state mismatch/);
    const callbackUrl = new URL(handle.redirectUrl);
    callbackUrl.searchParams.set('code', 'abc123');
    callbackUrl.searchParams.set('state', 'wrong');
    const resp = await fetch(callbackUrl.toString());
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain('state mismatch');
    await awaiting;
  });

  it('rejects on missing code/state with a 400', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: MANIFEST,
    }));

    // Attach the awaitCallback rejection listener BEFORE firing the
    // request so the unhandled-rejection channel never sees the error.
    const awaiting = expect(handle.awaitCallback()).rejects.toThrow(/missing code or state/);
    const resp = await fetch(handle.redirectUrl);
    expect(resp.status).toBe(400);
    await awaiting;
  });

  it('returns 404 on an unrelated path', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: MANIFEST,
    }));

    const u = new URL(handle.redirectUrl);
    const otherUrl = `http://${u.host}/unrelated`;
    const resp = await fetch(otherUrl);
    expect(resp.status).toBe(404);
  });

  it('returns 409 if the callback fires twice', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: MANIFEST,
    }));

    const callbackUrl = new URL(handle.redirectUrl);
    callbackUrl.searchParams.set('code', 'abc123');
    callbackUrl.searchParams.set('state', 'mystate');
    const first = await fetch(callbackUrl.toString());
    expect(first.status).toBe(200);
    const second = await fetch(callbackUrl.toString());
    expect(second.status).toBe(409);
    await handle.awaitCallback();
  });

  it('serves the auto-submitting form HTML on /start', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      successLabel: 'my-actor',
      buildManifestJson: MANIFEST,
    }));

    const resp = await fetch(handle.startUrl);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain('<form');
    expect(body).toContain('action="https://github.com/settings/apps/new"');
    expect(body).toContain('name="manifest"');
    expect(body).toContain('name="state"');
    expect(body).toContain('value="mystate"');
    // Cleanup since the awaitCallback() promise has not resolved.
    await handle.stop();
  });

  it('routes /start form action to /organizations/<org>/settings/apps/new when organization is set', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      organization: 'my-org',
      buildManifestJson: MANIFEST,
    }));

    const resp = await fetch(handle.startUrl);
    const body = await resp.text();
    expect(body).toContain('action="https://github.com/organizations/my-org/settings/apps/new"');
    await handle.stop();
  });

  it('rejects via timeout when no callback arrives', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      timeoutMs: 50,
      buildManifestJson: MANIFEST,
    }));

    await expect(handle.awaitCallback()).rejects.toThrow(/timed out/);
  });

  it('stop() is idempotent (safe to call twice)', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: MANIFEST,
    }));

    await handle.stop();
    await expect(handle.stop()).resolves.not.toThrow();
  });

  it('escapes HTML in the successLabel rendered to the operator', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      successLabel: '<script>alert(1)</script>',
      buildManifestJson: MANIFEST,
    }));

    const callbackUrl = new URL(handle.redirectUrl);
    callbackUrl.searchParams.set('code', 'abc123');
    callbackUrl.searchParams.set('state', 'mystate');
    const resp = await fetch(callbackUrl.toString());
    const body = await resp.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
    await handle.awaitCallback();
  });

  it('honors custom callbackPath and startPath options', async () => {
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      callbackPath: '/cb',
      startPath: '/go',
      buildManifestJson: MANIFEST,
    }));

    expect(handle.startUrl).toMatch(/\/go$/);
    expect(handle.redirectUrl).toMatch(/\/cb$/);
    const u = new URL(handle.redirectUrl);
    u.searchParams.set('code', 'c');
    u.searchParams.set('state', 'mystate');
    await fetch(u.toString());
    await handle.awaitCallback();
  });

  it('supplies redirectUrl back to the buildManifestJson callback so the manifest can embed it', async () => {
    let observedRedirect: string | null = null;
    const handle = track(await startCallbackServer({
      expectedState: 'mystate',
      buildManifestJson: (redirectUrl) => {
        observedRedirect = redirectUrl;
        return JSON.stringify({ url: redirectUrl, redirect_url: redirectUrl });
      },
    }));

    expect(observedRedirect).not.toBeNull();
    expect(observedRedirect).toBe(handle.redirectUrl);
    await handle.stop();
  });
});
