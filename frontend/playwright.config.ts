import { defineConfig, devices } from '@playwright/test'

const origin = process.env.WORKER_BROWSER_E2E_ORIGIN ?? 'http://127.0.0.1:8791'
const chromeExecutable = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['line']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: origin,
    browserName: 'chromium',
    channel: chromeExecutable ? undefined : 'chrome',
    headless: true,
    launchOptions: chromeExecutable ? { executablePath: chromeExecutable } : undefined,
    trace: 'retain-on-failure',
  },
})
