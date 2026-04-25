import { describe, it, expect } from 'vitest';
import { ResumeAuthorAgentLoopAdapter } from '../../../../examples/agent-loops/resume-author/loop.js';
import type {
  SessionResumeStrategy,
  CandidateSession,
  ResolvedSession,
} from '../../../../examples/agent-loops/resume-author/types.js';
import type {
  AdapterCapabilities,
  AgentLoopAdapter,
  AgentLoopInput,
  AgentLoopResult,
} from '../../../../src/substrate/agent-loop.js';
import { defaultClassifyFailure } from '../../../../src/substrate/agent-loop.js';
import type { Workspace } from '../../../../src/substrate/workspace-provider.js';
import type { BlobStore, BlobRef } from '../../../../src/substrate/blob-store.js';
import type { Redactor } from '../../../../src/substrate/redactor.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
} from '../../../../src/substrate/types.js';
import { createMemoryHost } from '../../../../src/adapters/memory/index.js';
import { randomBytes } from 'node:crypto';

const PRINCIPAL = 'agentic-code-author' as PrincipalId;
const WS: Workspace = { id: 'ws-1', path: '/tmp/stub-ws', baseRef: 'main' };
const NOOP_REDACTOR: Redactor = { redact: (s) => s };

function inMemBlob(): BlobStore {
  const m = new Map<string, Buffer>();
  return {
    put: async (c) => {
      const buf = typeof c === 'string' ? Buffer.from(c) : c;
      const ref = `sha256:${randomBytes(32).toString('hex')}` as BlobRef;
      m.set(ref, buf);
      return ref;
    },
    get: async (r) => m.get(r as string)!,
    has: async (r) => m.has(r as string),
    describeStorage: () => ({ kind: 'remote' as const, target: 'in-memory:test' }),
  };
}

function mkInput(host: ReturnType<typeof createMemoryHost>): AgentLoopInput {
  return {
    host,
    principal: PRINCIPAL,
    workspace: WS,
    task: { planAtomId: 'plan-1' as AtomId, questionPrompt: 'do X' },
    budget: { max_turns: 10, max_wall_clock_ms: 60_000, max_usd: 1 },
    toolPolicy: { disallowedTools: [] },
    redactor: NOOP_REDACTOR,
    blobStore: inMemBlob(),
    replayTier: 'content-addressed',
    blobThreshold: 4096,
    correlationId: 'corr-1',
  };
}

const FALLBACK_CAPS: AdapterCapabilities = {
  tracks_cost: true,
  supports_signal: true,
  classify_failure: defaultClassifyFailure,
};

interface FallbackCall {
  readonly resumeSessionId: string | undefined;
  readonly input: AgentLoopInput;
}

interface RecordingFallbackOptions {
  readonly results?: ReadonlyArray<AgentLoopResult>;
  readonly throwOn?: ReadonlyArray<number>;
  readonly capabilities?: AdapterCapabilities;
}

function makeRecordingFallback(
  host: ReturnType<typeof createMemoryHost>,
  opts: RecordingFallbackOptions = {},
): AgentLoopAdapter & { readonly calls: ReadonlyArray<FallbackCall> } {
  const calls: FallbackCall[] = [];
  let invocation = 0;
  const fb: AgentLoopAdapter & { readonly calls: FallbackCall[] } = {
    capabilities: opts.capabilities ?? FALLBACK_CAPS,
    calls,
    run: async (input: AgentLoopInput): Promise<AgentLoopResult> => {
      const i = invocation;
      invocation += 1;
      calls.push({ resumeSessionId: input.resumeSessionId, input });
      if (opts.throwOn !== undefined && opts.throwOn.includes(i)) {
        throw new Error(`fallback throw on call ${i}`);
      }
      const sessionId = `session-${i}-${randomBytes(4).toString('hex')}` as AtomId;
      const sessionAtom: Atom = {
        schema_version: 1,
        id: sessionId,
        content: '',
        type: 'agent-session',
        layer: 'L1',
        provenance: {
          kind: 'agent-observed',
          source: { agent_id: input.principal as unknown as string },
          derived_from: [],
        },
        confidence: 1,
        created_at: new Date().toISOString(),
        last_reinforced_at: new Date().toISOString(),
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'project',
        signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
        principal_id: input.principal,
        taint: 'clean',
        metadata: {
          agent_session: {
            model_id: 'claude-opus-4-7',
            adapter_id: 'claude-code-agent-loop',
            workspace_id: input.workspace.id,
            started_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            terminal_state: 'completed',
            replay_tier: input.replayTier,
            budget_consumed: { turns: 1, wall_clock_ms: 100 },
            extra: input.resumeSessionId !== undefined ? { resumable_session_id: input.resumeSessionId } : {},
          },
        },
      };
      await host.atoms.put(sessionAtom);
      const canned = opts.results?.[i];
      if (canned !== undefined) {
        // Replace session id so consumer sees a real atom written above.
        return { ...canned, sessionAtomId: sessionId };
      }
      return {
        kind: 'completed',
        sessionAtomId: sessionId,
        turnAtomIds: [],
      };
    },
  };
  return fb;
}

interface RecordingStrategyOptions {
  readonly name?: string;
  readonly returns?: ResolvedSession | null;
  readonly throws?: boolean;
  readonly preparation?: () => Promise<void>;
}

function makeRecordingStrategy(opts: RecordingStrategyOptions): SessionResumeStrategy & {
  readonly findCalls: ReadonlyArray<number>;
} {
  let invokes = 0;
  const findCalls: number[] = [];
  return {
    name: opts.name ?? 'stub',
    findCalls,
    async findResumableSession() {
      invokes += 1;
      findCalls.push(invokes);
      if (opts.throws === true) throw new Error('strategy threw');
      const r = opts.returns ?? null;
      if (r === null) return null;
      if (opts.preparation !== undefined) {
        return { ...r, preparation: opts.preparation };
      }
      return r;
    },
  };
}

const NEVER_ASSEMBLE: (input: AgentLoopInput) => Promise<ReadonlyArray<CandidateSession>> = async () => [];

describe('ResumeAuthorAgentLoopAdapter -- construction', () => {
  it('throws when fallback is undefined', () => {
    expect(
      () =>
        new ResumeAuthorAgentLoopAdapter({
          fallback: undefined as unknown as AgentLoopAdapter,
          host: createMemoryHost(),
          strategies: [],
          assembleCandidates: NEVER_ASSEMBLE,
        }),
    ).toThrow(/fallback is required/);
  });

  it('throws when fallback is null', () => {
    expect(
      () =>
        new ResumeAuthorAgentLoopAdapter({
          fallback: null as unknown as AgentLoopAdapter,
          host: createMemoryHost(),
          strategies: [],
          assembleCandidates: NEVER_ASSEMBLE,
        }),
    ).toThrow(/fallback is required/);
  });

  it('mirrors the fallback capabilities', () => {
    const host = createMemoryHost();
    const customCaps: AdapterCapabilities = {
      tracks_cost: false,
      supports_signal: false,
      classify_failure: defaultClassifyFailure,
    };
    const fb = makeRecordingFallback(host, { capabilities: customCaps });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    expect(wrapper.capabilities).toBe(fb.capabilities);
    expect(wrapper.capabilities.tracks_cost).toBe(false);
    expect(wrapper.capabilities.supports_signal).toBe(false);
  });
});

describe('ResumeAuthorAgentLoopAdapter -- strategy resolution', () => {
  it('first non-null strategy wins; resume invocation runs with resumeSessionId set; later strategies skipped', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    const winner = makeRecordingStrategy({
      name: 'first',
      returns: {
        resumableSessionId: 'first-uuid',
        resumedFromSessionAtomId: 'a' as AtomId,
        strategyName: 'first',
      },
    });
    const second = makeRecordingStrategy({
      name: 'second',
      returns: {
        resumableSessionId: 'second-uuid',
        resumedFromSessionAtomId: 'b' as AtomId,
        strategyName: 'second',
      },
    });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner, second],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    const result = await wrapper.run(mkInput(host));
    expect(result.kind).toBe('completed');
    expect(fb.calls).toHaveLength(1);
    expect(fb.calls[0]!.resumeSessionId).toBe('first-uuid');
    expect(winner.findCalls).toHaveLength(1);
    expect(second.findCalls).toHaveLength(0);
  });

  it('all strategies return null -> delegates directly to fallback without resumeSessionId', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    const s1 = makeRecordingStrategy({ name: 'a', returns: null });
    const s2 = makeRecordingStrategy({ name: 'b', returns: null });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [s1, s2],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    await wrapper.run(mkInput(host));
    expect(fb.calls).toHaveLength(1);
    expect(fb.calls[0]!.resumeSessionId).toBeUndefined();
    expect(s1.findCalls).toHaveLength(1);
    expect(s2.findCalls).toHaveLength(1);
  });

  it('strategy throws -> falls through to fallback without resumeSessionId', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    const thrower = makeRecordingStrategy({ throws: true });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [thrower],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    await wrapper.run(mkInput(host));
    expect(fb.calls).toHaveLength(1);
    expect(fb.calls[0]!.resumeSessionId).toBeUndefined();
  });

  it('assembleCandidates throws -> falls through to fallback without resumeSessionId', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [makeRecordingStrategy({ returns: null })],
      assembleCandidates: async () => {
        throw new Error('assemble crashed');
      },
    });
    await wrapper.run(mkInput(host));
    expect(fb.calls).toHaveLength(1);
    expect(fb.calls[0]!.resumeSessionId).toBeUndefined();
  });

  it('assembleCandidates is called with the run input', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    let assembleSeen: AgentLoopInput | undefined;
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [makeRecordingStrategy({ returns: null })],
      assembleCandidates: async (input) => {
        assembleSeen = input;
        return [];
      },
    });
    const i = mkInput(host);
    await wrapper.run(i);
    expect(assembleSeen).toBe(i);
  });

  it('strategies receive candidates from assembleCandidates in ResumeContext', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    let ctxSeen: { length: number } | undefined;
    const observer: SessionResumeStrategy = {
      name: 'observer',
      async findResumableSession(ctx) {
        ctxSeen = { length: ctx.candidateSessions.length };
        return null;
      },
    };
    const candidates: ReadonlyArray<CandidateSession> = [
      {
        sessionAtomId: 'a' as AtomId,
        resumableSessionId: 'u1',
        startedAt: new Date().toISOString(),
        extra: {},
        adapterId: 'claude-code-agent-loop',
      },
      {
        sessionAtomId: 'b' as AtomId,
        resumableSessionId: 'u2',
        startedAt: new Date().toISOString(),
        extra: {},
        adapterId: 'claude-code-agent-loop',
      },
    ];
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [observer],
      assembleCandidates: async () => candidates,
    });
    await wrapper.run(mkInput(host));
    expect(ctxSeen?.length).toBe(2);
  });
});

describe('ResumeAuthorAgentLoopAdapter -- resume failure paths', () => {
  it('strategy resolves but resume returns non-completed -> wrapper delegates to fallback fresh-spawn', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host, {
      results: [
        {
          kind: 'budget-exhausted',
          sessionAtomId: 'placeholder' as AtomId,
          turnAtomIds: [],
        },
      ],
    });
    const winner = makeRecordingStrategy({
      name: 'first',
      returns: {
        resumableSessionId: 'r-uuid',
        resumedFromSessionAtomId: 'src' as AtomId,
        strategyName: 'first',
      },
    });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    const result = await wrapper.run(mkInput(host));
    expect(fb.calls).toHaveLength(2);
    expect(fb.calls[0]!.resumeSessionId).toBe('r-uuid');
    expect(fb.calls[1]!.resumeSessionId).toBeUndefined();
    expect(result.kind).toBe('completed');
  });

  it('strategy resolves but resume throws -> wrapper delegates to fallback fresh-spawn', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host, { throwOn: [0] });
    const winner = makeRecordingStrategy({
      name: 'first',
      returns: {
        resumableSessionId: 'r-uuid',
        resumedFromSessionAtomId: 'src' as AtomId,
        strategyName: 'first',
      },
    });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    const result = await wrapper.run(mkInput(host));
    expect(fb.calls).toHaveLength(2);
    expect(fb.calls[0]!.resumeSessionId).toBe('r-uuid');
    expect(fb.calls[1]!.resumeSessionId).toBeUndefined();
    expect(result.kind).toBe('completed');
  });

  it('preparation throws -> wrapper delegates to fallback fresh-spawn (preparation failure does not retry resume)', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    const winner = makeRecordingStrategy({
      name: 'first',
      returns: {
        resumableSessionId: 'r-uuid',
        resumedFromSessionAtomId: 'src' as AtomId,
        strategyName: 'first',
      },
      preparation: async () => {
        throw new Error('preparation failed');
      },
    });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    await wrapper.run(mkInput(host));
    // Only ONE call to fallback (the fresh-spawn after prep failure), no resume attempt.
    expect(fb.calls).toHaveLength(1);
    expect(fb.calls[0]!.resumeSessionId).toBeUndefined();
  });
});

describe('ResumeAuthorAgentLoopAdapter -- preparation ordering', () => {
  it('preparation runs BEFORE resume spawn', async () => {
    const host = createMemoryHost();
    const events: string[] = [];
    const fb: AgentLoopAdapter = {
      capabilities: FALLBACK_CAPS,
      run: async (input: AgentLoopInput): Promise<AgentLoopResult> => {
        events.push(`fallback-run(resumeSessionId=${input.resumeSessionId ?? 'undef'})`);
        const sessionId = `s-${randomBytes(4).toString('hex')}` as AtomId;
        const atom: Atom = {
          schema_version: 1,
          id: sessionId,
          content: '',
          type: 'agent-session',
          layer: 'L1',
          provenance: {
            kind: 'agent-observed',
            source: { agent_id: input.principal as unknown as string },
            derived_from: [],
          },
          confidence: 1,
          created_at: new Date().toISOString(),
          last_reinforced_at: new Date().toISOString(),
          expires_at: null,
          supersedes: [],
          superseded_by: [],
          scope: 'project',
          signals: { agrees_with: [], conflicts_with: [], validation_status: 'unchecked', last_validated_at: null },
          principal_id: input.principal,
          taint: 'clean',
          metadata: {
            agent_session: {
              model_id: 'claude-opus-4-7',
              adapter_id: 'claude-code-agent-loop',
              workspace_id: input.workspace.id,
              started_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
              terminal_state: 'completed',
              replay_tier: input.replayTier,
              budget_consumed: { turns: 1, wall_clock_ms: 100 },
              extra: {},
            },
          },
        };
        await host.atoms.put(atom);
        return { kind: 'completed', sessionAtomId: sessionId, turnAtomIds: [] };
      },
    };
    const winner: SessionResumeStrategy = {
      name: 'with-prep',
      async findResumableSession() {
        events.push('strategy-find');
        return {
          resumableSessionId: 'r-uuid',
          resumedFromSessionAtomId: 'src' as AtomId,
          strategyName: 'with-prep',
          preparation: async () => {
            events.push('preparation');
          },
        };
      },
    };
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    await wrapper.run(mkInput(host));
    expect(events).toEqual([
      'strategy-find',
      'preparation',
      'fallback-run(resumeSessionId=r-uuid)',
    ]);
  });
});

describe('ResumeAuthorAgentLoopAdapter -- success metadata patch', () => {
  it('patches the resumed session atom with extra.resumed_from_atom_id and extra.resume_strategy_used', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    const winner = makeRecordingStrategy({
      name: 'same-machine-cli',
      returns: {
        resumableSessionId: 'r-uuid',
        resumedFromSessionAtomId: 'source-session-atom' as AtomId,
        strategyName: 'same-machine-cli',
      },
    });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    const result = await wrapper.run(mkInput(host));
    expect(result.kind).toBe('completed');
    const atom = await host.atoms.get(result.sessionAtomId);
    expect(atom).not.toBeNull();
    const meta = atom!.metadata as Record<string, unknown>;
    const agentSession = meta['agent_session'] as Record<string, unknown>;
    const extra = agentSession['extra'] as Record<string, unknown>;
    expect(extra['resumed_from_atom_id']).toBe('source-session-atom');
    expect(extra['resume_strategy_used']).toBe('same-machine-cli');
  });

  it('patch failure on update is non-fatal; resume result is still returned as-is', async () => {
    const host = createMemoryHost();
    const fb = makeRecordingFallback(host);
    // After the fallback writes the atom, replace host.atoms.update so the
    // patch step throws. Wrapper should swallow and still return the
    // success result.
    const origUpdate = host.atoms.update.bind(host.atoms);
    let updateCalled = 0;
    host.atoms.update = async (id, patch) => {
      updateCalled += 1;
      throw new Error('update boom');
    };
    const winner = makeRecordingStrategy({
      name: 's',
      returns: {
        resumableSessionId: 'r-uuid',
        resumedFromSessionAtomId: 'src' as AtomId,
        strategyName: 's',
      },
    });
    const wrapper = new ResumeAuthorAgentLoopAdapter({
      fallback: fb,
      host,
      strategies: [winner],
      assembleCandidates: NEVER_ASSEMBLE,
    });
    const result = await wrapper.run(mkInput(host));
    expect(result.kind).toBe('completed');
    expect(updateCalled).toBeGreaterThan(0);
    // Restore for subsequent tests in the same suite.
    host.atoms.update = origUpdate;
  });
});
