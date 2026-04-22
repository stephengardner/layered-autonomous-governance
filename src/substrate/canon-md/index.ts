/**
 * Canon-md: read, generate, and write a bracketed canon section in a
 * target markdown file. Target-neutral - the file path and title are
 * caller-supplied; this module does not assume CLAUDE.md or any
 * specific product.
 *
 * Usage:
 *   const mgr = new CanonMdManager({ filePath: '/path/to/target.md' });
 *   const atoms = (await host.atoms.query({ layer: ['L3'] }, 1000)).atoms;
 *   const result = await mgr.applyCanon(atoms);
 *   if (result.changed) {
 *     // wrote a changed section; caller decides how to announce it.
 *   }
 */

import type { Atom, Principal } from '../types.js';
import { renderCanonMarkdown, type RenderOptions } from './generator.js';
import {
  renderForPrincipal,
  type RenderForOptions,
} from './render-for.js';
import {
  CANON_END,
  CANON_START,
  readFileOrEmpty,
  readSection,
  replaceSection,
  writeSection,
  type CanonSectionWriteResult,
} from './section.js';

export interface CanonMdManagerOptions {
  readonly filePath: string;
}

export class CanonMdManager {
  constructor(private readonly options: CanonMdManagerOptions) {}

  get filePath(): string {
    return this.options.filePath;
  }

  async readFull(): Promise<string> {
    return readFileOrEmpty(this.options.filePath);
  }

  async readSection(): Promise<string> {
    return readSection(this.options.filePath);
  }

  /**
   * Render the atoms as markdown and write them into the bracketed section.
   * Returns a diff summary.
   */
  async applyCanon(
    atoms: ReadonlyArray<Atom>,
    renderOptions: RenderOptions = {},
  ): Promise<CanonSectionWriteResult> {
    const rendered = renderCanonMarkdown(atoms, renderOptions);
    return writeSection(this.options.filePath, rendered);
  }

  /**
   * Dry-run: compute what the file WOULD look like after applying the atoms,
   * without writing.
   */
  async previewCanon(
    atoms: ReadonlyArray<Atom>,
    renderOptions: RenderOptions = {},
  ): Promise<{ before: string; after: string; changed: boolean }> {
    const rendered = renderCanonMarkdown(atoms, renderOptions);
    const before = await this.readFull();
    const after = replaceSection(before, rendered);
    return { before, after, changed: before !== after };
  }

  /**
   * Render a principal-scoped canon view and write it to the target file.
   *
   * Filters atoms to what the principal is permitted to read per
   * `permitted_layers.read`, optionally biases by role-scoped tags, and
   * prepends a header identifying the principal (id, role, goals,
   * constraints). The result is written to the bracketed canon section
   * of the target file, preserving content outside the markers.
   *
   * Used by the virtual-org runtime to give each agent its own
   * CLAUDE.md; the global `applyCanon` remains available for the
   * top-level project canon.
   */
  async renderFor(args: {
    principal: Principal;
    atoms: ReadonlyArray<Atom>;
    roleTagFilter?: Readonly<Record<string, readonly string[]>>;
    renderOptions?: RenderForOptions;
  }): Promise<CanonSectionWriteResult> {
    const rendered = renderForPrincipal({
      principal: args.principal,
      atoms: args.atoms,
      ...(args.roleTagFilter !== undefined
        ? { roleTagFilter: args.roleTagFilter }
        : {}),
      ...(args.renderOptions ?? {}),
    });
    return writeSection(this.options.filePath, rendered);
  }
}

export {
  CANON_END,
  CANON_START,
  extractSection,
  readFileOrEmpty,
  readSection,
  replaceSection,
  writeSection,
} from './section.js';
export { renderCanonMarkdown } from './generator.js';
export { renderForPrincipal } from './render-for.js';
export type { CanonSectionWriteResult } from './section.js';
export type { RenderOptions } from './generator.js';
export type { RenderForOptions, RenderForArgs } from './render-for.js';
