/*
 * Focused four-step plan_state timeline rendered above the existing
 * atom-chain transitions list. Surfaces the dispatcher metadata
 * stamps from PR #270 (approved_at / executing_at / executing_invoker
 * / terminal_at / terminal_kind / error_message) so an operator
 * inspecting a plan sees the plan_state boundaries without grepping
 * raw atom JSON.
 *
 * Why a separate component instead of folding into PlanLifecycleTimeline:
 *   - The existing timeline narrates the full atom chain (intent ->
 *     plan -> approval -> dispatch -> observation -> settled), one
 *     row per atom event. The plan_state lifecycle is a different
 *     question -- "where is THIS plan in the four-state machine?" --
 *     and benefits from a fixed-shape, always-four-rows layout that
 *     reads as a stepper, not a chronological feed.
 *   - Variable-row narration vs fixed-row stepper is a different
 *     visual contract (pending rows are first-class, not omitted),
 *     so the rendering choices diverge cleanly.
 *
 * Token discipline: every color hook resolves to a semantic token in
 * src/tokens/tokens.css. No hex, no hardcoded color, no Tailwind
 * utility classes per the console's CLAUDE.md rules. The stepper is
 * mobile-first: rows stack vertically by default and only widen the
 * spacing at >=40rem.
 */

import { motion } from 'framer-motion';
import { CheckCircle2, Circle, AlertCircle, Loader2, MinusCircle } from 'lucide-react';
import type {
  PlanStateLifecycle,
  PlanStateLifecycleStep,
  PlanStateLifecycleStepKind,
} from '@/services/plan-lifecycle.service';
import styles from './PlanStateLifecycleStepper.module.css';

/*
 * Per-step display copy. The stepper reads as a fixed four-row
 * layout, so the labels are stable strings rather than i18n-keyed --
 * matches the console's existing approach to this kind of internal
 * UI string.
 */
const STEP_LABEL: Readonly<Record<PlanStateLifecycleStepKind, string>> = Object.freeze({
  proposed: 'Proposed',
  approved: 'Approved',
  executing: 'Executing',
  terminal: 'Terminal',
});

const STEP_DESCRIPTION: Readonly<Record<PlanStateLifecycleStepKind, string>> = Object.freeze({
  proposed: 'Plan atom written by the planner',
  approved: 'Approval gate cleared',
  executing: 'Dispatched to a sub-actor',
  terminal: 'Plan reached its final state',
});

/*
 * Status-driven tone resolution. Reached steps lean on the
 * status-success / status-danger / status-info family the rest of the
 * console uses for plan_state pills (per features/plan-state/tones.ts);
 * pending and skipped steps fall back to muted text/border tokens so
 * they read as visually "unreached" without going invisible.
 */
function toneFor(step: PlanStateLifecycleStep): string {
  if (step.status === 'pending') return 'var(--text-tertiary)';
  if (step.status === 'skipped') return 'var(--text-muted)';
  // reached
  if (step.kind === 'terminal') {
    if (step.terminal_kind === 'succeeded') return 'var(--status-success)';
    if (step.terminal_kind === 'failed') return 'var(--status-danger)';
    return 'var(--text-secondary)';
  }
  if (step.kind === 'executing') return 'var(--status-info)';
  if (step.kind === 'approved') return 'var(--accent-active)';
  // proposed reached
  return 'var(--accent)';
}

/*
 * Icon resolution mirrors the tone logic. CheckCircle2 for any
 * reached non-terminal step + succeeded terminal; AlertCircle for a
 * failed terminal; Loader2 for in-flight pending; MinusCircle for
 * skipped; Circle (outlined) for the rest.
 */
function iconFor(step: PlanStateLifecycleStep): typeof Circle {
  if (step.status === 'skipped') return MinusCircle;
  if (step.status === 'pending') return Circle;
  // reached
  if (step.kind === 'terminal' && step.terminal_kind === 'failed') return AlertCircle;
  if (step.kind === 'executing') return Loader2;
  return CheckCircle2;
}

export function PlanStateLifecycleStepper({
  data,
  testIdPrefix = 'plan-state-lifecycle',
}: {
  readonly data: PlanStateLifecycle;
  readonly testIdPrefix?: string;
}) {
  return (
    <section
      className={styles.stepper}
      data-testid={testIdPrefix}
      aria-label="Plan state lifecycle"
    >
      <header className={styles.header}>
        <h3 className={styles.title}>Plan state lifecycle</h3>
        <p className={styles.subtitle}>
          The plan_state machine projected from dispatcher metadata stamps.
        </p>
      </header>
      <ol className={styles.list}>
        {data.steps.map((step, idx) => (
          <StepRow
            key={step.kind}
            step={step}
            index={idx}
            isLast={idx === data.steps.length - 1}
            testIdPrefix={testIdPrefix}
          />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  index,
  isLast,
  testIdPrefix,
}: {
  readonly step: PlanStateLifecycleStep;
  readonly index: number;
  readonly isLast: boolean;
  readonly testIdPrefix: string;
}) {
  const tone = toneFor(step);
  const Icon = iconFor(step);
  const validIso = step.at !== null && !Number.isNaN(Date.parse(step.at));
  const label = STEP_LABEL[step.kind];
  const description = STEP_DESCRIPTION[step.kind];
  const statusPillCopy = pillCopyFor(step);

  return (
    <motion.li
      className={styles.row}
      data-step-kind={step.kind}
      data-step-status={step.status}
      data-testid={`${testIdPrefix}-step`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.22,
        delay: Math.min(index * 0.06, 0.24),
        ease: [0.2, 0, 0, 1],
      }}
    >
      <span
        className={styles.icon}
        style={{
          color: tone,
          borderColor: tone,
          // Reached non-pending steps fill the icon background to
          // emphasize "we got here"; pending and skipped use the
          // outlined posture (transparent background) so the dial
          // visually advances as the plan moves through states.
          background: step.status === 'reached'
            ? 'color-mix(in srgb, var(--surface-base) 100%, transparent)'
            : 'transparent',
        }}
        aria-hidden="true"
      >
        <Icon
          size={16}
          strokeWidth={2}
          // The Loader2 icon is the closest visual cue framer-motion
          // gives us for "in-flight"; we don't spin it because
          // dev-app-grade-interactions calls out "no jank, no flash"
          // and an idle-CPU spinner on a static page is jank.
        />
      </span>
      {!isLast && (
        <span
          className={styles.rail}
          style={{
            // Filled rail for reached + skipped (the plan has moved
            // past this step in either case); muted rail for pending
            // (the plan hasn't crossed it yet). Skipped uses the
            // muted tone too -- the rail's job is "did the plan
            // advance past here?", not "what shape did the advance
            // take?".
            background: step.status === 'reached'
              ? tone
              : 'var(--border-subtle)',
            opacity: step.status === 'reached' ? 0.5 : 1,
          }}
          aria-hidden="true"
        />
      )}
      <div className={styles.body}>
        <div className={styles.heading}>
          <span className={styles.label} style={{ color: tone }}>{label}</span>
          <span
            className={styles.statusPill}
            data-step-status={step.status}
            style={{
              borderColor: tone,
              color: tone,
            }}
          >
            {statusPillCopy}
          </span>
          {validIso && step.at !== null && (
            <time className={styles.time} dateTime={step.at}>
              {new Date(step.at).toLocaleString()}
            </time>
          )}
        </div>
        <p className={styles.description}>{description}</p>
        {step.by !== null && step.by.length > 0 && (
          <div className={styles.metaRow}>
            <span className={styles.principalLabel}>by</span>
            <code
              className={styles.principalPill}
              data-testid={`${testIdPrefix}-step-by`}
            >
              {step.by}
            </code>
          </div>
        )}
        {step.error_message !== null && (
          <pre
            className={styles.errorMessage}
            data-testid={`${testIdPrefix}-step-error`}
          >
            {step.error_message}
          </pre>
        )}
      </div>
    </motion.li>
  );
}

/*
 * Status-pill copy: short string operators read at-a-glance. Reached
 * terminal rows surface the terminal_kind so the operator does not
 * need to read the icon shape. Skipped rows include the reason in a
 * lowercase form that mirrors the substrate vocabulary
 * ('rejected'/'abandoned' from plan_state). Pending rows stay
 * generic.
 */
function pillCopyFor(step: PlanStateLifecycleStep): string {
  if (step.status === 'pending') return 'pending';
  if (step.status === 'skipped') return 'skipped';
  // reached
  if (step.kind === 'terminal' && step.terminal_kind !== null) {
    return step.terminal_kind;
  }
  return 'reached';
}
