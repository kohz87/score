import { expect, test } from '@playwright/test'
import { openBoldRoom, showAllJobsOnPhone } from './bold-room-fixtures.ts'
import { exchange, roomJobs, sizes } from './bold-needs-you-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`a paused exchange is answered in place at ${label}`, async ({ page }) => {
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [],
        exchanges: [exchange('exchange-needs')],
      })
      await showAllJobsOnPhone(page)
      const card = page.getByRole('article', { name: /The exchange used its turns/ })
      await expect(card).toHaveAttribute('data-protected', 'flex')
      await expect(card).toContainText('Release notes 2.4')
      await card.getByRole('button', { name: 'Give 4 more turns' }).click()
      await expect(card.getByLabel('More turns (1–20)')).toHaveValue('4')
      await card.getByRole('button', { name: 'Give 4 more turns' }).click()

      await expect(card).toHaveCount(0)
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' && request.path === '/api/exchanges/exchange-needs/decision',
        )?.body,
      ).toEqual({ option: 'more_turns', turns: 4 })
    })
  })
}
