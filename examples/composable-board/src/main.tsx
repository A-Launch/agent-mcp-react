import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// Imported for its SIDE EFFECT, and that is the whole point: it declares the three composition tools at
// module scope, before `createRoot` runs and before any provider exists. The declarations are held and
// registered by the provider when it mounts. Nothing here waits for React — and without this line those
// tools are never declared at all, with an empty tool list as the only symptom.
import './shell-tools.ts';
import './styles.css';

// Mounted under StrictMode, which is the renderer's default for a new development setup.
//
// Deliberate rather than boilerplate: StrictMode double-invokes every effect — setup, cleanup, setup —
// which is exactly the sequence that puts two registrations of one tool name in flight at once. A
// demonstrator that turned it off would be demonstrating a page no author's application resembles.

const container = document.querySelector('#root');
if (container === null) throw new Error('the board page has no #root element to mount into');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
