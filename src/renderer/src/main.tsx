import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles.css';
import { applyTokens } from './tokens';
import { createSimulatedAdapter } from './adapters/simulated';

applyTokens();
// macOS superpone las barras de desplazamiento; Windows y Linux las pintan
// clásicas (~15 px) y restan ese ancho a cada panel. Allí se usan barras
// finas de la marca para que el contenido mida lo mismo en los tres.
document.documentElement.dataset.scrollbars = /Mac/i.test(navigator.platform)
  ? 'overlay'
  : 'classic';
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
