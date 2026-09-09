import type { ReactNode } from 'react';
import { createBrowserRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { ActivityPage } from './pages/ActivityPage.tsx';
import { CustomersPage } from './pages/CustomersPage.tsx';

// The demonstrator's routes, and the router object itself.
//
// **A DATA router, created at MODULE SCOPE, and both halves of that are load-bearing.**
//
// `router.navigate()` is a method on an object that exists before React mounts. That is what lets a
// navigation tool be declared by the application SHELL — outside every component, at import time —
// which is exactly the case `@agent-mcp/react/actions` exists for (docs/tools-outside-react.md). The
// usual alternative
// is a mutable ref that a component fills in an effect, and a tool built on one would be registered
// and non-functional until something rendered: a tool that lies about being ready.
//
// The two routes are not decoration. Step 11 of the acceptance scenario
// (docs/design.md#the-acceptance-scenario) is *"user navigates away from CustomersPage"*, and steps
// 12–13 are that its tools go with it and a later call is refused. `ActivityPage` declares no
// customer tools, which is what makes that observable rather than asserted.

/**
 * The screens this application has, as a closed set: declared once here, with the type and every
 * derived table below taken from it rather than re-spelled.
 *
 * The vocabulary an agent chooses from in `shell.go_to`, and the key everything below is derived
 * from. A screen name is stable in a way a path is not: renaming `/activity` should not silently
 * change a tool's declared enum, and changing the enum should not silently strand a link.
 */
export const SCREEN = {
  customers: 'customers',
  activity: 'activity',
} as const;
export type Screen = (typeof SCREEN)[keyof typeof SCREEN];

/**
 * The path each screen lives at. **The ONE place a path is spelled.**
 *
 * Every other reference derives from this map: the route table below, the `<Link>` on each page, and
 * the shell's navigation tool. They used to spell the paths separately — four copies — and the
 * failure mode was silent rather than loud: renaming `/activity` here left `shell.go_to` navigating
 * to a route that no longer matched, and a navigation to nowhere still reports success. One owner
 * per truth — this map — and everything else derived from it.
 */
export const PATH: Readonly<Record<Screen, string>> = {
  [SCREEN.customers]: '/',
  [SCREEN.activity]: '/activity',
};

/**
 * The path for a screen name, refusing loudly when there is no such screen.
 *
 * The library validates `shell.go_to`'s argument against the enum above before the handler runs, so
 * by the time this is called the name IS a screen. It still checks, because the alternative is an
 * `as`-cast onto a type the value has not been proven to inhabit — and the day the enum and this map
 * disagree, a cast returns `undefined`, the router navigates to nowhere, and the tool reports
 * success. An unexpected state has to fail loud, which is what the throw below is for.
 */
export function pathOf(screen: unknown): string {
  const path =
    typeof screen === 'string' ? (PATH as Record<string, string | undefined>)[screen] : undefined;
  if (path === undefined) throw new Error(`no screen named "${String(screen)}"`);
  return path;
}

/** The route table, DERIVED from the map above — same pages, same tools, same components. */
export const ROUTES = [
  { path: PATH[SCREEN.customers], element: <CustomersPage /> },
  { path: PATH[SCREEN.activity], element: <ActivityPage /> },
];

/**
 * The router this application runs on, in a browser.
 *
 * A DATA router, so `router.navigate()` exists on an object created before React mounts — which is
 * what lets the shell's navigation tool bind a real navigate at import time
 * (docs/store-adapters.md#the-navigate-you-pass-must-exist-outside-react).
 */
export const router = createBrowserRouter(ROUTES);

/**
 * The routed screens as the browser runs them.
 *
 * Keeps `react-router-dom` inside this package: a caller imports THIS, never the router library, so
 * the demonstrator's choice of router stays the demonstrator's business.
 */
export function RoutedScreens(): ReactNode {
  return <RouterProvider router={router} />;
}

/**
 * The same routes, mounted on a COMPONENT router with an in-memory history.
 *
 * **For a test environment, and the difference is recorded rather than hidden** — this is the one
 * place the acceptance suite drives something other than exactly what the browser runs.
 *
 * Why it is needed, measured rather than assumed: a data router performs every navigation through
 * `fetch`, and Node's `fetch` refuses an `AbortSignal` that is not its own. jsdom installs its own,
 * so **any** `fetch(url, { signal })` under jsdom fails with *"Expected signal to be an instance of
 * AbortSignal"* — confirmed with a bare fetch and no router in the picture. A real browser has one
 * `AbortSignal`, so the problem does not exist there.
 *
 * **What is identical**: `ROUTES` above, the pages, the components, every tool they declare, and the
 * unmount that withdraws those tools when a route changes. Only the history backend and the
 * navigation mechanism differ — and step 11 of the acceptance scenario
 * (docs/design.md#the-acceptance-scenario) is *"the USER navigates away"*, which a person does
 * by clicking a link. A test that clicks the link is closer to that sentence than one calling a
 * router method would be.
 */
export function RoutedScreensInMemory(): ReactNode {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        {ROUTES.map((route) => (
          <Route key={route.path} path={route.path} element={route.element} />
        ))}
      </Routes>
    </MemoryRouter>
  );
}
