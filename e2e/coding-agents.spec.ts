import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Coding agents (PLAN 7.2) against the fake adapter and a fake CLI script that prints hand-made fixtures: no model is
// called and no real CLI is started.
async function api(page: Page, path: string, body: object): Promise<unknown> {
  return page.evaluate(
    async ([url, payload]) => {
      const response = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
        body: JSON.stringify(payload),
      })
      return response.json()
    },
    [`/api/${path}`, body],
  )
}

test('add a coding agent, give it work in a room, stop one turn, see it in Reports and Watch', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `coder-${suffix}`
  const roomName = `coding-${suffix}`
  await pair(page)

  // Team › Add agent › Coding agent
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Coding agent/ }).check()
  await expect(dialog.getByLabel('Coding CLI')).toHaveValue('claude-code')
  await expect(dialog).toContainText('Uses your Claude plan quota')
  await expect(dialog.getByRole('note')).toContainText('not what it can read')
  await dialog.getByLabel(/Agent name/).fill(id)
  await dialog.getByRole('radio', { name: /Full access/ }).check()
  await expect(dialog.getByText(/turns the CLI’s own sandbox off/)).toBeVisible()
  await dialog.getByRole('radio', { name: /Workspace write/ }).check()
  await dialog.screenshot({ path: testInfo.outputPath('coding-add.png') })
  await dialog.getByRole('button', { name: 'Add coding agent' }).click()
  await expect(dialog.getByText(`${id} joined the team.`)).toBeVisible()
  await dialog.getByRole('link', { name: 'View agent' }).click()
  const card = page.getByRole('region', { name: 'Coding agent' })
  await expect(card).toContainText('Claude Code 2.1.295 · Ready')
  await expect(page.getByRole('tab', { name: 'Skills' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('coding-overview.png') })

  // A room, an @mention, a streamed reply with tool cards.
  await api(page, 'rooms', { name: roomName, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: new RegExp(roomName) })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} please add a greeting`)
  await composer.press('Enter')
  const reply = history
    .getByRole('article')
    .filter({ hasText: 'Created hello.txt and changed it.' })
  await expect(reply).toBeVisible({ timeout: 30_000 })
  await expect(reply).toContainText('ls -la')
  await page.screenshot({ path: testInfo.outputPath('coding-room.png') })

  // Stop a long turn.
  await composer.fill(`@${id} [fixture:slow] take your time`)
  await composer.press('Enter')
  const slow = history.getByRole('article').filter({ hasText: 'Working on' })
  const stop = slow.getByRole('button', { name: /^Stop reply from/ })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await stop.click()
  await expect(
    history.getByRole('article').filter({ hasText: 'This run was stopped.' }),
  ).toBeVisible({
    timeout: 30_000,
  })

  // Reports: Claude Code's figure is an estimate.
  await page.goto('/reports')
  const row = page.getByRole('row', { name: new RegExp(`^${id} `) })
  await expect(row).toContainText('estimated', { timeout: 15_000 })

  // Watch: frames came from the parsed events.
  await page.goto(`/now/watch/${encodeURIComponent(id)}`)
  await expect(page.getByText(/Ran ls -la/).first()).toBeVisible({ timeout: 15_000 })

  // Clean up so other specs see the usual team.
  await page.goto(`/team/${encodeURIComponent(id)}`)
  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})
