import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  webServer: {
    command: 'pnpm exec vite dev --host --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
});
