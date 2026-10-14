import { defineConfig, devices } from '@playwright/test';
import { PORT } from './e2e/setup.ts';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  globalSetup: './e2e/setup.ts',
  use: {
    ...devices['iPhone 14'],
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  projects: [{ name: 'iphone', use: { browserName: 'chromium' } }],
});
