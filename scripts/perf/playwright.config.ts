import { defineConfig, devices } from '@playwright/test'

// Driven by scripts/load-test.ts against its throwaway server and web preview; not part of `pnpm e2e`.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  use: { baseURL: process.env.PERF_BASE_URL, ...devices['Desktop Chrome'] },
})
