import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AccountDetail } from '../components/AccountDetail.tsx';
import { ActivityLog } from '../components/ActivityLog.tsx';
import { FilterPanel } from '../components/FilterPanel.tsx';
import { ResultsTable } from '../components/ResultsTable.tsx';
import { SavedViews } from '../components/SavedViews.tsx';
import { SummaryBar } from '../components/SummaryBar.tsx';
import { PATH, SCREEN } from '../router.tsx';
import { useDashboard } from '../state/dashboard.tsx';

// The screen the acceptance scenario names (docs/design.md#the-acceptance-scenario), and the one
// whose tools go away when you leave it.
//
// Everything here declares its own tools through the component that owns the feature — `FilterPanel`
// declares `customers.set_filters` and `customers.clear_filters` and the state surface, `ResultsTable`
// declares `customers.list`, and so on. None of that changed when this page was extracted; what
// changed is that there is now somewhere else to be, so the tool set follows the route.
//
// That is steps 11–13 of the acceptance scenario in one sentence: navigate away, and the tools this
// page declared are gone
// from the agent's listing — because the components that declared them unmounted, not because
// anything withdrew them deliberately.

/** The right-hand column: the open account, then the log. */
function Sidebar(): ReactNode {
  const dashboard = useDashboard();
  return (
    <aside className="side">
      {dashboard.selected === undefined ? (
        <section className="drawer drawer-empty">
          <h2>No account open</h2>
          <p className="muted">
            Click a row, or ask the agent to open one. The per-account tools exist only while a
            drawer is open.
          </p>
        </section>
      ) : (
        <AccountDetail account={dashboard.selected} />
      )}
      <ActivityLog />
    </aside>
  );
}

export function CustomersPage(): ReactNode {
  return (
    <div className="app-body">
      <div className="left">
        <FilterPanel />
        <SavedViews />
        <p className="muted">
          <Link to={PATH[SCREEN.activity]}>Activity log →</Link>
        </p>
      </div>
      <main className="center">
        <SummaryBar />
        <ResultsTable />
      </main>
      <Sidebar />
    </div>
  );
}
