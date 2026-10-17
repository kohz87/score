import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 8.8: a coding agent's role and "Personality and instructions", against the fake adapter and the fake CLI, which
// echoes the instructions it was given. No model is called and no real CLI is started.
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

// Where the screenshots for the owner go, when asked for (SCORE_UI_SHOTS=<folder>).
const shotsFolder = process.env['SCORE_UI_SHOTS']
if (shotsFolder) mkdirSync(shotsFolder, { recursive: true })

test('edit a coding agent’s personality, then the fake CLI reports that it received it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `persona-agent-${suffix}`
  const roomName = `persona-${suffix}`
  await pair(page)
  await page.goto('/team')
  await api(page, 'coding-agents', {
    id,
    name: id,
    role: 'Reviews build scripts',
    runtime: 'claude-code',
    style: { color: '#6B4EFF', shape: 'hexagon' },
  })

  await page.goto(`/team/${encodeURIComponent(id)}`)
  const card = page.getByRole('region', { name: 'Personality' })
  await expect(card).toContainText('Reviews build scripts')
  await expect(card).toContainText('No instructions yet')

  await card.getByRole('button', { name: 'Edit personality' }).click()
  await card
    .getByLabel('Personality and instructions')
    .fill('## Style\n\nAnswer in **rhyme**. Never touch the lockfile.')
  await card.getByLabel('Role').fill('Lead builder')
  if (shotsFolder) await card.screenshot({ path: `${shotsFolder}/edit.png` })
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByRole('heading', { name: 'Style' })).toBeVisible()
  await expect(card.locator('strong')).toHaveText('rhyme')
  await expect(card).toContainText('Lead builder')
  if (shotsFolder) await card.screenshot({ path: `${shotsFolder}/personality.png` })

  // The Team list shows the role under the name.
  await page.goto('/team')
  await expect(page.getByText('Lead builder').first()).toBeVisible()

  // A turn: the fake CLI echoes the block it was handed.
  await api(page, 'rooms', { name: roomName, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: new RegExp(roomName) })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} [fixture:echo] who are you`)
  await composer.press('Enter')
  const reply = history.getByRole('article').filter({ hasText: 'Received instructions:' })
  await expect(reply).toBeVisible({ timeout: 30_000 })
  await expect(reply).toContainText('Your role: Lead builder')
  await expect(reply).toContainText('Never touch the lockfile.')

  // Leave the shared fake team as it was: the other specs count agents and Reports rows.
  page.once('dialog', (dialog) => void dialog.accept())
  await page.goto(`/team/${encodeURIComponent(id)}`)
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})
