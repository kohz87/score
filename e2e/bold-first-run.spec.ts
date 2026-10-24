import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { loadConfig } from '../apps/server/src/config.ts'
import { startServer } from '../apps/server/src/start-server.ts'

// PLAN 11.10b: first run from an empty home, then the starter recipes and lead it saved. Each size gets its own Score
// home and fake server, so the spec starts before any demo state and both sizes can run in parallel.

test.use({ reducedMotion: 'reduce' })
test.setTimeout(120_000)

const webPort = Number(process.env.SCORE_WEB_PORT ?? '5173')

test.beforeAll(() => {
  const dist = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))
  if (!existsSync(dist))
    execFileSync('pnpm', ['--filter', '@score/web', 'build'], {
      stdio: 'ignore',
      timeout: 120_000,
    })
})

async function firstRunFlow(page: Page, origin: string, pairingToken: string) {
  await page.goto(`${origin}/pair#${pairingToken}`)
  await expect(page.getByText('This browser is paired')).toBeVisible()

  // A fresh fake home has the demo team, but the fake seed gives it a lead for the boards. Clear that one row so this
  // runs the state a real empty home has: the same four agents, no lead and no first-run flag on this device.
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
  await page.getByRole('checkbox', { name: /Research report/ }).check()
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
}

for (const [index, size] of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
].entries()) {
  test(`first run, starter recipes and the saved lead at ${size.name} (${size.width}×${size.height})`, async ({
    page,
  }) => {
    const home = mkdtempSync(join(tmpdir(), `score-first-run-${size.name}-`))
    const port = webPort + 40 + index
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
      const db = new DatabaseSync(join(home, 'score.db'))
      try {
        db.exec('PRAGMA busy_timeout = 5000')
        expect(
          db.prepare("UPDATE rooms SET lead_agent_id = NULL WHERE role = 'team'").run().changes,
        ).toBe(1)
      } finally {
        db.close()
      }

      await page.setViewportSize({ width: size.width, height: size.height })
      await firstRunFlow(page, origin, server.pairingToken)
    } finally {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
