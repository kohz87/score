import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const webPort = process.env.SCORE_WEB_PORT ?? '5173'
const baseURL = `http://127.0.0.1:${webPort}`
// E2E never touches the developer's real Score home (~/.score): each run gets a throwaway one.
const scoreHome = process.env.SCORE_E2E_HOME ?? mkdtempSync(join(tmpdir(), 'score-e2e-'))

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    env: { SCORE_HOME: scoreHome, SCORE_MODE: 'fake' },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
