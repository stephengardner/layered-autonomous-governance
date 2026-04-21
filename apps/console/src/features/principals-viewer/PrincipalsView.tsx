import { useQuery } from '@tanstack/react-query';
import { listPrincipals } from '@/services/principals.service';
import { PrincipalCard } from './PrincipalCard';
import styles from './PrincipalsView.module.css';

export function PrincipalsView() {
  const query = useQuery({
    queryKey: ['principals'],
    queryFn: ({ signal }) => listPrincipals(signal),
  });

  const principals = query.data ?? [];

  return (
    <section className={styles.view}>
      {query.isPending && (
        <div className={styles.state} data-testid="principals-loading">
          <div className={styles.spinner} aria-hidden="true" />
          <p>Loading principals…</p>
        </div>
      )}
      {query.isError && (
        <div className={styles.state} data-testid="principals-error">
          <p className={styles.errorTitle}>Could not load principals</p>
          <code className={styles.errorDetail}>{(query.error as Error).message}</code>
        </div>
      )}
      {query.isSuccess && principals.length === 0 && (
        <div className={styles.state} data-testid="principals-empty">
          <p>No principals found in .lag/principals/.</p>
        </div>
      )}
      {query.isSuccess && principals.length > 0 && (
        <>
          <div className={styles.stats}>
            <span className={styles.statsTotal}>{principals.length}</span>
            <span className={styles.statsLabel}>
              principal{principals.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className={styles.grid}>
            {principals.map((p) => (
              <PrincipalCard key={p.id} principal={p} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
