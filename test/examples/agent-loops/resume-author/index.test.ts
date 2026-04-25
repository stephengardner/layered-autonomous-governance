import { describe, it, expect } from 'vitest';
import {
  ResumeAuthorAgentLoopAdapter,
  SameMachineCliResumeStrategy,
  BlobShippedSessionResumeStrategy,
  walkAuthorSessions,
} from '../../../../examples/agent-loops/resume-author/index.js';

describe('resume-author barrel', () => {
  it('exports the public surface', () => {
    expect(ResumeAuthorAgentLoopAdapter).toBeDefined();
    expect(SameMachineCliResumeStrategy).toBeDefined();
    expect(BlobShippedSessionResumeStrategy).toBeDefined();
    expect(walkAuthorSessions).toBeDefined();
  });
});
