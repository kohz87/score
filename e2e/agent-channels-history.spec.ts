import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('Channels shows the connect form and Recent runs lists runs with a Watch replay', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/b/team/builder#agent-channels')
  const channels = page.locator('#agent-channels')
  await expect(channels.getByRole('heading', { name: 'Channels', level: 3 })).toBeVisible()
  await expect(channels.getByText('Connected', { exact: true }).first()).toBeVisible()
  await channels.getByRole('button', { name: 'Connect Discord', exact: true }).click()
  // Token-based platforms are set up in the browser (fake mode writes nothing).
  const form = channels.getByRole('form', { name: 'Connect Discord' })
  await form.getByLabel('Bot token', { exact: true }).fill('fake-discord-token')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(channels.getByText(/Saved\. The gateway picks up/)).toBeVisible()

  const history = page.locator('#agent-history')
  await expect(history.getByRole('heading', { name: 'Recent runs', level: 3 })).toBeVisible()
  // The card lists the newest few runs; other specs share this server and start builder runs of their own, so the
  // scenario's run can sit below the fold: open the whole list (whenever the button is there) until it shows.
  // The fake scenario starts the builder's first run within a few seconds of startup.
  const pagination = history.getByText('Add pagination to the activity feed').first()
  await expect(async () => {
    const allRuns = history.getByRole('button', { name: 'All runs' })
    if (await allRuns.isVisible()) await allRuns.click()
    await expect(pagination).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 30_000 })

  // Replay needs recorded frames, which the scripted scenario only produces late: stub one finished run.
  await page.route('**/api/agents/builder/history*', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            runId: 'run-1',
            title: 'Fix the pager',
            origin: 'kanban',
            outcome: 'completed',
            startedAt: '2026-01-01T12:00:00.000Z',
            durationSec: 95,
            model: 'fake-model',
            costUsd: 0.12,
            task: { id: 't-1', title: 'Fix the pager' },
            brief: null,
            replaySeq: 3,
          },
        ],
        nextCursor: null,
      },
    }),
  )
  await page.reload()
  const stubbed = page.locator('#agent-history')
  await expect(stubbed.getByText('Fix the pager')).toBeVisible()
  await expect(stubbed.getByText('Completed', { exact: false }).first()).toBeVisible()
  await stubbed.getByRole('link', { name: 'Replay Fix the pager' }).click()
  await expect(page).toHaveURL(/\/b\/screen\/builder\?from=3/)
})
