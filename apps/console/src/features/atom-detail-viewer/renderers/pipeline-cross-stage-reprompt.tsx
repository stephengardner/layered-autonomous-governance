import { AlertTriangle, AlertCircle, ArrowRight, Info } from 'lucide-react';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { asString, asStringArray, asRecord, asNumber } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Pipeline-cross-stage-reprompt renderer.
 *
 * The substrate's planning-pipeline runner emits one
 * `pipeline-cross-stage-reprompt` atom per cross-stage re-prompt event
 * (e.g. dispatch-stage refuses to draft a PR, the runner walks back to
 * plan-stage with the finding). The atom carries:
 *
 *   - metadata.pipeline_id              (root pipeline this re-prompt
 *                                        belongs to)
 *   - metadata.correlation_id           (pipeline correlation id)
 *   - metadata.from_stage               (auditor stage that emitted
 *                                        the finding)
 *   - metadata.to_stage                 (upstream stage the runner
 *                                        will re-invoke)
 *   - metadata.attempt                  (1-based unified walks counter)
 *   - metadata.thread_parent            (atom id of the prior
 *                                        re-prompt in the chain, null
 *                                        for the head of the thread)
 *   - metadata.verified_cited_atom_ids_origin
 *                                       ('pipeline-seed' for the head,
 *                                        'latest-upstream' for
 *                                        subsequent entries)
 *   - metadata.finding                  ({severity, category, message,
 *                                        cited_atom_ids, cited_paths,
 *                                        reprompt_target})
 *
 * The renderer mirrors the shape of `pipeline-audit-finding.tsx` and
 * `pipeline-stage-event.tsx`: a header pill row with the severity
 * badge, then the FROM_STAGE -> TO_STAGE handoff, attempt counter,
 * remediation message, and citation lists.
 */
function severityIcon(severity: string | null) {
  if (severity === 'critical') {
    return <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />;
  }
  if (severity === 'major') {
    return <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />;
  }
  return <Info size={14} strokeWidth={2} aria-hidden="true" />;
}

function severityVariant(severity: string | null): 'danger' | 'warning' | 'info' {
  if (severity === 'critical') return 'danger';
  if (severity === 'major') return 'warning';
  return 'info';
}

export function PipelineCrossStageRepromptRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const pipelineId = asString(meta['pipeline_id']);
  const correlationId = asString(meta['correlation_id']);
  const fromStage = asString(meta['from_stage']);
  const toStage = asString(meta['to_stage']);
  const attempt = asNumber(meta['attempt']);
  const threadParent = asString(meta['thread_parent']);
  const verifiedOrigin = asString(meta['verified_cited_atom_ids_origin']);
  const finding = asRecord(meta['finding']) ?? {};
  const severity = asString(finding['severity']);
  const category = asString(finding['category']);
  const message = asString(finding['message']);
  const repromptTarget = asString(finding['reprompt_target']);
  const citedAtomIds = asStringArray(finding['cited_atom_ids']);
  const citedPaths = asStringArray(finding['cited_paths']);

  return (
    <>
      <Section title="Cross-stage re-prompt" testId="atom-detail-cross-stage-reprompt">
        <div className={styles.metaRow}>
          {severity && (
            <span
              className={styles.statusPill}
              data-variant={severityVariant(severity)}
              data-testid="atom-detail-cross-stage-reprompt-severity"
            >
              {severityIcon(severity)}
              {severity}
            </span>
          )}
          {category && (
            <code data-testid="atom-detail-cross-stage-reprompt-category">
              {category}
            </code>
          )}
          {attempt !== null && (
            <span
              className={styles.statusPill}
              data-variant="info"
              data-testid="atom-detail-cross-stage-reprompt-attempt"
              aria-label={`attempt ${attempt}`}
            >
              attempt {attempt}
            </span>
          )}
        </div>
        <dl className={styles.attrs}>
          {fromStage && toStage && (
            <AttrRow
              label="Handoff"
              value={
                <span
                  className={styles.metaRow}
                  data-testid="atom-detail-cross-stage-reprompt-handoff"
                  data-from-stage={fromStage}
                  data-to-stage={toStage}
                >
                  <code>{fromStage}</code>
                  <ArrowRight size={12} strokeWidth={2.25} aria-hidden="true" />
                  <code>{toStage}</code>
                </span>
              }
            />
          )}
          {repromptTarget && (
            <AttrRow
              label="Re-prompt target"
              value={<code>{repromptTarget}</code>}
              testId="atom-detail-cross-stage-reprompt-target"
            />
          )}
          {verifiedOrigin && (
            <AttrRow
              label="Citation origin"
              value={<code>{verifiedOrigin}</code>}
              testId="atom-detail-cross-stage-reprompt-citation-origin"
            />
          )}
          {correlationId && (
            <AttrRow label="Correlation" value={<code>{correlationId}</code>} />
          )}
          {pipelineId && (
            <AttrRow label="Pipeline" value={<AtomRef id={pipelineId} />} />
          )}
          {threadParent && (
            <AttrRow
              label="Thread parent"
              value={<AtomRef id={threadParent} />}
              testId="atom-detail-cross-stage-reprompt-thread-parent"
            />
          )}
        </dl>
        {message && (
          <div>
            <h4 className={styles.attrLabel}>Finding</h4>
            <p
              className={styles.sectionBody}
              data-testid="atom-detail-cross-stage-reprompt-message"
            >
              {message}
            </p>
          </div>
        )}
      </Section>

      {citedAtomIds.length > 0 && (
        <Section
          title={`Cited atoms (${citedAtomIds.length})`}
          testId="atom-detail-cross-stage-reprompt-cited-atoms"
        >
          <ul className={styles.refList}>
            {citedAtomIds.map((id) => (
              <li key={id} className={styles.refItem}>
                <AtomRef id={id} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {citedPaths.length > 0 && (
        <Section
          title={`Cited paths (${citedPaths.length})`}
          testId="atom-detail-cross-stage-reprompt-cited-paths"
        >
          <ul className={styles.bulletList}>
            {citedPaths.map((p) => (
              <li key={p}><code>{p}</code></li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
