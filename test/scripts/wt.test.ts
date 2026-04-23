import { describe, expect, it } from 'vitest';
import { validateSlug } from '../../scripts/lib/wt.mjs';

describe('validateSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(validateSlug('kill-switch-cli')).toEqual({ ok: true, slug: 'kill-switch-cli' });
  });
  it('accepts single-word slugs', () => {
    expect(validateSlug('substrate')).toEqual({ ok: true, slug: 'substrate' });
  });
  it('rejects empty strings', () => {
    const r = validateSlug('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|required/i);
  });
  it('rejects slugs over 40 chars', () => {
    const long = 'a'.repeat(41);
    const r = validateSlug(long);
    expect(r.ok).toBe(false);
  });
  it('rejects slashes and spaces', () => {
    expect(validateSlug('feat/foo').ok).toBe(false);
    expect(validateSlug('foo bar').ok).toBe(false);
  });
  it('rejects leading or trailing dashes', () => {
    expect(validateSlug('-foo').ok).toBe(false);
    expect(validateSlug('foo-').ok).toBe(false);
  });
  it('normalizes uppercase to lowercase', () => {
    expect(validateSlug('Foo-Bar')).toEqual({ ok: true, slug: 'foo-bar' });
  });
});
