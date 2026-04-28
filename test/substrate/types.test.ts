import { describe, expect, it } from 'vitest';
import type { AtomType } from '../../src/substrate/types.js';

describe('AtomType union (planning-pipeline extension)', () => {
  it('accepts the six new pipeline atom types', () => {
    const types: AtomType[] = [
      'spec',
      'pipeline',
      'pipeline-stage-event',
      'pipeline-audit-finding',
      'pipeline-failed',
      'pipeline-resume',
    ];
    expect(types.length).toBe(6);
  });
});
