import { routeHref, setRoute } from '@/state/router.store';
import styles from './AtomRef.module.css';

interface Props {
  readonly id: string;
  readonly variant?: 'inline' | 'chip';
}

/**
 * Clickable reference to another atom by id. Renders as an anchor so
 * middle-click / Cmd+click work the same as any other link (open in
 * new tab with the full canon-view URL). Left-click is intercepted
 * and routed via pushState so we don't reload the app.
 *
 * Navigates to `/canon?focus=<id>` — CanonViewer reads the `focus`
 * query param on mount and filters the list down to that atom, so
 * the link acts as both navigation and permalink.
 */
export function AtomRef({ id, variant = 'chip' }: Props) {
  return (
    <a
      className={variant === 'chip' ? styles.chip : styles.inline}
      href={routeHref('canon', { focus: id })}
      data-testid="atom-ref"
      data-atom-ref-id={id}
      onClick={(e) => {
        if (e.defaultPrevented) return;
        if (e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        setRoute('canon', { focus: id });
      }}
      title={`Open ${id}`}
    >
      {id}
    </a>
  );
}
