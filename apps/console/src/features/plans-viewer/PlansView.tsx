import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AtomRef } from '@/components/atom-ref/AtomRef';
import { listPlans, type PlanAtom } from '@/services/plans.service';
import { useRouteQuery, setRoute } from '@/state/router.store';
import styles from './PlansView.module.css';

/*
 * Atom IDs have at least 4 hyphen-separated segments. That's stricter
 * than "has hyphens" — filters out short identifiers like bot names
 * (`lag-ceo`, `lag-pr-landing`) that would otherwise get false-linked.
 * Real atoms: `arch-host-interface-boundary`, `inv-provenance-every-write`,
 * `dev-coderabbit-required-status-check-non-negotiable`.
 */
const ATOM_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){3,}$/;

/*
 * Custom markdown renderer: inline `code` that matches an atom-ID
 * pattern gets promoted to a clickable AtomRef. Block code is left
 * alone. This is the glue that makes references inside plan bodies
 * navigable just like the structured refs in a CanonCard.
 */
const MARKDOWN_COMPONENTS = {
  code({ children, ...props }: { children?: ReactNode; className?: string | undefined }) {
    const text = String(children ?? '');
    // Block vs inline: block renderer passes className like `language-*`
    // OR contains a newline. We also conservatively only promote short
    // strings so long code blocks stay intact.
    const isBlock = Boolean(props.className) || text.includes('\n');
    if (!isBlock && text.length <= 120 && ATOM_ID_RE.test(text)) {
      return <AtomRef id={text} variant="inline" />;
    }
    return <code {...props}>{children}</code>;
  },
};

const STATE_TONE: Record<string, string> = {
  approved: 'var(--status-success)',
  pending: 'var(--status-warning)',
  rejected: 'var(--status-danger)',
  proposed: 'var(--accent)',
  draft: 'var(--text-tertiary)',
};

export function PlansView() {
  const query = useQuery({
    queryKey: ['plans'],
    queryFn: ({ signal }) => listPlans(signal),
  });
  const routeQuery = useRouteQuery();
  const focusId = routeQuery.get('focus');

  const allPlans = query.data ?? [];
  const plans = useMemo(() => {
    if (!focusId) return allPlans;
    return allPlans.filter((p) => p.id === focusId);
  }, [allPlans, focusId]);

  return (
    <section className={styles.view}>
      {query.isPending && (
        <div className={styles.state} data-testid="plans-loading">
          <div className={styles.spinner} aria-hidden="true" />
          <p>Loading plans…</p>
        </div>
      )}
      {query.isError && (
        <div className={styles.state} data-testid="plans-error">
          <p className={styles.errorTitle}>Could not load plans</p>
          <code className={styles.errorDetail}>{(query.error as Error).message}</code>
        </div>
      )}
      {query.isSuccess && plans.length === 0 && (
        <div className={styles.state} data-testid="plans-empty">
          {focusId ? (
            <>
              <p className={styles.errorTitle}>Plan not found</p>
              <p className={styles.hint}>
                <code>{focusId}</code> is not in the current plan set.
              </p>
              <button
                type="button"
                className={styles.focusClear}
                onClick={() => setRoute('plans')}
              >
                <X size={12} strokeWidth={2.5} /> Clear focus
              </button>
            </>
          ) : (
            <>
              <p>No plan atoms found.</p>
              <p className={styles.hint}>
                Plans appear here when an atom has type=plan or a top-level
                plan_state field. Currently the repo has neither.
              </p>
            </>
          )}
        </div>
      )}
      {query.isSuccess && plans.length > 0 && (
        <>
          {focusId && (
            <div className={styles.focusBanner}>
              <span className={styles.focusLabel}>Focused on plan</span>
              <code className={styles.focusId}>{focusId}</code>
              <button
                type="button"
                className={styles.focusClear}
                onClick={() => setRoute('plans')}
                aria-label="Clear focus"
              >
                <X size={12} strokeWidth={2.5} /> clear
              </button>
            </div>
          )}
          <div className={styles.stats}>
            <span className={styles.statsTotal}>{plans.length}</span>
            <span className={styles.statsLabel}>
              plan{plans.length === 1 ? '' : 's'}
            </span>
            {focusId && (
              <span className={styles.statsDetail}>(filtered to focus)</span>
            )}
          </div>
          <div className={styles.grid}>
            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} startExpanded={Boolean(focusId)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function PlanCard({ plan, startExpanded }: { plan: PlanAtom; startExpanded: boolean }) {
  const [expanded, setExpanded] = useState(startExpanded);

  // Keep local state in sync when the route focus changes after mount
  // (user clicks another plan's atom-ref while already on /plans).
  useEffect(() => {
    if (startExpanded) setExpanded(true);
  }, [startExpanded]);

  const state = plan.plan_state ?? 'unknown';
  const { title, body } = splitTitleAndBody(plan.content);
  return (
    <article className={styles.card} data-testid="plan-card" data-atom-id={plan.id}>
      <header className={styles.header}>
        <span
          className={styles.statePill}
          style={{ borderColor: STATE_TONE[state] ?? 'var(--border-subtle)', color: STATE_TONE[state] ?? 'var(--text-secondary)' }}
        >
          {state}
        </span>
        <code className={styles.id}>{plan.id}</code>
      </header>

      {title && <h3 className={styles.title}>{title}</h3>}

      <div className={`${styles.content} ${expanded ? styles.contentExpanded : styles.contentClamped}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{body}</ReactMarkdown>
      </div>

      <button
        type="button"
        className={`${styles.expand} ${expanded ? styles.expandOpen : ''}`}
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        data-testid={`plan-expand-${plan.id}`}
      >
        <ChevronDown size={14} strokeWidth={2} />
        {expanded ? 'Collapse' : 'Read more'}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.footer
            className={styles.footer}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <span>by {plan.principal_id}</span>
            <span>•</span>
            <span>layer {plan.layer}</span>
            <span>•</span>
            <span>{new Date(plan.created_at).toLocaleString()}</span>
          </motion.footer>
        )}
      </AnimatePresence>
    </article>
  );
}

function splitTitleAndBody(md: string): { title: string | null; body: string } {
  const lines = md.split('\n');
  // Find first non-blank line; if it's a H1/H2/H3, strip it.
  let firstNonBlank = 0;
  while (firstNonBlank < lines.length && lines[firstNonBlank]!.trim().length === 0) {
    firstNonBlank++;
  }
  const candidate = lines[firstNonBlank] ?? '';
  const match = candidate.match(/^#{1,3}\s+(.+)$/);
  if (match && match[1]) {
    const body = lines.slice(firstNonBlank + 1).join('\n').trimStart();
    return { title: match[1].trim(), body };
  }
  return { title: null, body: md };
}
