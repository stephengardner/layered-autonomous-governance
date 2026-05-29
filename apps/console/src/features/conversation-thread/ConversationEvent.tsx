import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  ExternalLink,
  FileText,
  Info,
  MessageSquare,
  Send,
  Target,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { PrincipalLink } from '@/components/principal-link/PrincipalLink';
import type {
  ConversationEvent as ConversationEventType,
  ConversationEventKind,
  ConversationEventSeverity,
  ConversationDispatchOutcome,
} from '@/services/conversation.service';
import { formatRelative } from './time';
import { ExpandableBody } from './ExpandableBody';
import { ToolCallCard } from './ToolCallCard';
import styles from './ConversationThreadView.module.css';

/**
 * Renders one ConversationEvent as a rail+body card. Switches on
 * `kind` and dispatches to a per-variant body renderer. The rail dot
 * tone is kind-driven (via CSS data-kind attribute); the header
 * principal + timestamp + kind pill are shared across every variant.
 *
 * Why one component with a switch (not 10 separate components):
 *   - The rail / head / meta scaffolding is identical across kinds;
 *     duplicating it would diverge instantly on the next CSS tweak.
 *   - TypeScript discriminated-union switching is exhaustive: a new
 *     event kind added to the union without a matching case here
 *     fails the typecheck (the `never`-typed default arm catches it).
 *
 * Mobile + a11y posture: the parent CSS module handles wrap behaviour
 * on narrow widths (timestamp drops to its own row at ~30rem). The
 * PrincipalLink + AtomRef chips inherit the 44px tap-target floor.
 * Motion is honored via prefers-reduced-motion at the entry level.
 */
export interface ConversationEventProps {
  readonly event: ConversationEventType;
  readonly isLast: boolean;
  readonly index: number;
}

export function ConversationEvent({ event, isLast, index }: ConversationEventProps) {
  const reduceMotion = useReducedMotion();
  // Mount-in animation per canon dev-web-app-grade-polish. Honoring
  // prefers-reduced-motion is mandatory; the reduced-motion branch
  // skips the y-translate so the row simply appears.
  const motionProps = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0 } }
    : {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.18, delay: Math.min(0.04 * index, 0.4) },
    };

  // Per-kind variant for CSS rail-dot tinting + per-kind icon.
  const Icon = iconForKind(event.kind);
  const railSeverity =
    event.kind === 'audit-finding' || event.kind === 'cross-stage-reprompt'
      ? event.severity
      : null;
  const railResult = event.kind === 'dispatch-result' ? event.result : null;

  return (
    <motion.li
      className={styles.entry}
      data-testid="conversation-event"
      data-kind={event.kind}
      data-atom-id={event.atom_id}
      data-is-last={isLast ? 'true' : 'false'}
      {...motionProps}
    >
      <div className={styles.rail} aria-hidden="true">
        <span
          className={styles.railDot}
          data-kind={event.kind}
          {...(railSeverity ? { 'data-severity': railSeverity } : {})}
          {...(railResult ? { 'data-result': railResult } : {})}
        >
          <Icon size={14} strokeWidth={2} />
        </span>
        {!isLast && <span className={styles.railLine} />}
      </div>
      <div className={styles.entryBody}>
        <header className={styles.entryHead}>
          <span className={styles.principalSlot}>
            <PrincipalLink
              id={event.principal_id}
              testId="conversation-event-principal"
            />
          </span>
          <span
            className={styles.kindPill}
            data-variant={variantForKind(event.kind, event)}
            data-testid="conversation-event-kind"
          >
            <Icon size={10} strokeWidth={2.25} aria-hidden="true" />
            {labelForKind(event.kind)}
          </span>
          {event.stage && (
            <code
              className={styles.stageChip}
              data-testid="conversation-event-stage"
            >
              {event.stage}
            </code>
          )}
          <span className={styles.timestamp}>
            <time dateTime={event.ts} title={event.ts}>
              {formatRelative(event.ts)}
            </time>
          </span>
        </header>
        <ConversationEventBody event={event} />
        <div className={styles.metaRow}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Atom</span>
            <AtomRef id={event.atom_id} variant="chip" />
          </span>
        </div>
      </div>
    </motion.li>
  );
}

function ConversationEventBody({ event }: { event: ConversationEventType }) {
  switch (event.kind) {
    case 'operator-intent':
      return (
        <ExpandableBody
          content={event.body.content}
          truncated={event.body.content_truncated}
          testId="conversation-operator-intent-body"
        />
      );
    case 'stage-started':
      return (
        <p className={styles.summary} data-testid="conversation-stage-started-summary">
          Entered <code className={styles.stageChip}>{event.stage}</code>.
        </p>
      );
    case 'agent-prompt':
      return (
        <>
          <p
            className={styles.summary}
            data-testid="conversation-agent-prompt-meta"
          >
            Turn <code>#{event.turn_index}</code>
          </p>
          <ExpandableBody
            content={event.body.content}
            truncated={event.body.content_truncated}
            testId="conversation-agent-prompt-body"
          />
        </>
      );
    case 'agent-response':
      return (
        <>
          <p
            className={styles.summary}
            data-testid="conversation-agent-response-meta"
          >
            Turn <code>#{event.turn_index}</code> &middot; latency{' '}
            <code>{event.latency_ms}ms</code>
          </p>
          <ExpandableBody
            content={event.body.content}
            truncated={event.body.content_truncated}
            testId="conversation-agent-response-body"
          />
        </>
      );
    case 'tool-call':
      return <ToolCallCard event={event} />;
    case 'inter-agent-message':
      return (
        <>
          <p className={styles.summary}>
            <span className={styles.metaLabel}>To</span>{' '}
            <PrincipalLink
              id={event.recipient_principal_id}
              testId="conversation-inter-agent-recipient"
            />
            {event.urgency !== null && (
              <>
                {' '}&middot; <span className={styles.metaLabel}>Urgency</span>{' '}
                <code data-testid="conversation-inter-agent-urgency">
                  {event.urgency}
                </code>
              </>
            )}
          </p>
          <ExpandableBody
            content={event.body.content}
            truncated={event.body.content_truncated}
            testId="conversation-inter-agent-body"
          />
        </>
      );
    case 'cross-stage-reprompt':
      return (
        <>
          <p className={styles.message} data-testid="conversation-reprompt-message">
            {event.message}
          </p>
          <div className={styles.metaRow}>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Attempt</span>
              <code>{event.attempt}</code>
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Category</span>
              <code data-testid="conversation-reprompt-category">
                {event.category}
              </code>
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>From</span>
              <code className={styles.stageChip} data-role="from">
                {event.from_stage}
              </code>
              <ArrowRight size={12} strokeWidth={2.25} aria-hidden="true" />
              <code className={styles.stageChip} data-role="to">
                {event.to_stage}
              </code>
            </span>
            {event.thread_parent && (
              <span className={styles.metaItem}>
                <span className={styles.metaLabel}>Parent</span>
                <AtomRef id={event.thread_parent} variant="chip" />
              </span>
            )}
          </div>
          {event.cited_atom_ids.length > 0 && (
            <div
              className={styles.citationBlock}
              data-testid="conversation-reprompt-cited-atoms"
            >
              <span className={styles.metaLabel}>
                Cited atoms ({event.cited_atom_ids.length})
              </span>
              <ul className={styles.atomRefList}>
                {event.cited_atom_ids.map((id) => (
                  <li key={id}>
                    <AtomRef id={id} variant="chip" />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {event.cited_paths.length > 0 && (
            <div
              className={styles.citationBlock}
              data-testid="conversation-reprompt-cited-paths"
            >
              <span className={styles.metaLabel}>
                Cited paths ({event.cited_paths.length})
              </span>
              <ul className={styles.pathList}>
                {event.cited_paths.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      );
    case 'stage-output':
      return (
        <p
          className={styles.summary}
          data-testid="conversation-stage-output-summary"
        >
          Produced <code data-testid="conversation-stage-output-type">{event.output_type}</code>:{' '}
          {event.summary}
        </p>
      );
    case 'audit-finding':
      return (
        <>
          <p
            className={styles.message}
            data-testid="conversation-audit-finding-message"
          >
            {event.message}
          </p>
          <div className={styles.metaRow}>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Severity</span>
              <code
                data-testid="conversation-audit-finding-severity"
                data-severity={event.severity}
              >
                {event.severity}
              </code>
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Category</span>
              <code data-testid="conversation-audit-finding-category">
                {event.category}
              </code>
            </span>
          </div>
          {event.cited_atom_ids.length > 0 && (
            <div className={styles.citationBlock}>
              <span className={styles.metaLabel}>
                Cited atoms ({event.cited_atom_ids.length})
              </span>
              <ul className={styles.atomRefList}>
                {event.cited_atom_ids.map((id) => (
                  <li key={id}>
                    <AtomRef id={id} variant="chip" />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      );
    case 'dispatch-result':
      return (
        <>
          <p
            className={styles.summary}
            data-testid="conversation-dispatch-result-summary"
          >
            <span className={styles.metaLabel}>Result</span>{' '}
            <code
              data-testid="conversation-dispatch-result-outcome"
              data-result={event.result}
            >
              {event.result}
            </code>
            {event.summary && <> &middot; {event.summary}</>}
          </p>
          {event.pr_url && (
            <a
              className={styles.linkButton}
              href={event.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="conversation-dispatch-result-pr-url"
            >
              Open PR
              <ExternalLink size={12} strokeWidth={2.25} aria-hidden="true" />
            </a>
          )}
        </>
      );
    default: {
      // Exhaustiveness guard: TS narrows `event` to `never` here when
      // the discriminated-union switch above covers every kind. A new
      // kind without a case fails the build at this line.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

// ===== Lookup tables =====

/**
 * Visible export for unit tests. The actual component closes over
 * these helpers; exposing them lets the test exercise every kind in
 * one declarative table without rendering DOM (the vitest environment
 * is node-only per apps/console/vitest.config.ts).
 */
export const _internal = {
  iconForKind,
  labelForKind,
  variantForKind,
  severityToVariant,
  dispatchOutcomeToVariant,
};

/*
 * Why `default` arms ALONGSIDE a compile-time exhaustiveness check:
 *
 * The discriminated-union switches below are exhaustive at TYPE level
 * via the `_exhaustive: never` line in each default arm: any wire-level
 * kind / severity / outcome added without a matching case fails
 * `tsc --noEmit`. The RUNTIME fallback is intentionally kept (forward
 * compatibility per canon dev-indie-floor-org-ceiling: a freshly-shipped
 * client deployed before a substrate vocabulary bump should degrade
 * gracefully to a neutral icon / label / tone, not crash an open
 * conversation thread). Throwing inside the default arm would optimize
 * for compile-time strictness over operator UX; the never-typed
 * statement gives us both.
 */
function assertExhaustive(value: never): never {
  // Only reachable at runtime if the wire vocabulary expanded ahead of
  // the client. Throwing here would fail-loud as CR suggested; we
  // instead let the caller decide a graceful default and rely on the
  // never type for compile-time enforcement.
  throw new Error(
    `assertExhaustive: unreachable conversation-thread enum value '${String(value)}'`,
  );
}

function iconForKind(kind: ConversationEventKind): LucideIcon {
  switch (kind) {
    case 'operator-intent': return Target;
    case 'stage-started': return Workflow;
    case 'agent-prompt': return Send;
    case 'agent-response': return Cpu;
    case 'tool-call': return Cpu;
    case 'inter-agent-message': return MessageSquare;
    case 'cross-stage-reprompt': return AlertTriangle;
    case 'audit-finding': return AlertCircle;
    case 'stage-output': return FileText;
    case 'dispatch-result': return CheckCircle2;
    default: {
      // Compile-time exhaustiveness; runtime falls through to Info.
      const _exhaustive: never = kind;
      void _exhaustive;
      return Info;
    }
  }
}

function labelForKind(kind: ConversationEventKind): string {
  switch (kind) {
    case 'operator-intent': return 'intent';
    case 'stage-started': return 'stage';
    case 'agent-prompt': return 'prompt';
    case 'agent-response': return 'response';
    case 'tool-call': return 'tool';
    case 'inter-agent-message': return 'message';
    case 'cross-stage-reprompt': return 're-prompt';
    case 'audit-finding': return 'finding';
    case 'stage-output': return 'output';
    case 'dispatch-result': return 'dispatch';
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return kind;
    }
  }
}

type KindVariant = 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'default';

function variantForKind(
  kind: ConversationEventKind,
  event: ConversationEventType,
): KindVariant {
  switch (kind) {
    case 'operator-intent': return 'info';
    case 'stage-started': return 'default';
    case 'agent-prompt':
    case 'agent-response': return 'accent';
    case 'tool-call': return 'default';
    case 'inter-agent-message': return 'info';
    case 'cross-stage-reprompt':
    case 'audit-finding':
      return severityToVariant(event.kind === 'audit-finding' || event.kind === 'cross-stage-reprompt'
        ? event.severity
        : 'info');
    case 'stage-output': return 'default';
    case 'dispatch-result':
      return dispatchOutcomeToVariant(event.kind === 'dispatch-result' ? event.result : 'no-op');
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'default';
    }
  }
}

function severityToVariant(severity: ConversationEventSeverity): KindVariant {
  switch (severity) {
    case 'critical': return 'danger';
    case 'major': return 'warning';
    case 'minor': return 'warning';
    case 'info': return 'info';
    default: {
      const _exhaustive: never = severity;
      void _exhaustive;
      return 'default';
    }
  }
}

function dispatchOutcomeToVariant(result: ConversationDispatchOutcome): KindVariant {
  switch (result) {
    case 'pr-opened': return 'success';
    case 'failed': return 'danger';
    case 'silent-skip':
    case 'empty-diff':
    case 'no-op': return 'warning';
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      return 'default';
    }
  }
}

// Tag `assertExhaustive` as referenced so a future change that uses
// the helper does not get flagged for the tsc unused-export warning.
void assertExhaustive;
