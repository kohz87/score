import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { flowFixture } from './flow-fixture.ts'
import { fixtureNow } from './now-fixture.ts'
import { pair } from './pair.ts'

// PLAN 8.7: a coding agent's sub-agent shows up nested under the Agent tool card, in Chat and in Flow's step log. The
// fake CLI prints the recorded Claude Code turn with a sub-agent (apps/server/test/fixtures/coding/claude-subagent.jsonl).
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

test.describe('Flow', () => {
  test.use({ viewport: { width: 1440, height: 1100 }, timezoneId: 'UTC', locale: 'en-GB' })

  test('the step log nests a sub-agent’s calls under its Agent line', async ({ page }) => {
    await pair(page)
    const fixture = flowFixture('room-fixture')
    const agentId = fixture.log.items[0]!.agentId
    const at = '2026-10-08T21:31:00.000Z'
    fixture.log.items.push(
      {
        id: 'sub-1',
        at,
        agentId,
        kind: 'tool',
        text: 'Used Agent',
        callId: 'toolu_01',
        subagent: {
          status: 'done',
          description: 'List files in folder',
          subagentType: 'general-purpose',
          toolCalls: 1,
          durationMs: 7550,
          totalTokens: 19455,
        },
      },
      {
        id: 'sub-2',
        at,
        agentId,
        kind: 'tool',
        text: 'Used Bash',
        callId: 'toolu_02',
        parentCallId: 'toolu_01',
      },
    )
    await page.clock.setFixedTime(new Date(fixtureNow))
    await page.route('**/api/stream*', (route) =>
      route.fulfill({ contentType: 'text/event-stream', body: '' }),
    )
    await page.route('**/api/now', (route) => route.fulfill({ json: fixture.score }))
    await page.route('**/api/agents', (route) =>
      route.fulfill({ json: { asOfSeq: 1, items: fixture.agents } }),
    )
    await page.route('**/api/briefs?*', (route) =>
      route.fulfill({
        json: { items: route.request().url().endsWith('active') ? [fixture.flow.brief] : [] },
      }),
    )
    await page.route('**/api/briefs/fixture-flow/flow', (route) =>
      route.fulfill({ json: fixture.flow }),
    )
    await page.route('**/api/flow/nodes/*', (route) => route.fulfill({ json: fixture.detail }))
    await page.route('**/api/approvals?*', (route) =>
      route.fulfill({ json: { asOfSeq: 1, items: [fixture.detail.approval], nextCursor: null } }),
    )
    await page.route('**/api/briefs/fixture-flow/log?*', (route) =>
      route.fulfill({ json: { items: fixture.log.items, nextCursor: null } }),
    )
    await page.goto('/now/flow/fixture-flow')
    const log = page.getByRole('region', { name: 'Live log' })
    const line = log.getByText(summaryLine)
    await expect(line).toBeVisible()
    const details = log.locator('details.flow-log__sub')
    await expect(details).toHaveJSProperty('open', false)
    await expect(log.getByText('Used Bash')).toBeHidden()
    await line.click()
    await expect(log.getByText('Used Bash')).toBeVisible()
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await log.screenshot({ path: `${shots}/flow.png` })
    }
  })
})
