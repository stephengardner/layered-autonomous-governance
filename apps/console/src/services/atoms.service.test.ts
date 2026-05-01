import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAtomById } from './atoms.service';
import { transport } from './transport';

/*
 * `getAtomById` wraps transport.call('atoms.get'). The contract:
 *   - returns the AnyAtom on success
 *   - returns null when the backend reports atom-not-found (via the
 *     standard error envelope: error.code === 'atom-not-found')
 *   - rethrows any other transport error
 */

describe('getAtomById', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the atom from a successful transport call', async () => {
    const mock = vi.spyOn(transport, 'call').mockResolvedValue({
      id: 'plan-abc',
      type: 'plan',
      layer: 'L1',
      content: 'body',
      principal_id: 'cto-actor',
      confidence: 0.9,
      created_at: '2026-04-29T00:00:00Z',
    });
    const out = await getAtomById('plan-abc');
    expect(out?.id).toBe('plan-abc');
    expect(mock).toHaveBeenCalledWith(
      'atoms.get',
      { id: 'plan-abc' },
      undefined,
    );
  });

  it('passes an abort signal through to the transport when provided', async () => {
    const ctrl = new AbortController();
    const mock = vi.spyOn(transport, 'call').mockResolvedValue({
      id: 'plan-abc',
      type: 'plan',
      layer: 'L1',
      content: 'body',
      principal_id: 'cto-actor',
      confidence: 0.9,
      created_at: '2026-04-29T00:00:00Z',
    });
    await getAtomById('plan-abc', ctrl.signal);
    expect(mock).toHaveBeenCalledWith(
      'atoms.get',
      { id: 'plan-abc' },
      { signal: ctrl.signal },
    );
  });

  it('returns null when the backend reports atom-not-found (Error.name)', async () => {
    const err = new Error('atom-not-found: no atom with id mystery');
    err.name = 'atom-not-found';
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    const out = await getAtomById('mystery');
    expect(out).toBeNull();
  });

  it('returns null when the message starts with atom-not-found (legacy shape)', async () => {
    const err = new Error('atom-not-found: legacy shape');
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    const out = await getAtomById('mystery');
    expect(out).toBeNull();
  });

  it('rethrows other transport errors (network, 500)', async () => {
    const err = new Error('http-500: server crashed');
    err.name = 'http-500';
    vi.spyOn(transport, 'call').mockRejectedValue(err);
    await expect(getAtomById('plan-abc')).rejects.toThrow(/http-500/);
  });
});
