import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, openRoom } from './rooms.ts'

// PLAN 5.25: Markdown replies with a code block, tool and thinking cards, and Stop.
test('a Markdown reply renders with a copyable code block, tool cards and a thinking card', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await pair(page)
  const room = await makeRoom(page, 'fmt')
  await openRoom(page, room.label)
  const history = page.getByRole('region', { name: 'Message history' })
  await page.getByRole('combobox', { name: /^Message/ }).fill('markdown demo please')
  await page.getByRole('combobox', { name: /^Message/ }).press('Enter')
  const reply = history
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Plan' }) })
    .last()
  await expect(reply.getByRole('heading', { name: 'Plan' })).toBeVisible({ timeout: 40_000 })
  await expect(reply.locator('strong', { hasText: 'the change' })).toBeVisible()
  await expect(reply.getByRole('listitem')).toHaveCount(2)
  const block = reply.locator('.chat-code')
  await expect(block.locator('.chat-code-head')).toContainText('ts')
  await expect(block.locator('.tok-keyword')).toHaveText('const')
  await block.getByRole('button', { name: 'Copy ts code' }).click()
  await expect(block.getByRole('button', { name: 'Copy ts code' })).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const pageSize = 25')

  // The tool call and the reasoning are collapsed cards on the finished reply.
  const tool = reply.locator('details.chat-tool')
  await expect(tool).toHaveCount(1)
  await expect(tool).not.toHaveAttribute('open', '')
  await tool.locator('summary').click()
  await expect(tool.getByLabel('Result')).toHaveText('3 checks passed')
  const thinking = reply.locator('details.chat-thinking')
  await expect(thinking.locator('summary')).toHaveText('Thought process')
  await expect(thinking).not.toHaveAttribute('open', '')
})

test('Stop ends a long reply early and the reply says it was stopped', async ({ page }) => {
  test.setTimeout(120_000)
  await pair(page)
  const room = await makeRoom(page, 'fmt')
  await openRoom(page, room.label)
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill('give me a long reply')
  await composer.press('Enter')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)
  await stop.click()
  await expect(history.getByText('This run was stopped.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})
