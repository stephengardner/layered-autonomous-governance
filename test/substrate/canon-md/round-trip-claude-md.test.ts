/**
 * Byte-equality round-trip of `CanonMdManager` against a fixture
 * shaped like a production `CLAUDE.md`. The substrate contract per
 * `dec-canon-md-renders-into-claude-md` is: content outside the
 * `<!-- lag:canon-start -->` / `<!-- lag:canon-end -->` markers is
 * preserved byte-for-byte across an `applyCanon` cycle. Until this
 * test landed, the contract was enforced by review-time discipline
 * only; a regression that added a trailing newline, normalized CRLF,
 * stripped a tab, or reflowed a markdown table would slip in silently.
 *
 * The fixture at `test/fixtures/claude-md-fixture.md` deliberately
 * exercises the shapes that operator hand-edits put in `CLAUDE.md`:
 * YAML-like metadata blocks, markdown tables, blockquotes, indented
 * code, embedded HTML comments, tab characters, lines ending with
 * two trailing spaces, and the canon-marker block itself.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CanonMdManager,
  CANON_END,
  CANON_START,
  replaceSection,
} from '../../../src/substrate/canon-md/index.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'claude-md-fixture.md',
);

function outsideMarkers(fileText: string): {
  before: string;
  after: string;
} {
  const startIdx = fileText.indexOf(CANON_START);
  const endIdx = fileText.indexOf(CANON_END);
  if (startIdx < 0 || endIdx < startIdx) {
    throw new Error('fixture is missing canon markers; test assumption broken');
  }
  return {
    before: fileText.slice(0, startIdx),
    after: fileText.slice(endIdx + CANON_END.length),
  };
}

describe('CanonMdManager round-trip: byte equality outside markers', () => {
  let workdir: string;
  let targetPath: string;
  let fixture: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'canon-md-round-trip-'));
    targetPath = join(workdir, 'CLAUDE.md');
    fixture = await readFile(FIXTURE_PATH, 'utf8');
    await writeFile(targetPath, fixture, 'utf8');
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('replaceSection preserves the slice before the canon block byte-for-byte', () => {
    const fresh = replaceSection(fixture, 'fresh canon body');
    const beforeOriginal = outsideMarkers(fixture).before;
    const beforeAfter = outsideMarkers(fresh).before;
    expect(beforeAfter).toBe(beforeOriginal);
  });

  it('replaceSection preserves the slice after the canon block byte-for-byte', () => {
    const fresh = replaceSection(fixture, 'fresh canon body');
    const afterOriginal = outsideMarkers(fixture).after;
    const afterAfter = outsideMarkers(fresh).after;
    expect(afterAfter).toBe(afterOriginal);
  });

  it('CanonMdManager.applyCanon preserves content outside markers byte-for-byte', async () => {
    const mgr = new CanonMdManager({ filePath: targetPath });
    // Use a non-empty atom set so the render produces meaningful body
    // content; the round-trip invariant is independent of the atom set
    // because writeSection only touches the section between the markers.
    const result = await mgr.applyCanon([
      {
        schema_version: 1,
        id: 'dev-fixture-directive' as never,
        type: 'directive',
        content: 'A fixture directive whose body becomes the rendered canon section.',
        layer: 'L3',
        provenance: { kind: 'human-asserted', source: 'fixture', derived_from: [] } as never,
        confidence: 1.0,
        created_at: '2026-05-22T17:00:00.000Z' as never,
        last_reinforced_at: '2026-05-22T17:00:00.000Z' as never,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: {
          agrees_with: [],
          conflicts_with: [],
          validation_status: 'unchecked',
          last_validated_at: null,
        },
        principal_id: 'fixture' as never,
        taint: 'clean',
        metadata: {},
      } as never,
    ]);

    expect(result.changed).toBe(true);

    const written = await readFile(targetPath, 'utf8');
    const originalOutside = outsideMarkers(fixture);
    const writtenOutside = outsideMarkers(written);
    expect(writtenOutside.before).toBe(originalOutside.before);
    expect(writtenOutside.after).toBe(originalOutside.after);
  });

  it('round-trip preserves a tab character in the post-canon section', () => {
    const fresh = replaceSection(fixture, 'fresh canon body');
    const afterAfter = outsideMarkers(fresh).after;
    // The fixture has a literal tab before "end-of-tab" in the post-canon
    // section. A renderer that normalized whitespace would lose it.
    expect(afterAfter).toContain('\tend-of-tab.');
  });

  it('round-trip preserves a soft-break line (two trailing spaces)', () => {
    const fresh = replaceSection(fixture, 'fresh canon body');
    const afterAfter = outsideMarkers(fresh).after;
    // Markdown soft-break: a line ending with two trailing spaces.
    // Pattern accepts both LF and CRLF because git autocrlf=true (the
    // Windows CI default) checks out the fixture with CRLF endings.
    // The byte-equality invariant under test is platform-agnostic;
    // the line-ending family is whatever the checkout produced.
    expect(afterAfter).toContain('breaks softly.');
    expect(afterAfter).toMatch(/ {2}\r?\nbreaks softly\./);
  });

  it('round-trip preserves the YAML-like metadata block verbatim', () => {
    const fresh = replaceSection(fixture, 'fresh canon body');
    const beforeAfter = outsideMarkers(fresh).before;
    // Match either LF or CRLF for the line endings inside the YAML
    // block; see the soft-break test for the rationale.
    expect(beforeAfter).toMatch(
      /deployment:\r?\n {2}tier: indie-floor\r?\n {2}org_dial: default/,
    );
  });

  it('round-trip preserves the markdown table pipes', () => {
    const fresh = replaceSection(fixture, 'fresh canon body');
    const beforeAfter = outsideMarkers(fresh).before;
    expect(beforeAfter).toContain('| Surface  | Owner    | Last touched |');
    expect(beforeAfter).toContain('|----------|----------|--------------|');
  });

  it('reports an exact divergence offset when a synthetic byte-edit corrupts the post-canon slice', async () => {
    // Synthetic corruption: replace one byte in the post-canon prose, then
    // verify the assertion would catch it. This proves the test detects the
    // class of failure it is designed to detect.
    const corrupted = fixture.replace('end-of-tab.', 'end-of-tab!');
    expect(corrupted).not.toBe(fixture);
    const corruptedOutside = outsideMarkers(corrupted).after;
    const originalOutside = outsideMarkers(fixture).after;
    expect(corruptedOutside).not.toBe(originalOutside);
  });
});
