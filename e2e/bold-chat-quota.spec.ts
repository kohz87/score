import { expect, test } from '@playwright/test'
import { composerOf, makeDirectChat } from './bold-chat-helpers.ts'
import { removeCodingAgent } from './coding-helpers.ts'
import { withLock } from './locks.ts'
import { pair } from './pair.ts'

// Decision 186: a coding agent's plan quota in its direct chat, against the fake adapter and fake CLI. The fake Claude
// turn writes 94% left in the 5-hour window and 22% left in the week; no model or real CLI is started.
test('a coding agent’s direct chat shows its quota, Chat info and /status answer', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const id = `quota-chat-${Date.now().toString(36)}`
  await pair(page)
  await withLock('roster', async () => {
    try {
      const made = await page.request.post('/api/coding-agents', {
        headers: { 'x-score-client': 'web' },
        data: {
          id,
          name: id,
          runtime: 'claude-code',
          style: { color: '#19C39A', shape: 'hexagon' },
        },
      })
      expect(made.ok()).toBe(true)

      const chat = await makeDirectChat(page, id, 'Quota in chat', 'please add a greeting')
      await page.goto(`/b?with=${encodeURIComponent(id)}&chat=${chat.id}`)
      await expect(composerOf(page)).toBeEnabled({ timeout: 30_000 })

      // The turn's own rate-limit record arrives when its run ends and refreshes the reading.
      const pill = page.getByRole('button', { name: /Claude plan quota/ })
      await expect(pill).toContainText('94% left', { timeout: 30_000 })
      await expect(pill).toContainText('5 h')
      await expect(pill).toContainText('22%')
      await expect(pill).toContainText('week')

      await pill.click()
      const info = page.getByLabel(`${id}, chat info`)
      await expect(info.getByRole('button', { name: /Quota · Claude plan/ })).toBeVisible()
      await expect(info.getByRole('meter', { name: '5 hours left' })).toHaveAttribute(
        'aria-valuenow',
        '94',
      )
      await expect(info.getByRole('meter', { name: 'Week left' })).toHaveAttribute(
        'aria-valuenow',
        '22',
      )
      await expect(info).toContainText('Shared with every agent on the same Claude login.')

      const composer = composerOf(page)
      await composer.fill('/status')
      await expect(
        page.getByRole('option', { name: /Show tokens, context and plan quota/ }),
      ).toBeVisible()
      await composer.press('Enter')
      await composer.press('Enter')
      // The card is what the eye reads; its plain text twin is visually hidden for screen readers.
      const card = page.locator('.bold-usage-card')
      await expect(card).toBeVisible()
      await expect(card).toContainText('THIS SESSION')
      await expect(card).toContainText('CLAUDE PLAN QUOTA')
      await expect(card).toContainText('94% left')
      await expect(card).toContainText('22% left')
      await expect(card).toContainText(/read after the .* turn/)
      await expect(page.getByTestId('usage-fallback')).toContainText(/Read after the .* turn\./)
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
    } finally {
      await removeCodingAgent(page, id)
    }
  })
})
