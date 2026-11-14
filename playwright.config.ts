import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  globalSetup: './e2e/setup.ts',
  use: {
    ...devices['iPhone 14'],
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  projects: [{ name: 'iphone', use: { browserName: 'chromium' } }],
});
