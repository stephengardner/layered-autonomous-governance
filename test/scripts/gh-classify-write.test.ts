/**
 * Unit tests for scripts/lib/gh-classify-write.mjs.
 *
 * The classifier gates the operator-action atom write so reads
 * (gh pr view, gh repo view, status polls) do not pollute the
 * atom store. Pre-fix every gh-as invocation wrote one atom; in a
 * busy session that drowns the file-host atom scan and overplots
 * load-bearing atoms in timeline projections.
 *
 * As per coding guidelines: small, focused cases with literal
 * expected values; no elaborate test helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  isGhWriteInvocation,
  shouldWriteOperatorActionAtom,
} from '../../scripts/lib/gh-classify-write.mjs';

describe('isGhWriteInvocation: pr / issue / release subcommands', () => {
  it('classifies known mutating subcommands as writes', () => {
    expect(isGhWriteInvocation(['pr', 'create', '--title', 't'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'edit', '123', '--body', 'b'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'close', '123'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'reopen', '123'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'merge', '123', '--squash'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'comment', '123', '--body', 'hi'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'ready', '123'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'lock', '123'])).toBe(true);
    expect(isGhWriteInvocation(['issue', 'create', '--title', 't'])).toBe(true);
    expect(isGhWriteInvocation(['issue', 'edit', '5'])).toBe(true);
    expect(isGhWriteInvocation(['release', 'create', 'v1'])).toBe(true);
  });

  it('classifies pure read subcommands as not-writes', () => {
    expect(isGhWriteInvocation(['pr', 'view', '123'])).toBe(false);
    expect(isGhWriteInvocation(['pr', 'list'])).toBe(false);
    expect(isGhWriteInvocation(['pr', 'status'])).toBe(false);
    expect(isGhWriteInvocation(['pr', 'diff', '123'])).toBe(false);
    expect(isGhWriteInvocation(['pr', 'checks', '123'])).toBe(false);
    expect(isGhWriteInvocation(['repo', 'view'])).toBe(false);
    expect(isGhWriteInvocation(['issue', 'view', '5'])).toBe(false);
    expect(isGhWriteInvocation(['issue', 'list'])).toBe(false);
    expect(isGhWriteInvocation(['run', 'list'])).toBe(false);
    expect(isGhWriteInvocation(['run', 'view', '12345'])).toBe(false);
    expect(isGhWriteInvocation(['run', 'download', '12345'])).toBe(false);
  });

  it('namespace-specific mutating verbs across release / repo / workflow / run', () => {
    expect(isGhWriteInvocation(['release', 'delete-asset', 'v1', 'asset.tar'])).toBe(true);
    expect(isGhWriteInvocation(['repo', 'rename', 'new-name'])).toBe(true);
    expect(isGhWriteInvocation(['repo', 'archive', 'owner/name'])).toBe(true);
    expect(isGhWriteInvocation(['workflow', 'disable', 'ci.yml'])).toBe(true);
    expect(isGhWriteInvocation(['workflow', 'enable', 'ci.yml'])).toBe(true);
    expect(isGhWriteInvocation(['run', 'cancel', '12345'])).toBe(true);
    expect(isGhWriteInvocation(['run', 'rerun', '12345'])).toBe(true);
    expect(isGhWriteInvocation(['run', 'delete', '12345'])).toBe(true);
  });

  it('pr review: alone is a read; --approve / --comment / --request-changes are writes', () => {
    expect(isGhWriteInvocation(['pr', 'review', '123'])).toBe(false);
    expect(isGhWriteInvocation(['pr', 'review', '123', '--approve'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'review', '123', '--request-changes', '-b', 'fix'])).toBe(true);
    expect(isGhWriteInvocation(['pr', 'review', '123', '--comment', '-b', 'note'])).toBe(true);
  });
});

describe('isGhWriteInvocation: gh api', () => {
  it('default GET (no method, no field flags) is a read', () => {
    expect(isGhWriteInvocation(['api', 'repos/foo/bar/pulls/1'])).toBe(false);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '--jq', '.name'])).toBe(false);
  });

  it('-X POST / --method POST (separated form) is a write', () => {
    expect(isGhWriteInvocation(['api', 'repos/foo/bar/issues/1/labels', '-X', 'POST', '-f', 'labels[]=x'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar/pulls', '--method', 'POST'])).toBe(true);
  });

  it('inline -X=POST / --method=POST is a write', () => {
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-X=PATCH'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '--method=DELETE'])).toBe(true);
  });

  it('PUT / PATCH / DELETE are writes', () => {
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-X', 'PUT'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-X', 'PATCH'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-X', 'DELETE'])).toBe(true);
  });

  it('-X GET (explicit) is a read', () => {
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-X', 'GET'])).toBe(false);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '--method=GET'])).toBe(false);
  });

  it('-X GET with field flags stays a read (explicit method overrides field-flag implication)', () => {
    // gh accepts `-f foo=bar` on a forced GET as a query-string
    // shorthand. The explicit method beats the field-flag-implies-
    // POST heuristic, so the audit chain treats it as a read.
    expect(
      isGhWriteInvocation(['api', 'repos/foo/bar', '-X', 'GET', '-f', 'foo=bar']),
    ).toBe(false);
    expect(
      isGhWriteInvocation(['api', 'repos/foo/bar', '--method=GET', '--field=foo=bar']),
    ).toBe(false);
  });

  it('-X POST with field flags is a write (explicit method matches field-flag heuristic)', () => {
    // The field flags would imply POST anyway; the explicit method
    // just makes the intent unambiguous. Both paths converge on
    // the same audit decision.
    expect(
      isGhWriteInvocation(['api', 'repos/foo/bar', '-X', 'POST', '-f', 'name=test']),
    ).toBe(true);
    expect(
      isGhWriteInvocation(['api', 'repos/foo/bar', '--method=PATCH', '--field=name=test']),
    ).toBe(true);
  });

  it('field flags (-f / -F / --field / --raw-field) imply POST', () => {
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-f', 'name=test'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '-F', 'count=5'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '--field', 'name=test'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '--field=name=test'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'repos/foo/bar', '--raw-field=body=hi'])).toBe(true);
  });

  it('lowercase verbs still detected (defensive)', () => {
    expect(isGhWriteInvocation(['api', 'x', '-X', 'post'])).toBe(true);
    expect(isGhWriteInvocation(['api', 'x', '--method=delete'])).toBe(true);
  });
});

describe('isGhWriteInvocation: defensive defaults', () => {
  it('returns false for empty / non-array input', () => {
    expect(isGhWriteInvocation([])).toBe(false);
    expect(isGhWriteInvocation(undefined as unknown as string[])).toBe(false);
    expect(isGhWriteInvocation(null as unknown as string[])).toBe(false);
  });

  it('returns false for unrecognized top-level subcommands (default-deny audit)', () => {
    // A future gh subcommand the classifier does not enumerate is
    // treated as a read. If the audit chain is load-bearing, the
    // operator opts back in via LAG_OP_ACTION_ATOMIZE=all.
    expect(isGhWriteInvocation(['auth', 'status'])).toBe(false);
    expect(isGhWriteInvocation(['completion', 'bash'])).toBe(false);
    expect(isGhWriteInvocation(['some-future-subcommand', 'mutate'])).toBe(false);
  });
});

describe('shouldWriteOperatorActionAtom env modes', () => {
  it('default: writes only on isGhWriteInvocation', () => {
    expect(shouldWriteOperatorActionAtom(['pr', 'view', '1'], {})).toBe(false);
    expect(shouldWriteOperatorActionAtom(['pr', 'create', '-t', 'x'], {})).toBe(true);
  });

  it('LAG_OP_ACTION_ATOMIZE=all forces every invocation to write', () => {
    expect(
      shouldWriteOperatorActionAtom(['pr', 'view', '1'], { LAG_OP_ACTION_ATOMIZE: 'all' }),
    ).toBe(true);
    expect(
      shouldWriteOperatorActionAtom(['repo', 'view'], { LAG_OP_ACTION_ATOMIZE: 'all' }),
    ).toBe(true);
  });

  it('LAG_SKIP_OPERATOR_ACTION_ATOM=1 disables every write (existing escape hatch)', () => {
    expect(
      shouldWriteOperatorActionAtom(['pr', 'create', '-t', 'x'], { LAG_SKIP_OPERATOR_ACTION_ATOM: '1' }),
    ).toBe(false);
    // Skip beats atomize-all when both are set.
    expect(
      shouldWriteOperatorActionAtom(['pr', 'create', '-t', 'x'], {
        LAG_SKIP_OPERATOR_ACTION_ATOM: '1',
        LAG_OP_ACTION_ATOMIZE: 'all',
      }),
    ).toBe(false);
  });
});
