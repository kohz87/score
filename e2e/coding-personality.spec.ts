import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { api, from, openRoom, removeCodingAgent, say } from './coding-helpers.ts'
import { pair } from './pair.ts'

// PLAN 8.8: a coding agent's role and "Personality and instructions", against the fake adapter and the fake CLI, which
// echoes the instructions it was given. No model is called and no real CLI is started.

// Where the screenshots for the owner go, when asked for (SCORE_UI_SHOTS=<folder>).
const shotsFolder = process.env['SCORE_UI_SHOTS']
if (shotsFolder) mkdirSync(shotsFolder, { recursive: true })

test('edit a coding agent’s personality, then the fake CLI reports that it received it', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `persona-agent-${suffix}`
  await pair(page)
  // The agent is on the team for a moment and bold-team.spec.ts counts the team (locks.ts).
  const release = await acquireLock('roster')
  try {
    await api(page, 'coding-agents', {
      id,
      name: id,
      role: 'Reviews build scripts',
      runtime: 'claude-code',
      style: { color: '#6B4EFF', shape: 'hexagon' },
    })

    await page.goto(`/b/team/${encodeURIComponent(id)}`)
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
    await page.goto('/b/team')
    await expect(page.getByText('Lead builder').first()).toBeVisible()

    // A turn: the fake CLI echoes the block it was handed.
    const room = await openRoom(page, 'persona')
    await say(room, `@${id} [fixture:echo] who are you`)
    const reply = from(room, id).filter({ hasText: 'Received instructions:' })
    await expect(reply).toBeVisible({ timeout: 30_000 })
    await expect(reply).toContainText('Your role: Lead builder')
    await expect(reply).toContainText('Never touch the lockfile.')
  } finally {
    // Leave the shared fake team as it was: the other specs count agents and Reports rows.
    try {
      await removeCodingAgent(page, id)
    } finally {
      release()
    }
  }
})
