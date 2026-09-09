import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// Imported for its side effect, and that is the whole demonstration: declaring a tool at module scope,
// before `createRoot` runs and before any provider exists. The declaration is held and registered by
// the provider when it mounts. Nothing here waits for React.
import './shell-tools.ts';
import './styles.css';

// Mounted under StrictMode, which is the renderer's default for a new development setup.
//
// That is a deliberate choice rather than boilerplate. StrictMode double-invokes every effect —
// setup, cleanup, setup — which is precisely the sequence that puts two registrations of one tool name
// in flight at once. A demonstrator that turned it off would be demonstrating a page no author's
// application resembles, and would hide the one lifecycle bug this wiring had to solve.

const container = document.querySelector('#root');
if (container === null) throw new Error('the example page has no #root element to mount into');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
