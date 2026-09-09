import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ActivityLog } from '../components/ActivityLog.tsx';
import { PATH, SCREEN } from '../router.tsx';

// Somewhere to navigate TO, and its emptiness is the point.
//
// This page declares NO customer tools. That is what makes step 12 of the acceptance scenario
// (docs/design.md#the-acceptance-scenario) — *"customers.set_filters is
// removed from MCP discovery"* — something observed rather than asserted: navigating here unmounts
// the components that declared those tools, and the agent's listing shrinks because the application
// changed, not because anything withdrew them on purpose.

export function ActivityPage(): ReactNode {
  return (
    <main className="page">
      <h1>Activity</h1>
      <p>
        Every change made to this dashboard, by a person or by an agent. This screen declares no
        customer tools — which is what makes the agent's tool list change when you navigate here.
      </p>
      <ActivityLog />
      <p className="muted">
        <Link to={PATH[SCREEN.customers]}>← Back to customers</Link>
      </p>
    </main>
  );
}
