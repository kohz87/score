import { expect, test } from '@playwright/test'
import { openBoldJob } from './bold-room-fixtures.ts'
import { budgetPause, openThread, openTopicInfo, sizes } from './bold-thread-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const size = `${viewport.width}×${viewport.height}`
  test.describe(size, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a paused exchange is answered from its needs-you card at ${size}`, async ({ page }) => {
      const state = await openThread(page)
      const topic = await openTopicInfo(page, /Release notes 2\.4/)
      // The pause is also named in Info: the protected Needs you pill.
      await expect(topic.locator('.bold-topic-status [data-protected]')).toBeVisible()
      if (viewport.width <= 860)
        await page.getByRole('button', { name: 'Close side panel' }).click()

      const card = page.getByRole('article', { name: /The review ended without a verdict/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await card.scrollIntoViewIfNeeded()
      await expect(card).toContainText('8 of 8')
      await card.getByRole('button', { name: /Send back/ }).click()
      await card.getByLabel('Note for the author').fill('Tighten the migration steps.')
      await card
        .getByRole('button', { name: /Send back/ })
        .last()
        .click()
      await expect(card).toContainText('Sent back with your note.')
      expect(
        state.posts.some(
          (item) =>
            item.path === '/api/exchanges/exchange-notes/decision' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ option: 'send_back', note: 'Tighten the migration steps.' }),
        ),
      ).toBe(true)
    })

    test(`the card's Step in answers a budget pause with step_in at ${size}`, async ({ page }) => {
      const state = await openThread(page, { exchange: budgetPause(8, 'exchange_budget') })
      const topic = await openTopicInfo(page, /Release notes 2\.4/)
      await expect(topic.locator('.bold-topic-status')).toContainText('8 of 8 turns used')
      if (viewport.width <= 860)
        await page.getByRole('button', { name: 'Close side panel' }).click()
      const card = page.getByRole('article', { name: /The exchange used its turns/ })
      await card.scrollIntoViewIfNeeded()
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await card.getByLabel('What should happen next?').fill('Go on with the short version.')
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await expect(card.getByRole('status')).toContainText('Decision sent.')
      expect(
        state.posts.some(
          (item) =>
            item.path === '/api/exchanges/exchange-notes/decision' &&
            JSON.stringify(item.body) ===
              JSON.stringify({ option: 'step_in', text: 'Go on with the short version.' }),
        ),
      ).toBe(true)
    })

    test(`a 403 on the card's Step in asks to pair this browser at ${size}`, async ({ page }) => {
      await openThread(page, { exchange: budgetPause(8, 'exchange_budget') })
      await page.route('**/api/exchanges/exchange-notes/decision', async (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'forbidden', message: 'no' } }),
        }),
      )
      await openBoldJob(page, /Release notes 2\.4/)
      const card = page.getByRole('article', { name: /The exchange used its turns/ })
      await card.scrollIntoViewIfNeeded()
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await card.getByLabel('What should happen next?').fill('Hello')
      await card.getByRole('button', { name: 'Step in', exact: true }).click()
      await expect(
        page.getByRole('alert').filter({ hasText: 'Pair this browser first.' }),
      ).toBeVisible()
    })
  })
}
