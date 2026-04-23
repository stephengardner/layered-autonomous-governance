import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FILES = [
  resolve(HERE, '../../scripts/wt.mjs'),
  resolve(HERE, '../../scripts/lib/wt.mjs'),
];

const FORBIDDEN = [
  /from\s+['"](\.\.\/)+src\//,
  /from\s+['"](\.\.\/)+dist\//,
  /from\s+['"](\.\.\/)+\.lag\//,
  /from\s+['"][^'"]*\/dist\/adapters\//,
  /from\s+['"][^'"]*\/dist\/actors\//,
];

describe('wt CLI portability', () => {
  for (const file of FILES) {
    it(`${file} imports nothing from src/, dist/, or .lag/`, async () => {
      const body = await readFile(file, 'utf8');
      for (const pat of FORBIDDEN) {
        expect(body, `${file} has forbidden import`).not.toMatch(pat);
      }
    });
  }
});
