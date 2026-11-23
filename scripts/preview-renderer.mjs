/**
 * Vista previa del renderer en el navegador con el adaptador simulado
 * (sin Electron ni proveedores reales). Uso: node scripts/preview-renderer.mjs
 */
import console from 'node:console';
import process from 'node:process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const port = Number(process.env.PORT ?? 5195);
const server = await createServer({
  configFile: false,
  root: 'src/renderer',
  plugins: [react()],
  server: { host: '127.0.0.1', port, strictPort: true },
  define: { 'import.meta.env.VITE_TRADIA_SIMULATED': '"true"' },
});
await server.listen();
console.log(`Renderer simulado en http://127.0.0.1:${port}/`);
