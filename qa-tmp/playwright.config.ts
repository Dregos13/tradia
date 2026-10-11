import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', timeout: 600_000, retries: 0, reporter: 'list', workers: 1 });
