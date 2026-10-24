import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { loadConfig } from '../apps/server/src/config.ts'
import { startServer } from '../apps/server/src/start-server.ts'
import { starterPlan, starterRecipes } from '../apps/web/src/bold/bold-first-run.ts'

// PLAN 11.10b: first run from an empty home, then the starter recipes and lead it saved. Each size gets its own Score
// home and fake server, so the spec starts before any demo state and both sizes can run in parallel.

test.use({ reducedMotion: 'reduce' })
test.setTimeout(120_000)

const webPort = Number(process.env.SCORE_WEB_PORT ?? '5173')

async function withFreshServer(
  page: Page,
  port: number,
  run: (origin: string, pairingToken: string, home: string) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), `score-first-run-${port}-`))
  const origin = `http://127.0.0.1:${port}`
  const server = await startServer(
    loadConfig({
      SCORE_HOME: home,
      SCORE_MODE: 'fake',
      SCORE_FAKE_LOOP: 'false',
      SCORE_HOST: '127.0.0.1',
      SCORE_PORT: String(port),
      SCORE_WEB_ORIGIN: origin,
      SCORE_SERVE_WEB: '1',
    }),
    { logger: false },
  )
  try {
    await run(origin, server.pairingToken, home)
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
}

function clearTeamLead(home: string) {
  const db = new DatabaseSync(join(home, 'score.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    expect(
      db.prepare("UPDATE rooms SET lead_agent_id = NULL WHERE role = 'team'").run().changes,
    ).toBe(1)
  } finally {
    db.close()
  }
}

async function pair(page: Page, origin: string, pairingToken: string) {
  await page.goto(`${origin}/pair#${pairingToken}`)
  await expect(page.getByText('This browser is paired')).toBeVisible()
}

test.beforeAll(() => {
  const dist = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))
  if (!existsSync(dist))
    execFileSync('pnpm', ['--filter', '@score/web', 'build'], {
      stdio: 'ignore',
      timeout: 120_000,
    })
})

async function firstRunFlow(page: Page, origin: string, pairingToken: string) {
  await pair(page, origin, pairingToken)

  await page.goto(`${origin}/b`)
  await expect(
    page.getByRole('heading', { name: 'Run a team of agents from one room.' }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Hermes found' })).toBeVisible()

  const members = page.getByRole('list', { name: 'Team members' })
  await expect(members.getByRole('listitem')).toHaveCount(4)
  for (const id of ['lead', 'builder', 'reviewer', 'designer'])
    await expect(members.getByText(id, { exact: true })).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Add or remove agents on the Team page' }),
  ).toHaveAttribute('href', '/b/team')

  const open = page.getByRole('button', { name: 'Open the team room' })
  await expect(open).toBeDisabled()
  await page.getByRole('combobox', { name: /Who leads/ }).selectOption('reviewer')
  await expect(open).toBeEnabled()

  await page.getByRole('checkbox', { name: /Build, then review/ }).check()
  await page.getByRole('checkbox', { name: /Write, review, design/ }).check()
  await page.getByRole('checkbox', { name: /Research report/ }).check()

  // Save one recipe behind the page's back after it selected all three. Opening the room refetches the list and must
  // skip that name instead of creating a duplicate.
  const research = starterRecipes.find((recipe) => recipe.name === 'Research report')!
  const researchPlan = starterPlan(research, {
    members: ['lead', 'builder', 'reviewer', 'designer'],
    agents: [
      { id: 'lead', role: 'Leads the team' },
      { id: 'builder', role: 'Builds features' },
      { id: 'reviewer', role: 'Reviews changes' },
      { id: 'designer', role: 'Designs interfaces' },
    ],
    leadAgentId: 'reviewer',
  })
  const existing = await page.request.post(`${origin}/api/workflows`, {
    headers: { origin, 'x-score-client': 'web' },
    data: { definition: researchPlan.definition },
  })
  expect(existing.status()).toBe(201)
  await open.click()

  await expect(page).toHaveURL(`${origin}/b`)
  await expect(
    page.getByRole('heading', { name: 'Run a team of agents from one room.' }),
  ).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Team room' })).toBeVisible()

  const teamResponse = await page.request.get(`${origin}/api/team-room`)
  expect(teamResponse.ok()).toBe(true)
  const team = (await teamResponse.json()) as { room: { leadAgentId: string | null } }
  expect(team.room.leadAgentId).toBe('reviewer')

  const workflowsResponse = await page.request.get(`${origin}/api/workflows`)
  expect(workflowsResponse.ok()).toBe(true)
  const workflows = (await workflowsResponse.json()) as { items: { name: string }[] }
  expect(workflows.items.map((item) => item.name).sort()).toEqual([
    'Build, then review',
    'Research report',
    'Write, review, design',
  ])

  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Run a team of agents from one room.' }),
  ).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Team room' })).toBeVisible()

  await page.goto(`${origin}/b?first=run`)
  await expect(
    page.getByRole('heading', { name: 'Run a team of agents from one room.' }),
  ).toBeVisible()
  await expect(page.getByRole('combobox', { name: /Who leads/ })).toHaveValue('reviewer')
  await expect(page.getByText('Already saved')).toHaveCount(3)
  for (const name of ['Build, then review', 'Write, review, design', 'Research report'])
    await expect(page.getByRole('checkbox', { name: new RegExp(name) })).toBeDisabled()
}

for (const [index, size] of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
].entries()) {
  test(`first run, starter recipes and the saved lead at ${size.name} (${size.width}×${size.height})`, async ({
    page,
  }) => {
    const port = webPort + 40 + index
    await page.setViewportSize({ width: size.width, height: size.height })
    await withFreshServer(page, port, async (origin, pairingToken, home) => {
      clearTeamLead(home)
      await firstRunFlow(page, origin, pairingToken)
    })
  })

  test(`a team room with a lead skips first run at ${size.name} (${size.width}×${size.height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    await withFreshServer(page, webPort + 50 + index, async (origin, pairingToken) => {
      await pair(page, origin, pairingToken)
      await page.goto(`${origin}/b`)
      await expect(page.getByRole('region', { name: 'Team room' })).toBeVisible()
      await expect(
        page.getByRole('heading', { name: 'Run a team of agents from one room.' }),
      ).toHaveCount(0)
    })
  })
}

test('degraded Hermes says what needs attention and links to setup', async ({ page }) => {
  await withFreshServer(page, webPort + 60, async (origin, pairingToken) => {
    await pair(page, origin, pairingToken)
    await page.route('**/api/system', (route) =>
      route.fulfill({
        json: {
          mode: 'fake',
          hermes: {
            version: '0.15.2',
            reachable: true,
            apiServer: true,
            capabilities: [],
            servedProfiles: ['lead', 'builder', 'reviewer', 'designer'],
          },
          bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
          compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
          agentIsolation: 'same_user',
          degraded: ['The bridge is out of date.'],
        },
      }),
    )
    await page.goto(`${origin}/b?first=run`)
    await expect(
      page.getByRole('heading', { name: 'Hermes found, but it needs attention' }),
    ).toBeVisible()
    await expect(page.getByText('The bridge is out of date.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open the setup help' })).toHaveAttribute(
      'href',
      '/settings/connections',
    )
  })
})
