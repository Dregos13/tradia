import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles.css';
import { applyTokens } from './tokens';
import { createSimulatedAdapter } from './adapters/simulated';

applyTokens();
if (import.meta.env.DEV && import.meta.env.VITE_TRADIA_SIMULATED === 'true' && !window.tradia) {
  window.tradia = createSimulatedAdapter().api;
}

const root = document.getElementById('root');
if (!root) throw new Error('No se encontró #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
