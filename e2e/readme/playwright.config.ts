import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Regenerates the README screenshots (`pnpm screenshots`). It is not part of `pnpm e2e` (the main config ignores
// e2e/readme). The pages are drawn from the e2e fixtures with every /api call stubbed, so a demo server only has to
// serve the built web app: it never touches a real Hermes or ~/.score.
const webPort = process.env.SCORE_WEB_PORT ?? '5173'
const baseURL = `http://127.0.0.1:${webPort}`
const home = join(tmpdir(), `score-readme-shots-${webPort}`)
mkdirSync(home, { recursive: true })

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, ...devices['Desktop Chrome'] },
  webServer: {
    command: `rm -rf ${home}/home; cd ../.. && pnpm build >/dev/null && node scripts/start.mjs`,
    env: {
      SCORE_HOME: join(home, 'home'),
      SCORE_MODE: 'fake',
      SCORE_SERVE_WEB: '1',
      SCORE_PORT: webPort,
      SCORE_WEB_ORIGIN: baseURL,
    },
    url: baseURL,
    reuseExistingServer: true,
    timeout: 300_000,
  },
})
