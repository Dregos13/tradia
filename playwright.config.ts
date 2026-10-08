import { defineConfig } from '@playwright/test';

// Las pruebas de extremo a extremo se implementan en la tarea «e2e-tests»
// con el _electron de Playwright sobre la build de electron-vite.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
});
