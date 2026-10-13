import { defineConfig } from '@playwright/test';

/**
 * Repetición en la app real del cierre de los 23 fallos (no forma parte de
 * `npm run test:e2e`). Se lanza con:
 *   npx electron-vite build && npx playwright test -c docs/qa/cierre-fallos/retest-3
 */
export default defineConfig({
  testDir: '.',
  timeout: 600_000,
  retries: 0,
  reporter: 'list',
  workers: 1,
});
