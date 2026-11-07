import { expect, test } from '@playwright/test'
import { openBoldRoom } from './bold-room-fixtures.ts'
import { approval, at, exchange, roomJobs, sizes } from './bold-needs-you-helpers.ts'

test.use({ reducedMotion: 'reduce' })

for (const viewport of sizes) {
  const label = `${viewport.width}×${viewport.height}`

  test.describe(label, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport)
    })

    test(`the conversation shows every card at once, with no strip or fold, at ${label}`, async ({
      page,
    }) => {
      // 3.22.0 (brief item 8): the strip no longer folds to one card behind an "N more need you" button.
      await openBoldRoom(page, {
        jobs: roomJobs(),
        approvals: [
          approval('approval-package', 'May I install a package?'),
          approval('approval-deploy', 'May I deploy?'),
        ],
        exchanges: [],
      })
      const first = page.getByRole('article', { name: /May I install a package/ })
      const second = page.getByRole('article', { name: /May I deploy/ })
      await expect(first).toBeVisible()
      await expect(second).toBeVisible()
      // 3.24.0: the cards sit in the conversation; the pinned strip and its fold are gone.
      await expect(page.locator('.bold-pins')).toHaveCount(0)
      await expect(page.getByRole('button', { name: /more needs? you|Show fewer/ })).toHaveCount(0)
    })

    test(`cards sit in the conversation after their message, and the jump chip takes the person to them at ${label}`, async ({
      page,
    }) => {
      // 3.24.0: a long conversation of newer messages pushes both cards out of view; the chip counts them.
      const author = { kind: 'agent', agentId: 'builder' }
      const filler = Array.from({ length: 40 }, (_, index) => ({
        id: `message-filler-${index}`,
        roomId: 'team-room',
        jobId: 'job-default',
        author,
        to: [],
        parts: [
          {
            kind: 'text',
            text: `Filler update ${index}. ${'More words to take room. '.repeat(6)}`,
          },
        ],
        createdAt: `2026-10-24T10:30:${String(index).padStart(2, '0')}.000Z`,
        streaming: false,
        refs: [],
      }))
      const asking = {
        id: 'message-approval',
        roomId: 'team-room',
        jobId: 'job-activity',
        author,
        to: [],
        parts: [{ kind: 'approval', approvalId: 'approval-package' }],
        createdAt: at(7),
        streaming: false,
        refs: [],
      }
      const state = await openBoldRoom(page, {
        jobs: roomJobs(),
        exchanges: [exchange('exchange-needs')],
        handle: (request) => {
          if (
            request.method === 'GET' &&
            request.path === '/api/rooms/team-room/messages' &&
            request.search.get('all') === '1'
          )
            return {
              body: {
                asOfSeq: 12,
                items: [...filler].reverse().concat([asking]),
                nextCursor: null,
                jobId: null,
              },
            }
          return undefined
        },
      })
      const approvalCard = page.getByRole('article', { name: /May I install a package/ })
      const reviewCard = page.getByRole('article', { name: /The exchange used its turns/ })
      const stream = page.locator('#bold-room-stream')
      // The cards are inside the conversation; no strip is pinned above it.
      await expect(stream.locator(approvalCard)).toHaveCount(1)
      await expect(stream.locator(reviewCard)).toHaveCount(1)
      await expect(page.locator('.bold-pins')).toHaveCount(0)
      await expect(approvalCard).toHaveAttribute('data-protected', 'flex')

      // The conversation opens at its end; both cards are earlier, so the chip says so.
      const chip = page.locator('.bold-needs-jump')
      await expect(chip).toBeVisible()
      await expect(chip).toHaveText('2 need you ↑')
      await expect(chip).toHaveAttribute('data-protected', 'inline-flex')
      await expect(chip).toHaveAccessibleName(/2 cards need you, above/)
      await expect(approvalCard).not.toBeInViewport()

      // The chip takes the person to the nearest card (the approval, lower in the conversation) and moves focus there.
      await chip.click()
      await expect(approvalCard).toBeFocused()
      await expect(approvalCard).toBeInViewport()
      // 3.30.0: the job bar takes height, so whether the other card still shows depends on the view, not the width.
      const reviewShown = await reviewCard.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const view = document.querySelector('#bold-room-stream')!.getBoundingClientRect()
        return box.bottom > view.top && box.top < view.bottom
      })
      if (!reviewShown) {
        // The one left is still earlier: the chip now counts it alone and goes to it.
        await expect(chip).toHaveText('1 needs you ↑')
        await chip.click()
        await expect(reviewCard).toBeFocused()
      } else {
        // The view already shows both cards, so nothing is out of view and the chip leaves.
        await expect(reviewCard).toBeInViewport()
        await expect(chip).toHaveCount(0)
      }

      // Answering the approval in place still sends the decision.
      await approvalCard.scrollIntoViewIfNeeded()
      await approvalCard.getByRole('button', { name: 'Allow', exact: true }).click()
      await expect(approvalCard.getByRole('status')).toContainText('Approved')
      expect(
        state.requests.find(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/approvals/approval-package/decision',
        )?.body,
      ).toEqual({ choice: 'once' })
    })
  })
}
