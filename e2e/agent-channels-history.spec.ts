import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

test('Channels shows the connect command and History lists runs with a Watch replay', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/team/builder')
  await page.getByRole('tab', { name: 'Channels' }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('heading', { name: 'Channels', level: 2 })).toBeVisible()
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Connect Discord' }).click()
  // Token-based platforms are set up in the browser (fake mode writes nothing).
  const form = panel.getByRole('form', { name: 'Connect Discord' })
  await form.getByLabel('Bot token', { exact: true }).fill('fake-discord-token')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(panel.getByText(/Saved\. The gateway picks up/)).toBeVisible()

  await page.getByRole('tab', { name: 'History' }).click()
  await expect(panel.getByRole('heading', { name: 'History', level: 2 })).toBeVisible()
  // The fake scenario starts the builder's first run within a few seconds of startup.
  await expect(panel.getByText('Add pagination to the activity feed').first()).toBeVisible({
    timeout: 30_000,
  })
  await panel.getByRole('combobox', { name: 'Outcome' }).selectOption('failed')
  await expect(panel.getByText('No runs match.')).toBeVisible()

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
  await panel.getByRole('combobox', { name: 'Outcome' }).selectOption('completed')
  await expect(panel.getByText('$0.12', { exact: false })).toBeVisible()
  await panel.getByRole('link', { name: 'Replay Fix the pager in Watch' }).click()
  await expect(page).toHaveURL(/\/watch\/builder\?from=3/)
})
