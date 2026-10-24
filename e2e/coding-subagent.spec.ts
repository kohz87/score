import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// PLAN 8.7: a coding agent's sub-agent shows up nested under the Agent tool card in Chat. The fake CLI prints the
// recorded Claude Code turn with a sub-agent (apps/server/test/fixtures/coding/claude-subagent.jsonl).
const shots = process.env['SCORE_SUBAGENT_SHOTS']
const summaryLine = 'Sub-agent · List files in folder · 1 tool call · done'

async function post(page: Page, path: string, body: object): Promise<unknown> {
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

test.use({ viewport: { width: 1100, height: 1300 } })

test('Chat: a turn that used a sub-agent ends cleanly and nests the sub-agent’s calls', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `coder-${suffix}`
  await pair(page)
  const created = await post(page, 'coding-agents', {
    id,
    name: id,
    runtime: 'claude-code',
    style: { color: '#19C39A', shape: 'hexagon' },
    permission: 'workspace-write',
  })
  expect(created).toMatchObject({ id })
  await post(page, 'rooms', { name: `sub-${suffix}`, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: new RegExp(`sub-${suffix}`) })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} [fixture:subagent] list the files`)
  await composer.press('Enter')
  const reply = history.getByRole('article').filter({ hasText: summaryLine })
  await expect(reply).toBeVisible({ timeout: 30_000 })
  // Collapsed by default, with the sub-agent label; the sub-agent's Bash call is inside the card, not beside it.
  const card = reply.locator('details.chat-tool--subagent')
  await expect(card).toHaveJSProperty('open', false)
  await expect(reply.getByText('sub-agent', { exact: true })).toBeVisible()
  await expect(reply.locator('.chat-message-parts > details')).toHaveCount(1)
  await expect(reply).toContainText('The sub-agent found one file in the folder')
  await card.locator('summary').first().click()
  await expect(card).toHaveJSProperty('open', true)
  await expect(card.locator('.chat-subagent-calls')).toContainText('ls -la')
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await card.locator('.chat-subagent-calls details').first().locator('summary').click()
    await reply.screenshot({ path: `${shots}/chat.png` })
  }
  // Clean up so other specs see the usual team.
  await page.goto(`/team/${encodeURIComponent(id)}`)
  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})
