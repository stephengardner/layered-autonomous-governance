import { Fragment, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { FocusBanner } from '@/components/focus-banner/FocusBanner';
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from '@/components/state-display/StateDisplay';
import {
  deriveTrueOutcome,
  trueOutcomeTone,
} from '@/features/plan-state/trueOutcome';
import { setRoute } from '@/state/router.store';
import { toErrorMessage } from '@/services/errors';
import {
  getConversation,
  type ConversationEvent as ConversationEventType,
  type ConversationResult,
  type ConversationScope,
} from '@/services/conversation.service';
import { ConversationEvent } from './ConversationEvent';
import { HandoffDivider } from './HandoffDivider';
import styles from './ConversationThreadView.module.css';

/**
 * Conversation Thread surface.
 *
 * Two scopes: pipeline (queryKey = pipeline_id) and deliberation
 * (queryKey = plan_id). The view picks the scope from the prop union
 * and dispatches the right backend call via the service.
 *
 * Rendered when the operator navigates to either
 *   /pipelines/<id>/conversation
 *   /deliberation/<id>/conversation
 *
 * Layout:
 *   1. FocusBanner with the resolved entity label + id.
 *   2. Header row: TRUE-outcome state-tone-only chip (when derivable),
 *      pipeline_id + intent_id + event count + back link.
 *   3. Section card: chronological list of events. Stage-started
 *      events emit a HandoffDivider between rows so the operator sees
 *      the segment transition at the top of every stage.
 *
 * Empty state: graceful "No conversation captured yet" empty card.
 * Loading state: shared LoadingState; the SectionHead is omitted so
 *   the operator does not see a fake empty list shape during the first
 *   paint.
 * Error state: ErrorState with the substrate error message.
 *
 * Polling: 10s while live, no-poll once the result settles. The
 * conversation thread is append-only on the substrate side; new
 * events land as the pipeline runs.
 */

interface PipelineScopeProps {
  readonly pipeline_id: string;
}

interface DeliberationScopeProps {
  readonly plan_id: string;
}

export type ConversationThreadViewProps =
  | PipelineScopeProps
  | DeliberationScopeProps;

export function ConversationThreadView(props: ConversationThreadViewProps) {
  const scope: ConversationScope = 'pipeline_id' in props
    ? { pipeline_id: props.pipeline_id }
    : { plan_id: props.plan_id };

  const query = useQuery<ConversationResult>({
    queryKey: 'pipeline_id' in scope
      ? ['conversation', 'pipeline', scope.pipeline_id]
      : ['conversation', 'plan', scope.plan_id],
    queryFn: ({ signal }) => getConversation(scope, signal),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => {
      // 404 pipeline-not-found is informative: the substrate may not
      // have minted the pipeline yet, or the operator landed on a
      // deliberation whose plan has no linked pipeline. Do not retry;
      // render the empty state instead.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('pipeline-not-found')) return false;
      return failureCount < 2;
    },
  });

  const focusId = 'pipeline_id' in props ? props.pipeline_id : props.plan_id;
  const focusLabel = 'pipeline_id' in props ? 'Pipeline conversation' : 'Plan conversation';
  const backRoute = 'pipeline_id' in props ? 'pipelines' : 'deliberation';

  return (
    <section
      className={styles.view}
      data-testid="conversation-thread-view"
      data-scope={'pipeline_id' in props ? 'pipeline' : 'plan'}
    >
      <FocusBanner
        label={focusLabel}
        id={focusId}
        onClear={() => setRoute(backRoute, focusId)}
      />

      {query.isPending && (
        <LoadingState
          label="Loading conversation..."
          testId="conversation-thread-loading"
        />
      )}

      {query.isError && (() => {
        // pipeline-not-found is informative, not a failure: the
        // substrate may not have minted the pipeline yet, or the
        // operator landed on a deliberation whose plan has no linked
        // pipeline. Surface the empty-state so the page reads as
        // "no conversation captured yet" instead of a hard error.
        const msg = query.error instanceof Error
          ? query.error.message
          : String(query.error);
        if (msg.includes('pipeline-not-found')) {
          return (
            <EmptyState
              title="No conversation captured yet"
              detail={
                <>
                  The substrate has not minted a conversation for{' '}
                  <code>{focusId}</code> yet. Events appear here as the
                  pipeline runs.
                </>
              }
              action={
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setRoute(backRoute, focusId)}
                >
                  Back to detail
                </button>
              }
              testId="conversation-thread-empty"
            />
          );
        }
        return (
          <ErrorState
            title="Could not load conversation"
            message={toErrorMessage(query.error)}
            testId="conversation-thread-error"
          />
        );
      })()}

      {query.data && (
        <ConversationBody
          data={query.data}
          backRoute={backRoute}
          focusId={focusId}
        />
      )}
    </section>
  );
}

interface ConversationBodyProps {
  readonly data: ConversationResult;
  readonly backRoute: 'pipelines' | 'deliberation';
  readonly focusId: string;
}

function ConversationBody({ data, backRoute, focusId }: ConversationBodyProps) {
  const events = data.events;

  // Pipeline-state hint comes from the events themselves: a
  // 'dispatch-result' carries the substrate outcome we can map to the
  // TRUE-outcome bucket without a second backend call. For the
  // deliberation scope, the plan state is not on the wire; the pill
  // falls back to the generic in-progress tone unless a dispatch-result
  // is present.
  const dispatch = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev && ev.kind === 'dispatch-result') return ev;
    }
    return null;
  }, [events]);
  const trueOutcome = deriveTrueOutcome({
    pipeline_state: dispatch
      ? dispatch.result === 'failed' ? 'failed' : 'completed'
      : null,
    dispatch_summary: dispatch
      ? { dispatched: dispatch.result === 'pr-opened' ? 1 : 0, failed: dispatch.result === 'failed' ? 1 : 0 }
      : null,
  });
  const stateTone = trueOutcomeTone(trueOutcome);
  const pillLabel = dispatch
    ? trueOutcome
    : 'in-progress';

  if (events.length === 0) {
    return (
      <>
        <ConversationHead
          data={data}
          trueOutcomeLabel={pillLabel}
          stateTone={stateTone}
        />
        <EmptyState
          title="No conversation captured yet"
          detail={
            <>
              The substrate has not minted any conversation events for{' '}
              <code>{focusId}</code> yet. Events appear here as the pipeline
              runs.
            </>
          }
          action={
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setRoute(backRoute, focusId)}
            >
              Back to detail
            </button>
          }
          testId="conversation-thread-empty"
        />
      </>
    );
  }

  return (
    <>
      <ConversationHead
        data={data}
        trueOutcomeLabel={pillLabel}
        stateTone={stateTone}
      />
      <section
        className={styles.section}
        data-testid="conversation-thread"
        data-event-count={events.length}
      >
        <header className={styles.sectionHead}>
          <span className={styles.sectionIcon} aria-hidden="true">
            <MessageSquare size={14} strokeWidth={2} />
          </span>
          <h3 className={styles.sectionTitle}>Conversation</h3>
          <span
            className={styles.sectionCount}
            data-testid="conversation-thread-count"
          >
            {events.length}
          </span>
        </header>
        <ol className={styles.thread}>
          {renderThread(events)}
        </ol>
      </section>
    </>
  );
}

/**
 * Walk the events and insert a HandoffDivider between adjacent rows
 * when the stage changes. The divider draws a FROM -> TO arrow so the
 * operator sees the segment transition at the start of each stage.
 *
 * Stage transitions captured:
 *   1. Any 'stage-started' event AFTER a prior event with a known
 *      stage emits a divider FROM previous stage TO the new stage.
 *   2. A 'cross-stage-reprompt' event always emits a divider FROM the
 *      event's `from_stage` TO `to_stage` (substrate-canonical).
 *
 * The first event never draws a divider; the FROM side would be
 * vacuous (no prior stage).
 */
function renderThread(events: ReadonlyArray<ConversationEventType>) {
  let lastStage: string | null = null;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const isLast = i === events.length - 1;

    // Decide divider BEFORE the row.
    let divider: React.ReactNode = null;
    if (i > 0) {
      if (ev.kind === 'stage-started' && ev.stage !== lastStage) {
        divider = (
          <HandoffDivider
            key={`handoff-${i}`}
            fromStage={lastStage}
            toStage={ev.stage}
            testId={`conversation-handoff-${i}`}
          />
        );
      } else if (ev.kind === 'cross-stage-reprompt') {
        divider = (
          <HandoffDivider
            key={`handoff-${i}`}
            fromStage={ev.from_stage}
            toStage={ev.to_stage}
            testId={`conversation-handoff-${i}`}
          />
        );
      }
    }

    out.push(
      <Fragment key={ev.atom_id}>
        {divider}
        <ConversationEvent event={ev} isLast={isLast} index={i} />
      </Fragment>,
    );

    if (ev.stage) lastStage = ev.stage;
  }
  return out;
}

interface ConversationHeadProps {
  readonly data: ConversationResult;
  readonly trueOutcomeLabel: string;
  readonly stateTone: string;
}

function ConversationHead({
  data,
  trueOutcomeLabel,
  stateTone,
}: ConversationHeadProps) {
  const intentId = data.intent_id;
  const pipelineId = 'pipeline_id' in data ? data.pipeline_id : null;
  const planId = 'plan_id' in data ? data.plan_id : null;
  return (
    <header
      className={styles.detailHead}
      data-testid="conversation-thread-head"
    >
      <div className={styles.detailHeadTop}>
        <span
          className={styles.statePill}
          style={{ borderColor: stateTone, color: stateTone }}
          data-testid="conversation-thread-state"
          data-true-outcome={trueOutcomeLabel}
        >
          {trueOutcomeLabel}
        </span>
        {pipelineId && (
          <span className={styles.idChip} data-testid="conversation-thread-pipeline-id">
            pipeline: {pipelineId}
          </span>
        )}
        {planId && (
          <span className={styles.idChip} data-testid="conversation-thread-plan-id">
            plan: {planId}
          </span>
        )}
      </div>
      <div className={styles.detailMeta}>
        {intentId && (
          <span data-testid="conversation-thread-intent">
            seed intent <AtomRef id={intentId} variant="chip" />
          </span>
        )}
        <span data-testid="conversation-thread-event-count">
          {data.events.length} event{data.events.length === 1 ? '' : 's'}
        </span>
      </div>
    </header>
  );
}
