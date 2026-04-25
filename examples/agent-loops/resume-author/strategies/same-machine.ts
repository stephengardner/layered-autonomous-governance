import type {
  SessionResumeStrategy,
  ResolvedSession,
  ResumeContext,
} from '../types.js';

const DEFAULT_MAX_STALE_HOURS = 8;
const HOUR_MS = 60 * 60 * 1000;

export interface SameMachineCliResumeStrategyOptions {
  readonly maxStaleHours?: number;
}

/**
 * Resume strategy for same-machine deployments: filters candidate sessions
 * to those produced by the claude-code agent-loop adapter, returns the
 * freshest one within maxStaleHours. No preparation needed -- the local
 * Claude CLI reads its own session cache from ~/.claude/projects/<slug>/.
 *
 * No data flow off the local machine; no exfiltration surface beyond what
 * the operator's existing local Claude session already has access to.
 */
export class SameMachineCliResumeStrategy implements SessionResumeStrategy {
  readonly name = 'same-machine-cli';
  private readonly maxStaleMs: number;

  constructor(opts?: SameMachineCliResumeStrategyOptions) {
    this.maxStaleMs = (opts?.maxStaleHours ?? DEFAULT_MAX_STALE_HOURS) * HOUR_MS;
  }

  async findResumableSession(ctx: ResumeContext): Promise<ResolvedSession | null> {
    const compatible = ctx.candidateSessions.filter(s => s.adapterId === 'claude-code-agent-loop');
    const fresh = compatible.find(s => Date.now() - new Date(s.startedAt).getTime() < this.maxStaleMs);
    if (fresh === undefined) return null;
    return {
      resumableSessionId: fresh.resumableSessionId,
      resumedFromSessionAtomId: fresh.sessionAtomId,
      strategyName: this.name,
    };
  }
}
