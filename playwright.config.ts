import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const webPort = process.env.SCORE_WEB_PORT ?? '5173'
const baseURL = `http://127.0.0.1:${webPort}`
// Kanban attempts (5.17a-1) are behind SCORE_KANBAN_ATTEMPTS, so their spec gets its own server with the flag on and
// seeded attempts; every other spec keeps the flag off, exactly as the app ships.
const attemptsPort = String(Number(webPort) + 1)
const attemptsURL = `http://127.0.0.1:${attemptsPort}`
const attemptsSpec = /attempts\.spec\.ts$/
// E2E never touches the developer's real Score home (~/.score): each run gets a throwaway one. Everything a run creates
// (server homes, logs, and the temp folders specs and servers make) lives under one folder in /tmp that globalTeardown
// removes, so a run leaves nothing behind. The name is fixed per web port because Playwright evaluates this config in
// several processes; the first server command clears the previous run's state if a crash left it behind.
const runDir = process.env.SCORE_E2E_HOME ?? join(tmpdir(), `score-e2e-${webPort}`)
const scoreHome = join(runDir, 'home')
const attemptsHome = join(runDir, 'attempts-home')
const scratch = join(runDir, 'tmp')
for (const dir of [runDir, scratch]) mkdirSync(dir, { recursive: true })

// The coding-agent CLIs are replaced by a script that prints hand-made fixtures (PLAN 7.2); no model is ever called.
const fakeCodingCli = resolve('apps/server/test/fixtures/coding/fake-cli.mjs')

// Workers inherit this, so specs that need a paired browser can read the pairing link the server logs.
process.env.SCORE_E2E_HOME = runDir
process.env.TMPDIR = scratch

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    // A project's testIgnore replaces the top-level one, so the README screenshot generator (its own config,
    // `pnpm screenshots`) is excluded here.
    {
      name: 'chromium',
      testIgnore: [attemptsSpec, /e2e\/readme\//],
      use: { ...devices['Desktop Chrome'] },
    },
    ...(process.env.SCORE_E2E_DEV
      ? []
      : [
          {
            name: 'attempts',
            testMatch: attemptsSpec,
            use: { ...devices['Desktop Chrome'], baseURL: attemptsURL },
          },
        ]),
  ],
  // E2E runs the production build (what the owner runs): one Score process serving the built web app on the web port.
  // The unbundled dev server loads ~130 modules per page, and on full page loads headless Chromium dropped some with
  // ERR_INSUFFICIENT_RESOURCES (2026-10-08), so the page never started. SCORE_E2E_DEV=1 keeps the Vite dev server.
  webServer: process.env.SCORE_E2E_DEV
    ? [
        {
          command: `rm -rf ${scoreHome} ${join(runDir, 'paired.lock')} ${join(runDir, 'paired-session.json')}; pnpm dev 2>&1 | tee ${join(runDir, 'dev.log')}`,
          // The server only accepts mutations from its own web origin, so it must follow SCORE_WEB_PORT.
          env: {
            SCORE_HOME: scoreHome,
            TMPDIR: scratch,
            SCORE_MODE: 'fake',
            SCORE_CODING_FAKE_CLI: fakeCodingCli,
            // Antigravity levels the specs may use; 'full' stays unverified so the disabled state is covered.
            SCORE_CODING_VERIFIED_ANTIGRAVITY: 'read-only,workspace-write',
            SCORE_FAKE_REWIND_SKIP: 'reviewer:compressed',
            SCORE_WEB_ORIGIN: baseURL,
            // The specs read the pairing link from dev.log: a non-terminal stdout only gets it on request.
            SCORE_PRINT_PAIR_LINK: '1',
          },
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ]
    : [
        {
          command: `rm -rf ${scoreHome} ${join(runDir, 'paired.lock')} ${join(runDir, 'paired-session.json')}; pnpm build >/dev/null && node scripts/start.mjs 2>&1 | tee ${join(runDir, 'dev.log')}`,
          env: {
            SCORE_HOME: scoreHome,
            TMPDIR: scratch,
            SCORE_MODE: 'fake',
            SCORE_CODING_FAKE_CLI: fakeCodingCli,
            // Antigravity levels the specs may use; 'full' stays unverified so the disabled state is covered.
            SCORE_CODING_VERIFIED_ANTIGRAVITY: 'read-only,workspace-write',
            // The fake adapter cannot rewind this agent (PLAN 5.33: "Hide in Score only").
            SCORE_FAKE_REWIND_SKIP: 'reviewer:compressed',
            SCORE_SERVE_WEB: '1',
            SCORE_PORT: webPort,
            SCORE_WEB_ORIGIN: baseURL,
            SCORE_PRINT_PAIR_LINK: '1',
          },
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
        },
        {
          // Build once (the first server builds); this one only serves.
          command: `rm -rf ${attemptsHome}; node scripts/start.mjs 2>&1 | tee ${join(runDir, 'attempts.log')}`,
          env: {
            SCORE_HOME: attemptsHome,
            TMPDIR: scratch,
            SCORE_MODE: 'fake',
            SCORE_KANBAN_ATTEMPTS: '1',
            SCORE_E2E_SEED_ATTEMPTS: '1',
            SCORE_SERVE_WEB: '1',
            SCORE_PORT: attemptsPort,
            SCORE_WEB_ORIGIN: attemptsURL,
            SCORE_PRINT_PAIR_LINK: '1',
          },
          url: attemptsURL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
        },
      ],
})
