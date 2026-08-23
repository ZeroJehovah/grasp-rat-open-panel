import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:15173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'narrow', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'vite --config frontend/vite.config.ts',
    url: 'http://127.0.0.1:15173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
