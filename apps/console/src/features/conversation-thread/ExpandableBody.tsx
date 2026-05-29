import { useId, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import styles from './ConversationThreadView.module.css';

/**
 * Body content that defaults to expanded when short, collapses long
 * bodies behind a "Show more" toggle.
 *
 * Threshold: bodies with more than `collapseAfterLines` newline-
 * terminated rows OR longer than `collapseAfterChars` characters start
 * collapsed; everything else renders open with no toggle. The component
 * is purely visual; the substrate already capped inline content at the
 * MAX_INLINE_CONTENT_CHARS envelope in PR1, so the truncation flag
 * (`truncated`) shows a permanent "+ N more chars in atom" affordance
 * regardless of expand state.
 *
 * No useEffect: collapsed state is local via useState; the consumer
 * passes `content` as a prop and the component owns the toggle.
 *
 * Accessibility: the toggle is a real <button> with focus-visible
 * outline via the shared token; min-height meets the 44px tap floor.
 */
const DEFAULT_COLLAPSE_LINES = 30;
const DEFAULT_COLLAPSE_CHARS = 1500;

export interface ExpandableBodyProps {
  readonly content: string;
  readonly truncated: boolean;
  /**
   * Optional test-id prefix so the renderer can scope queries to a
   * specific event variant (e.g. `agent-prompt-body`,
   * `agent-response-body`).
   */
  readonly testId?: string;
  readonly collapseAfterLines?: number;
  readonly collapseAfterChars?: number;
}

export function ExpandableBody({
  content,
  truncated,
  testId,
  collapseAfterLines = DEFAULT_COLLAPSE_LINES,
  collapseAfterChars = DEFAULT_COLLAPSE_CHARS,
}: ExpandableBodyProps) {
  // Default-collapsed criterion: line count exceeds threshold OR raw
  // char count does. The line-count branch matches the agent-prompt /
  // agent-response shapes (often dozens of newline-separated steps);
  // the char branch catches dense one-paragraph content that has few
  // newlines but is still too long to inline.
  const linesOverflow = content.split('\n').length > collapseAfterLines;
  const charsOverflow = content.length > collapseAfterChars;
  const needsCollapse = linesOverflow || charsOverflow;

  // Track open + the content identity together so the default state
  // re-derives whenever the body grows or shrinks across re-renders
  // (the conversation surface polls every 10s; a short body that
  // later grows past the threshold must re-collapse to the canonical
  // default, not stay expanded). The state-during-render guard is the
  // React-recommended idiom for "state derived from props" without
  // an extra useEffect, per react.dev/learn/you-might-not-need-an-effect
  // section "Adjusting some state when a prop changes".
  const [openContent, setOpenContent] = useState({
    content,
    open: !needsCollapse,
  });
  if (openContent.content !== content) {
    setOpenContent({ content, open: !needsCollapse });
  }
  const open = openContent.content === content ? openContent.open : !needsCollapse;
  const setOpen = (nextOpenOrUpdater: boolean | ((prev: boolean) => boolean)) => {
    setOpenContent((prev) => ({
      content: prev.content,
      open: typeof nextOpenOrUpdater === 'function'
        ? nextOpenOrUpdater(prev.open)
        : nextOpenOrUpdater,
    }));
  };

  const collapsed = needsCollapse && !open;
  // Stable id for the body region so the toggle's aria-controls
  // wires to the right node when assistive tech walks the
  // relationship. useId keeps it unique across multiple
  // ExpandableBody instances on the same page.
  const bodyId = useId();

  return (
    <div className={styles.bodyBlock} data-testid={testId}>
      <pre
        id={bodyId}
        className={styles.bodyContent}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-testid={testId ? `${testId}-content` : undefined}
      >
        {content}
      </pre>
      {needsCollapse && (
        <button
          type="button"
          className={styles.expandButton}
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          {open ? (
            <>
              <ChevronUp size={12} strokeWidth={2.25} aria-hidden="true" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown size={12} strokeWidth={2.25} aria-hidden="true" />
              Show more
            </>
          )}
        </button>
      )}
      {truncated && (
        <span
          className={styles.truncatedTag}
          data-testid={testId ? `${testId}-truncated` : undefined}
        >
          + more in atom
        </span>
      )}
    </div>
  );
}
