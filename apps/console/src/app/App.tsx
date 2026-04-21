import { useEffect } from 'react';
import { AppShell } from '@/components/app-shell/AppShell';
import { CanonViewer } from '@/features/canon-viewer/CanonViewer';
import { PrincipalsView } from '@/features/principals-viewer/PrincipalsView';
import { ActivitiesView } from '@/features/activities-viewer/ActivitiesView';
import { PlansView } from '@/features/plans-viewer/PlansView';
import { useRoute, type Route } from '@/state/router.store';
import { useThemeStore } from '@/state/theme.store';

/**
 * App root. Responsibilities:
 *   - Mirror theme state onto <body> class so CSS theme selectors
 *     fire. This is the ONE useEffect that genuinely is a DOM side
 *     effect, not a data fetch. (Permitted per canon directive
 *     dev-web-services-over-useeffect.)
 *   - Render the active route's view inside the AppShell.
 */
export function App() {
  const theme = useThemeStore((s) => s.theme);
  const route = useRoute();

  useEffect(() => {
    const body = document.body;
    body.classList.remove('theme-dark', 'theme-light', 'theme-sunset');
    body.classList.add(`theme-${theme}`);
  }, [theme]);

  return (
    <AppShell route={route}>
      {renderRoute(route)}
    </AppShell>
  );
}

function renderRoute(r: Route) {
  switch (r) {
    case 'canon': return <CanonViewer />;
    case 'principals': return <PrincipalsView />;
    case 'activities': return <ActivitiesView />;
    case 'plans': return <PlansView />;
  }
}
