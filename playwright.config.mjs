import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './ui-tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1',
  },
});
