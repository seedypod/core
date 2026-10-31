import { defineConfig } from '@playwright/test'

if (!process.env.SEEDYPOD_E2E) {
  throw new Error('Run browser tests via `node tests/browser/run.mjs` (it boots the built server with a scratch database).')
}

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/browser/junit.xml' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3218',
    // Local override for machines with a system Chromium; CI installs Playwright's own.
    ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: 'test-results/browser/artifacts',
})
