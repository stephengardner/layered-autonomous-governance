import { AtomRef } from '@/components/atom-ref/AtomRef';
import { Section, AttrRow } from '../Section';
import { Deliberation } from '../Deliberation';
import { asString, asRecord } from './helpers';
import styles from '../AtomDetailView.module.css';
import type { AtomRendererProps } from './types';

/**
 * Plan renderer. Plans carry a content-as-markdown body plus a
 * metadata bag with title / principles_applied / alternatives_rejected /
 * what_breaks_if_revisit / delegation / dispatch_result. The plan_state
 * top-level field surfaces in the page header pill.
 *
 * The PlanLifecycleView (separate route) renders the plan_state
 * stepper for the deep-planning chain; we deliberately do NOT embed
 * that here because the atom-detail page is per-atom, not per-chain.
 * A "View lifecycle" link is the right seam if/when the operator wants
 * the chain view from this page; today the AtomRef hover-card already
 * carries a "Open in Plans" hint via routeForAtomId.
 *
 * Deliberation surfacing (alternatives_rejected, principles_applied,
 * what_breaks_if_revisit, derived_from) is delegated to the shared
 * `<Deliberation>` component so the plan view, the canon-card view,
 * and any future detail view that hosts a deliberation block all read
 * the same. Per canon `dev-extract-at-n-equals-two`, that surface was
 * extracted from the original inline rendering in this file plus the
 * (similar) inline rendering in CanonCard at the second-instance bar.
 */
export function PlanRenderer({ atom }: AtomRendererProps) {
  const meta = asRecord(atom.metadata) ?? {};
  const title = asString(meta['title']);
  const delegation = asRecord(meta['delegation']);
  const dispatch = asRecord(meta['dispatch_result']);
  const subActor = delegation ? asString(delegation['sub_actor_principal_id']) : null;
  const blastRadius = delegation ? asString(delegation['implied_blast_radius']) : null;
  const correlationId = delegation ? asString(delegation['correlation_id']) : null;
  const escalateTo = delegation ? asString(delegation['escalate_to']) : null;
  const dispatchKind = dispatch ? asString(dispatch['kind']) : null;
  const dispatchMessage = dispatch ? asString(dispatch['message']) : null;
  const dispatchAt = dispatch ? asString(dispatch['at']) : null;
  const approvedVia = asString(meta['approved_via']);
  const approvedAt = asString(meta['approved_at']);
  const approvedIntentId = asString(meta['approved_intent_id']);

  return (
    <>
      <Section title="Plan body" testId="atom-detail-plan-body">
        {title && <p className={styles.title} data-testid="atom-detail-plan-title">{title}</p>}
        <pre className={styles.proseBody}>{atom.content || '(no body)'}</pre>
      </Section>

      {/*
        Deliberation comes ABOVE delegation/dispatch because the
        operator's first question on a plan detail view is "why did
        the planner pick this path?" -- principles, alternatives,
        regret check, and ancestors all answer that. The delegation
        + dispatch records below answer "what is the planner doing
        about it next?" which is a follow-up read.
      */}
      <Deliberation atom={atom} />

      {(approvedVia || approvedAt || approvedIntentId) && (
        <Section title="Approval" testId="atom-detail-plan-approval">
          <dl className={styles.attrs}>
            {approvedVia && <AttrRow label="Approved via" value={approvedVia} />}
            {approvedAt && <AttrRow label="Approved at" value={approvedAt} />}
            {approvedIntentId && (
              <AttrRow
                label="Intent"
                value={<AtomRef id={approvedIntentId} />}
              />
            )}
          </dl>
        </Section>
      )}

      {delegation && (
        <Section title="Delegation" testId="atom-detail-plan-delegation">
          <dl className={styles.attrs}>
            {subActor && (
              <AttrRow label="Sub-actor" value={<code>{subActor}</code>} />
            )}
            {blastRadius && <AttrRow label="Blast radius" value={blastRadius} />}
            {correlationId && (
              <AttrRow label="Correlation" value={correlationId} mono />
            )}
            {escalateTo && (
              <AttrRow label="Escalate to" value={<code>{escalateTo}</code>} />
            )}
            {asString(delegation['reason']) && (
              <AttrRow label="Reason" value={asString(delegation['reason'])} />
            )}
          </dl>
        </Section>
      )}

      {dispatchKind && (
        <Section title="Dispatch result" testId="atom-detail-plan-dispatch">
          <dl className={styles.attrs}>
            <AttrRow label="Kind" value={dispatchKind} />
            {dispatchAt && <AttrRow label="At" value={dispatchAt} />}
          </dl>
          {dispatchMessage && (
            <pre className={styles.codeBlock}>{dispatchMessage}</pre>
          )}
        </Section>
      )}
    </>
  );
}
