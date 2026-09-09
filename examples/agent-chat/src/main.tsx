import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const container = document.querySelector('#root');
if (container === null) throw new Error('the chat page has no #root element to mount into');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
