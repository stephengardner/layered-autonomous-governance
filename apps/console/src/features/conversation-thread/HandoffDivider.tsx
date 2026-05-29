import { ArrowRight } from 'lucide-react';
import styles from './ConversationThreadView.module.css';

/**
 * Full-width FROM -> TO divider, drawn between stage transitions in the
 * conversation thread. Two consumers:
 *   1. cross-stage-reprompt events (FROM = upstream stage that emitted
 *      the finding, TO = the stage being re-prompted).
 *   2. stage-started events (FROM = previous stage if known, TO = the
 *      newly-entered stage).
 *
 * The divider is purely visual; the parent thread already orders events
 * chronologically. It anchors the operator's eye to the segment
 * transition so re-prompts are visually unmissable.
 */
export interface HandoffDividerProps {
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly testId?: string;
}

export function HandoffDivider({ fromStage, toStage, testId }: HandoffDividerProps) {
  return (
    <div
      className={styles.handoffDivider}
      data-testid={testId ?? 'conversation-handoff-divider'}
      data-from-stage={fromStage ?? ''}
      data-to-stage={toStage}
    >
      <span className={styles.handoffLine} aria-hidden="true" />
      {fromStage && (
        <>
          <code
            className={styles.handoffStage}
            data-role="from"
            data-testid={testId ? `${testId}-from` : 'conversation-handoff-from'}
          >
            {fromStage}
          </code>
          <ArrowRight size={12} strokeWidth={2.25} aria-hidden="true" />
        </>
      )}
      <code
        className={styles.handoffStage}
        data-role="to"
        data-testid={testId ? `${testId}-to` : 'conversation-handoff-to'}
      >
        {toStage}
      </code>
      <span className={styles.handoffLine} aria-hidden="true" />
    </div>
  );
}
