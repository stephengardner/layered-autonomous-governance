import { MessageSquare } from 'lucide-react';
import { routeHref, setRoute } from '@/state/router.store';
import styles from './ConversationLink.module.css';

/**
 * Discoverable "Conversation" navigation link for the pipeline +
 * deliberation detail views. Routes to the conversation subroute
 * (`/pipelines/<id>/conversation` or `/deliberation/<id>/conversation`).
 *
 * Pill-styled so it sits comfortably next to the FocusBanner without
 * competing for header attention. Click semantics mirror PrincipalLink
 * and AtomRef: middle/ctrl/meta clicks open in a new tab through the
 * browser default; primary left-click routes through the SPA via
 * setRoute so history stays coherent.
 */
export interface ConversationLinkProps {
  readonly scope: 'pipelines' | 'deliberation';
  readonly id: string;
  readonly testId?: string;
}

export function ConversationLink({
  scope,
  id,
  testId = 'conversation-link',
}: ConversationLinkProps) {
  const href = routeHref(scope, id, 'conversation');
  return (
    <a
      className={styles.link}
      href={href}
      data-testid={testId}
      data-scope={scope}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        setRoute(scope, id, 'conversation');
      }}
      title="Open the full conversation thread"
    >
      <MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
      Conversation
    </a>
  );
}
