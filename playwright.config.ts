import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const webPort = process.env.SCORE_WEB_PORT ?? '5173'
const baseURL = `http://127.0.0.1:${webPort}`
// E2E never touches the developer's real Score home (~/.score): each run gets a throwaway one.
const scoreHome = process.env.SCORE_E2E_HOME ?? mkdtempSync(join(tmpdir(), 'score-e2e-'))

// Workers inherit this, so specs that need a paired browser can read the pairing link the server logs.
process.env.SCORE_E2E_HOME = scoreHome

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev 2>&1 | tee ${join(scoreHome, 'dev.log')}`,
    // The server only accepts mutations from its own web origin, so it must follow SCORE_WEB_PORT.
    env: { SCORE_HOME: scoreHome, SCORE_MODE: 'fake', SCORE_WEB_ORIGIN: baseURL },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
