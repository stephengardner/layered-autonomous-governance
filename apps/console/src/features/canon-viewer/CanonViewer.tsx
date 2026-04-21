import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Search, X } from 'lucide-react';
import { listCanonAtoms, type AtomType, type CanonAtom } from '@/services/canon.service';
import { useRouteQuery, setRoute } from '@/state/router.store';
import { CanonCard } from './CanonCard';
import { TypeFilter, type TypeOption } from './TypeFilter';
import styles from './CanonViewer.module.css';

const TYPE_OPTIONS: ReadonlyArray<TypeOption> = [
  { id: 'all', label: 'All', types: [] },
  { id: 'directive', label: 'Directives', types: ['directive'] },
  { id: 'decision', label: 'Decisions', types: ['decision'] },
  { id: 'preference', label: 'Preferences', types: ['preference'] },
  { id: 'reference', label: 'References', types: ['reference'] },
];

export function CanonViewer() {
  const [activeFilterId, setActiveFilterId] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const query = useRouteQuery();
  const focusId = query.get('focus');

  // React to `?focus=<id>` in the URL: pre-fill search with that id
  // and reset the type filter so the focused atom is always visible.
  // When user clears search we DON'T strip the URL param — it serves
  // as a permalink; the search field is the ephemeral UI surface.
  useEffect(() => {
    if (focusId) {
      setSearch(focusId);
      setActiveFilterId('all');
    }
  }, [focusId]);

  const activeFilter = TYPE_OPTIONS.find((o) => o.id === activeFilterId) ?? TYPE_OPTIONS[0]!;

  const dataQuery = useQuery({
    queryKey: ['canon', activeFilter.types, search],
    queryFn: async ({ signal }) => {
      const trimmed = search.trim();
      // Build the params object all-at-once because ListCanonParams
      // uses readonly fields (exactOptionalPropertyTypes forbids
      // post-construction assignment of undefined-valued optionals).
      const params: Parameters<typeof listCanonAtoms>[0] = {
        ...(activeFilter.types.length > 0 ? { types: activeFilter.types } : {}),
        ...(trimmed.length > 0 ? { search: trimmed } : {}),
      };
      return listCanonAtoms(params, signal);
    },
  });

  const atoms = dataQuery.data ?? [];
  const counts = useMemo(() => countByType(atoms), [atoms]);

  return (
    <section className={styles.viewer} aria-busy={dataQuery.isFetching}>
      {focusId && (
        <div className={styles.focusBanner} data-testid="canon-focus-banner">
          <span className={styles.focusLabel}>Focused on atom</span>
          <code className={styles.focusId}>{focusId}</code>
          <button
            type="button"
            className={styles.focusClear}
            onClick={() => {
              setSearch('');
              setRoute('canon');
            }}
            aria-label="Clear focus"
            data-testid="canon-focus-clear"
          >
            <X size={12} strokeWidth={2.5} />
            clear
          </button>
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.searchGroup}>
          <Search size={16} strokeWidth={1.75} className={styles.searchIcon} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search canon..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="canon-search"
            aria-label="Search canon"
          />
        </div>
        <TypeFilter
          options={TYPE_OPTIONS}
          activeId={activeFilterId}
          onSelect={setActiveFilterId}
        />
      </div>

      {dataQuery.isPending && <LoadingState />}
      {dataQuery.isError && <ErrorState message={(dataQuery.error as Error).message} />}
      {dataQuery.isSuccess && atoms.length === 0 && <EmptyState focusId={focusId} />}

      {dataQuery.isSuccess && atoms.length > 0 && (
        <div className={styles.stats}>
          <span className={styles.statsTotal}>{atoms.length}</span>
          <span className={styles.statsLabel}>
            atom{atoms.length === 1 ? '' : 's'}
          </span>
          <span className={styles.statsDetail}>
            {summarizeCounts(counts)}
          </span>
        </div>
      )}

      <motion.div className={styles.grid} layout>
        <AnimatePresence mode="popLayout">
          {atoms.map((atom) => (
            <motion.div
              key={atom.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            >
              <CanonCard atom={atom} />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    </section>
  );
}

function countByType(atoms: ReadonlyArray<CanonAtom>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of atoms) out[a.type] = (out[a.type] ?? 0) + 1;
  return out;
}

function summarizeCounts(counts: Record<string, number>): string {
  const order: AtomType[] = ['directive', 'decision', 'preference', 'reference'];
  const parts: string[] = [];
  for (const t of order) {
    if (counts[t]) parts.push(`${counts[t]} ${t}${counts[t] === 1 ? '' : 's'}`);
  }
  for (const [t, n] of Object.entries(counts)) {
    if (!order.includes(t as AtomType)) parts.push(`${n} ${t}`);
  }
  return parts.join(' • ');
}

function LoadingState() {
  return (
    <div className={styles.state} data-testid="canon-loading">
      <div className={styles.spinner} aria-hidden="true" />
      <p>Loading canon…</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className={styles.state} data-testid="canon-error">
      <p className={styles.errorTitle}>Could not load canon</p>
      <code className={styles.errorDetail}>{message}</code>
    </div>
  );
}

function EmptyState({ focusId }: { focusId: string | null }) {
  // When the user landed here via an atom-ref focus but canon doesn't
  // have that atom, suggest Activities or Plans — the atom graph is
  // bigger than canon and the ref might point to a plan, observation,
  // or actor-message.
  if (focusId) {
    const suggest = inferRouteForId(focusId);
    return (
      <div className={styles.state} data-testid="canon-empty">
        <p className={styles.emptyTitle}>Not in canon</p>
        <p className={styles.emptyDetail}>
          <code>{focusId}</code> isn't an L3 canon atom. It may be a {suggest.kind}.
        </p>
        <a
          className={styles.emptyAction}
          href={`/${suggest.route}?focus=${encodeURIComponent(focusId)}`}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setRoute(suggest.route, { focus: focusId });
          }}
        >
          Open in {suggest.routeLabel} →
        </a>
      </div>
    );
  }
  return (
    <div className={styles.state} data-testid="canon-empty">
      <p className={styles.emptyTitle}>No atoms match the current filter.</p>
      <p className={styles.emptyDetail}>
        Try clearing the search or selecting a different type.
      </p>
    </div>
  );
}

function inferRouteForId(id: string): { route: 'plans' | 'activities'; routeLabel: string; kind: string } {
  if (id.startsWith('plan-')) return { route: 'plans', routeLabel: 'Plans', kind: 'plan' };
  if (id.startsWith('op-action-') || id.startsWith('ama-')) {
    return { route: 'activities', routeLabel: 'Activities', kind: 'non-canon atom (observation / actor-message)' };
  }
  return { route: 'activities', routeLabel: 'Activities', kind: 'non-canon atom' };
}
