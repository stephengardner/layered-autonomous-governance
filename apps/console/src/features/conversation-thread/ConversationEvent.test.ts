import { describe, it, expect } from 'vitest';
import { _internal } from './ConversationEvent';
import type {
  ConversationEvent,
  ConversationEventKind,
  ConversationEventSeverity,
  ConversationDispatchOutcome,
} from '@/services/conversation.service';

/*
 * Unit tests for the conversation-thread pure helpers.
 *
 * vitest runs under environment: 'node' per apps/console/vitest.config.ts.
 * Component rendering coverage lives in the sibling Playwright spec
 * (tests/e2e/conversation-thread.spec.ts); these unit tests pin the
 * pure lookup tables that pick the icon / label / pill variant per
 * event kind so a typo cannot silently mismap a severity to the wrong
 * color token. Mirrors IntentOutcomeCard.test.tsx posture.
 */

const ALL_KINDS: ReadonlyArray<ConversationEventKind> = [
  'operator-intent',
  'stage-started',
  'agent-prompt',
  'agent-response',
  'tool-call',
  'inter-agent-message',
  'cross-stage-reprompt',
  'stage-output',
  'audit-finding',
  'dispatch-result',
];

const ALL_SEVERITIES: ReadonlyArray<ConversationEventSeverity> = [
  'critical',
  'major',
  'minor',
  'info',
];

const ALL_OUTCOMES: ReadonlyArray<ConversationDispatchOutcome> = [
  'pr-opened',
  'silent-skip',
  'empty-diff',
  'no-op',
  'failed',
];

describe('iconForKind', () => {
  it('returns a renderable component for every kind', () => {
    for (const kind of ALL_KINDS) {
      const Icon = _internal.iconForKind(kind);
      // LucideIcon is a function component; never null/undefined for
      // any in-union kind. The default-arm Info covers forward-compat.
      expect(typeof Icon).toBe('object');
    }
  });
});

describe('labelForKind', () => {
  it('returns a non-empty short label for every kind', () => {
    for (const kind of ALL_KINDS) {
      const label = _internal.labelForKind(kind);
      expect(label.length).toBeGreaterThan(0);
      // Operator-facing label drops the kebab-case suffix where present
      // for prompt/response/etc; never the full kind verbatim except
      // for the lone-word kinds (intent, stage, tool, ...).
      expect(label).not.toContain(' ');
    }
  });

  it('maps cross-stage-reprompt to "re-prompt"', () => {
    expect(_internal.labelForKind('cross-stage-reprompt')).toBe('re-prompt');
  });

  it('maps dispatch-result to "dispatch"', () => {
    expect(_internal.labelForKind('dispatch-result')).toBe('dispatch');
  });
});

describe('severityToVariant', () => {
  it('maps critical to danger', () => {
    expect(_internal.severityToVariant('critical')).toBe('danger');
  });
  it('maps major + minor to warning', () => {
    expect(_internal.severityToVariant('major')).toBe('warning');
    expect(_internal.severityToVariant('minor')).toBe('warning');
  });
  it('maps info to info', () => {
    expect(_internal.severityToVariant('info')).toBe('info');
  });
  it('returns a value for every severity', () => {
    for (const sev of ALL_SEVERITIES) {
      const v = _internal.severityToVariant(sev);
      expect(['danger', 'warning', 'info', 'default']).toContain(v);
    }
  });
});

describe('dispatchOutcomeToVariant', () => {
  it('maps pr-opened to success (green)', () => {
    expect(_internal.dispatchOutcomeToVariant('pr-opened')).toBe('success');
  });
  it('maps failed to danger (red)', () => {
    expect(_internal.dispatchOutcomeToVariant('failed')).toBe('danger');
  });
  it('maps silent-skip / empty-diff / no-op to warning (amber)', () => {
    // These three are the "ran without effect" buckets per
    // trueOutcome's noop semantics; consistently amber so the operator
    // reads them as "needs attention but not terminal".
    expect(_internal.dispatchOutcomeToVariant('silent-skip')).toBe('warning');
    expect(_internal.dispatchOutcomeToVariant('empty-diff')).toBe('warning');
    expect(_internal.dispatchOutcomeToVariant('no-op')).toBe('warning');
  });
  it('returns a value for every outcome', () => {
    for (const r of ALL_OUTCOMES) {
      const v = _internal.dispatchOutcomeToVariant(r);
      expect(['success', 'warning', 'danger', 'default']).toContain(v);
    }
  });
});

describe('variantForKind', () => {
  it('maps operator-intent + inter-agent-message to info', () => {
    expect(_internal.variantForKind('operator-intent', mkEvent('operator-intent'))).toBe('info');
    expect(_internal.variantForKind('inter-agent-message', mkEvent('inter-agent-message'))).toBe('info');
  });

  it('maps agent-prompt + agent-response to accent', () => {
    expect(_internal.variantForKind('agent-prompt', mkEvent('agent-prompt'))).toBe('accent');
    expect(_internal.variantForKind('agent-response', mkEvent('agent-response'))).toBe('accent');
  });

  it('inherits severity for cross-stage-reprompt + audit-finding', () => {
    const crit = mkAuditFinding('critical');
    expect(_internal.variantForKind('audit-finding', crit)).toBe('danger');
    const major = mkCrossStage('major');
    expect(_internal.variantForKind('cross-stage-reprompt', major)).toBe('warning');
  });

  it('inherits result for dispatch-result', () => {
    const success = mkDispatchResult('pr-opened');
    expect(_internal.variantForKind('dispatch-result', success)).toBe('success');
    const failed = mkDispatchResult('failed');
    expect(_internal.variantForKind('dispatch-result', failed)).toBe('danger');
    const noop = mkDispatchResult('silent-skip');
    expect(_internal.variantForKind('dispatch-result', noop)).toBe('warning');
  });
});

// ===== Fixture builders =====

function mkEvent(kind: ConversationEventKind): ConversationEvent {
  switch (kind) {
    case 'operator-intent':
      return {
        kind: 'operator-intent',
        atom_id: 'intent-fixture',
        ts: '2026-05-28T00:00:00.000Z',
        principal_id: 'apex-agent',
        body: { content: 'fixture intent', content_truncated: false },
      };
    case 'stage-started':
      return {
        kind: 'stage-started',
        atom_id: 'pipeline-stage-event-fixture-enter',
        ts: '2026-05-28T00:00:01.000Z',
        principal_id: 'cto-actor',
        stage: 'brainstorm-stage',
      };
    case 'agent-prompt':
      return {
        kind: 'agent-prompt',
        atom_id: 'agent-turn-fixture-prompt',
        ts: '2026-05-28T00:00:02.000Z',
        principal_id: 'cto-actor',
        turn_index: 0,
        session_atom_id: 'agent-session-fixture',
        body: { content: 'fixture prompt', content_truncated: false },
      };
    case 'agent-response':
      return {
        kind: 'agent-response',
        atom_id: 'agent-turn-fixture-response',
        ts: '2026-05-28T00:00:03.000Z',
        principal_id: 'cto-actor',
        turn_index: 0,
        session_atom_id: 'agent-session-fixture',
        body: { content: 'fixture response', content_truncated: false },
        latency_ms: 1234,
      };
    case 'tool-call':
      return {
        kind: 'tool-call',
        atom_id: 'agent-turn-fixture-tool',
        tool_call_index: 0,
        ts: '2026-05-28T00:00:04.000Z',
        principal_id: 'cto-actor',
        parent_turn_index: 0,
        session_atom_id: 'agent-session-fixture',
        tool_name: 'Read',
        args: '{"path":"docs/x.md"}',
        args_truncated: false,
        result: 'file body',
        result_truncated: false,
      };
    case 'inter-agent-message':
      return {
        kind: 'inter-agent-message',
        atom_id: 'ama-fixture',
        ts: '2026-05-28T00:00:05.000Z',
        principal_id: 'cto-actor',
        recipient_principal_id: 'code-author',
        body: { content: 'fixture msg', content_truncated: false },
        urgency: null,
      };
    case 'cross-stage-reprompt':
      return mkCrossStage('major');
    case 'stage-output':
      return {
        kind: 'stage-output',
        atom_id: 'brainstorm-output-fixture',
        ts: '2026-05-28T00:00:06.000Z',
        principal_id: 'cto-actor',
        stage: 'brainstorm-stage',
        output_type: 'brainstorm-output',
        summary: 'fixture summary',
      };
    case 'audit-finding':
      return mkAuditFinding('major');
    case 'dispatch-result':
      return mkDispatchResult('pr-opened');
  }
}

function mkAuditFinding(severity: ConversationEventSeverity): ConversationEvent {
  return {
    kind: 'audit-finding',
    atom_id: 'pipeline-audit-finding-fixture',
    ts: '2026-05-28T00:00:07.000Z',
    principal_id: 'pipeline-auditor',
    severity,
    category: 'fixture-category',
    message: 'fixture message',
    cited_atom_ids: [],
  };
}

function mkCrossStage(severity: ConversationEventSeverity): ConversationEvent {
  return {
    kind: 'cross-stage-reprompt',
    atom_id: 'pipeline-cross-stage-reprompt-fixture',
    ts: '2026-05-28T00:00:08.000Z',
    principal_id: 'cto-actor',
    from_stage: 'dispatch-stage',
    to_stage: 'plan-stage',
    attempt: 1,
    severity,
    category: 'fixture-category',
    message: 'fixture message',
    cited_atom_ids: [],
    cited_paths: [],
    thread_parent: null,
  };
}

function mkDispatchResult(result: ConversationDispatchOutcome): ConversationEvent {
  return {
    kind: 'dispatch-result',
    atom_id: 'observation-fixture',
    ts: '2026-05-28T00:00:09.000Z',
    principal_id: 'code-author-invoker',
    result,
    pr_url: result === 'pr-opened' ? 'https://github.com/fixture/repo/pull/1' : null,
    summary: 'fixture',
  };
}
