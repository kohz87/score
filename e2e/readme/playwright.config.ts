import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Regenerates the README screenshots (`pnpm screenshots`). It is not part of `pnpm e2e` (the main config ignores
// e2e/readme). It starts its own fake-mode Score (the neutral demo team, no Hermes, no model calls) in a throwaway home
// under /tmp and pairs a browser with it, exactly like the main e2e run, so it never touches ~/.score or a live server.
const webPort = process.env.SCORE_WEB_PORT ?? '5173'
const baseURL = `http://127.0.0.1:${webPort}`
const runDir = process.env.SCORE_E2E_HOME ?? join(tmpdir(), `score-readme-shots-${webPort}`)
const scoreHome = join(runDir, 'home')
const scratch = join(runDir, 'tmp')
for (const dir of [runDir, scratch]) mkdirSync(dir, { recursive: true })
// The pairing helper in e2e/pair.ts reads the link from here.
process.env.SCORE_E2E_HOME = runDir

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, ...devices['Desktop Chrome'] },
  webServer: {
    command: `rm -rf ${scoreHome} ${join(runDir, 'paired.lock')} ${join(runDir, 'paired-session.json')}; cd ../.. && pnpm build >/dev/null && node scripts/start.mjs 2>&1 | tee ${join(runDir, 'dev.log')}`,
    env: {
      SCORE_HOME: scoreHome,
      TMPDIR: scratch,
      SCORE_MODE: 'fake',
      SCORE_CODING_FAKE_CLI: resolve('../../apps/server/test/fixtures/coding/fake-cli.mjs'),
      CODEX_HOME: join(runDir, 'codex-home'),
      SCORE_SERVE_WEB: '1',
      SCORE_PORT: webPort,
      SCORE_WEB_ORIGIN: baseURL,
      SCORE_PRINT_PAIR_LINK: '1',
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
  },
})
