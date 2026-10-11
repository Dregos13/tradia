import { defineConfig } from '@playwright/test';

/**
 * Recorrido manual de diagnóstico «datos desactualizados» (no forma parte de
 * `npm run test:e2e`). Se lanza con:
 *   npm run build && npx playwright test -c docs/qa/datos-desactualizados/recorrido
 */
export default defineConfig({
  testDir: '.',
  timeout: 600_000,
  retries: 0,
  reporter: 'list',
  workers: 1,
});
