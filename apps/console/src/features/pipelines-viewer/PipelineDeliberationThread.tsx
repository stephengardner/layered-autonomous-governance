import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Info,
  MessageSquare,
} from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { ErrorState } from '@/components/state-display/StateDisplay';
import {
  getPipelineDeliberation,
  type PipelineDeliberationEntry,
  type PipelineDeliberationResult,
  type PipelineDeliberationSeverity,
} from '@/services/pipelines.service';
import { formatRelative } from './PipelinesView';
import styles from './PipelineDeliberationThread.module.css';

/**
 * Pipeline cross-stage deliberation thread.
 *
 * Renders the chain of `pipeline-cross-stage-reprompt` atoms for a
 * given pipeline as a sequence of FROM_STAGE to TO_STAGE handoffs.
 * Each entry surfaces the severity-bucketed finding, attempt counter,
 * cited atoms/paths, and thread_parent pointer so the operator can
 * walk the deliberation in chronological chain order.
 *
 * The substrate's planning-pipeline runner emits one atom per
 * cross-stage walk; the surface is dormant unless
 * `pol-cross-stage-reprompt-default` is seeded (the runner's branching
 * logic is policy-gated). Even when policy is dormant, this component
 * still renders any atoms that exist (per the Phase 2 PR5 contract).
 *
 * Render rules:
 *   - entries empty: render nothing (hidden cleanly so the detail view
 *     does not show empty-state clutter).
 *   - entries non-empty: render a Section with one card per entry,
 *     ordered by attempt ascending. Each card links to the cross-stage
 *     atom (AtomRef hover-card), shows the finding severity pill, and
 *     surfaces cited atoms + paths inline.
 *
 * Polling: 10s while data is fresh; consistent with the sibling
 * PipelineLifecycle cadence. The SSE stream pushes cache invalidation
 * when a new cross-stage atom lands so the visible latency is
 * sub-second on the happy path; the polling backstop only matters when
 * SSE drops.
 */
export function PipelineDeliberationThread({
  pipelineId,
}: {
  pipelineId: string;
}) {
  const query = useQuery({
    queryKey: ['pipeline', pipelineId, 'deliberation'],
    queryFn: ({ signal }) => getPipelineDeliberation(pipelineId, signal),
    refetchInterval: (queryState) => {
      // Match the lifecycle surface posture:
      //   - pipeline-not-found: keep polling at 10s; a fresh pipeline
      //     may have just been created.
      //   - other error: back off (false).
      //   - data present: poll every 10s. The deliberation chain is
      //     append-only; new entries can land at any time while the
      //     pipeline is running.
      const err = queryState.state.error;
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('pipeline-not-found')) return 10_000;
        return false;
      }
      return 10_000;
    },
    refetchOnWindowFocus: true,
    // Treat 404 as non-error so the component renders nothing rather
    // than a noisy error block when the pipeline is new.
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('pipeline-not-found')) return false;
      return failureCount < 2;
    },
  });

  // Hide cleanly when the surface is dormant. Three early-return
  // branches: still-loading (no UI flash on first paint), 404 (treat
  // as empty), or empty entries array (substrate has not emitted any
  // cross-stage walks for this pipeline). All three render nothing so
  // the pipeline detail view does not show empty-state clutter when
  // the cross-stage feature is dormant.
  if (query.isPending) return null;
  if (query.isError) {
    const msg = query.error instanceof Error ? query.error.message : String(query.error);
    if (msg.includes('pipeline-not-found')) return null;
    return (
      <section
        className={styles.section}
        data-testid="pipeline-deliberation-thread"
        data-state="error"
      >
        <SectionHead count={null} />
        <ErrorState
          title="Could not load deliberation thread"
          message={msg}
          testId="pipeline-deliberation-thread-error"
        />
      </section>
    );
  }
  const data = query.data;
  if (!data || data.entries.length === 0) return null;

  return <DeliberationBody data={data} />;
}

function SectionHead({ count }: { count: number | null }) {
  return (
    <header className={styles.sectionHead}>
      <span className={styles.sectionIcon} aria-hidden="true">
        <MessageSquare size={14} strokeWidth={2} />
      </span>
      <h3 className={styles.sectionTitle}>Cross-stage deliberation</h3>
      {count !== null && (
        <span className={styles.sectionCount} data-testid="pipeline-deliberation-count">
          {count}
        </span>
      )}
    </header>
  );
}

function DeliberationBody({ data }: { data: PipelineDeliberationResult }) {
  return (
    <section
      className={styles.section}
      data-testid="pipeline-deliberation-thread"
      data-state="populated"
      data-pipeline-id={data.pipeline_id}
    >
      <SectionHead count={data.entries.length} />
      <p className={styles.intro}>
        The runner walked back from the auditing stage to an upstream stage
        when a critical finding flagged a re-prompt target. Each entry below
        is a cross-stage handoff captured by the substrate.
      </p>
      <ol className={styles.thread}>
        {data.entries.map((entry, idx) => (
          <DeliberationEntry
            key={entry.atom_id}
            entry={entry}
            isLast={idx === data.entries.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}

function severityIconFor(severity: PipelineDeliberationSeverity) {
  if (severity === 'critical') {
    return <AlertCircle size={12} strokeWidth={2.25} aria-hidden="true" />;
  }
  if (severity === 'major') {
    return <AlertTriangle size={12} strokeWidth={2.25} aria-hidden="true" />;
  }
  return <Info size={12} strokeWidth={2.25} aria-hidden="true" />;
}

function DeliberationEntry({
  entry,
  isLast,
}: {
  entry: PipelineDeliberationEntry;
  isLast: boolean;
}) {
  const reduceMotion = useReducedMotion();
  // Honor prefers-reduced-motion per canon dev-web-interaction-quality.
  const motionProps = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0 } }
    : {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.18 },
    };
  const severityVariant: 'danger' | 'warning' | 'info' =
    entry.finding.severity === 'critical'
      ? 'danger'
      : entry.finding.severity === 'major'
        ? 'warning'
        : 'info';
  return (
    <motion.li
      className={styles.entry}
      data-testid="pipeline-deliberation-entry"
      data-attempt={entry.attempt}
      data-from-stage={entry.from_stage}
      data-to-stage={entry.to_stage}
      data-severity={entry.finding.severity}
      data-thread-head={entry.thread_parent === null ? 'true' : 'false'}
      data-is-last={isLast ? 'true' : 'false'}
      {...motionProps}
    >
      <div className={styles.rail} aria-hidden="true">
        <span className={styles.railDot} data-severity={entry.finding.severity}>
          {severityIconFor(entry.finding.severity)}
        </span>
        {!isLast && <span className={styles.railLine} />}
      </div>
      <div className={styles.entryBody}>
        <header className={styles.entryHead}>
          <span
            className={styles.attemptPill}
            data-testid="pipeline-deliberation-attempt"
            aria-label={`attempt ${entry.attempt}`}
          >
            attempt {entry.attempt}
          </span>
          <span
            className={styles.handoff}
            data-testid="pipeline-deliberation-handoff"
          >
            <code className={styles.stageChip} data-role="from">
              {entry.from_stage}
            </code>
            <ArrowRight size={12} strokeWidth={2.25} aria-hidden="true" />
            <code className={styles.stageChip} data-role="to">
              {entry.to_stage}
            </code>
          </span>
          <span
            className={styles.severityPill}
            data-variant={severityVariant}
            data-testid="pipeline-deliberation-severity"
          >
            {severityIconFor(entry.finding.severity)}
            {entry.finding.severity}
          </span>
          <code
            className={styles.category}
            data-testid="pipeline-deliberation-category"
          >
            {entry.finding.category}
          </code>
          <span className={styles.timestamp}>
            <time dateTime={entry.created_at}>
              {formatRelative(entry.created_at)}
            </time>
          </span>
        </header>
        <p
          className={styles.message}
          data-testid="pipeline-deliberation-message"
        >
          {entry.finding.message}
        </p>
        <div className={styles.metaRow}>
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Citation origin</span>
            <code data-testid="pipeline-deliberation-citation-origin">
              {entry.verified_cited_atom_ids_origin}
            </code>
          </span>
          {entry.thread_parent && (
            <span
              className={styles.metaItem}
              data-testid="pipeline-deliberation-thread-parent"
            >
              <span className={styles.metaLabel}>Parent</span>
              <AtomRef id={entry.thread_parent} variant="chip" />
            </span>
          )}
          <span className={styles.metaItem}>
            <span className={styles.metaLabel}>Atom</span>
            <AtomRef id={entry.atom_id} variant="chip" />
          </span>
        </div>
        {entry.finding.cited_atom_ids.length > 0 && (
          <div
            className={styles.citationBlock}
            data-testid="pipeline-deliberation-cited-atoms"
          >
            <span className={styles.metaLabel}>
              Cited atoms ({entry.finding.cited_atom_ids.length})
            </span>
            <ul className={styles.atomRefList}>
              {entry.finding.cited_atom_ids.map((id) => (
                <li key={id}>
                  <AtomRef id={id} variant="chip" />
                </li>
              ))}
            </ul>
          </div>
        )}
        {entry.finding.cited_paths.length > 0 && (
          <div
            className={styles.citationBlock}
            data-testid="pipeline-deliberation-cited-paths"
          >
            <span className={styles.metaLabel}>
              Cited paths ({entry.finding.cited_paths.length})
            </span>
            <ul className={styles.pathList}>
              {entry.finding.cited_paths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </motion.li>
  );
}
