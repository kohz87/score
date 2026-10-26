import { mkdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { acquireLock } from './locks.ts'
import { api, from, openRoom, removeCodingAgent, say } from './coding-helpers.ts'
import { pair } from './pair.ts'

// PLAN 8.7: a coding agent's sub-agent shows up nested under the Agent tool card in Chat. The fake CLI prints the
// recorded Claude Code turn with a sub-agent (apps/server/test/fixtures/coding/claude-subagent.jsonl).
const shots = process.env['SCORE_SUBAGENT_SHOTS']
const summaryLine = 'Sub-agent · List files in folder · 1 tool call · done'

test.use({ viewport: { width: 1100, height: 1300 } })

test('Chat: a turn that used a sub-agent ends cleanly and nests the sub-agent’s calls', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `coder-${suffix}`
  await pair(page)
  // The agent is on the team for a moment and bold-team.spec.ts counts the team (locks.ts).
  const release = await acquireLock('roster')
  try {
    const created = await api(page, 'coding-agents', {
      id,
      name: id,
      runtime: 'claude-code',
      style: { color: '#19C39A', shape: 'hexagon' },
      permission: 'workspace-write',
    })
    expect(created).toMatchObject({ id })
    const room = await openRoom(page, 'sub')
    await say(room, `@${id} [fixture:subagent] list the files`)
    const reply = from(room, id).filter({ hasText: summaryLine })
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
  } finally {
    // Clean up so other specs see the usual team.
    try {
      await removeCodingAgent(page, id)
    } finally {
      release()
    }
  }
})
