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
  // E2E runs the production build (what the owner runs): one Score process serving the built web app on the web port.
  // The unbundled dev server loads ~130 modules per page, and on full page loads headless Chromium dropped some with
  // ERR_INSUFFICIENT_RESOURCES (2026-10-08), so the page never started. SCORE_E2E_DEV=1 keeps the Vite dev server.
  webServer: process.env.SCORE_E2E_DEV
    ? {
        command: `pnpm dev 2>&1 | tee ${join(scoreHome, 'dev.log')}`,
        // The server only accepts mutations from its own web origin, so it must follow SCORE_WEB_PORT.
        env: {
          SCORE_HOME: scoreHome,
          SCORE_MODE: 'fake',
          SCORE_WEB_ORIGIN: baseURL,
          // The specs read the pairing link from dev.log: a non-terminal stdout only gets it on request.
          SCORE_PRINT_PAIR_LINK: '1',
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      }
    : {
        command: `pnpm build >/dev/null && node scripts/start.mjs 2>&1 | tee ${join(scoreHome, 'dev.log')}`,
        env: {
          SCORE_HOME: scoreHome,
          SCORE_MODE: 'fake',
          SCORE_SERVE_WEB: '1',
          SCORE_PORT: webPort,
          SCORE_WEB_ORIGIN: baseURL,
          SCORE_PRINT_PAIR_LINK: '1',
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
})
