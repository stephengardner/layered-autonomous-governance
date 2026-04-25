export { ResumeAuthorAgentLoopAdapter } from './loop.js';
export type { ResumeAuthorAdapterOptions } from './loop.js';

export { SameMachineCliResumeStrategy } from './strategies/same-machine.js';
export type { SameMachineCliResumeStrategyOptions } from './strategies/same-machine.js';

export { BlobShippedSessionResumeStrategy } from './strategies/blob-shipped.js';
export type { BlobShippedStrategyOptions } from './strategies/blob-shipped.js';

export { walkAuthorSessions } from './walk-author-sessions.js';

export type {
  SessionResumeStrategy,
  CandidateSession,
  ResolvedSession,
  ResumeContext,
} from './types.js';
