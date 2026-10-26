import { expect, test } from '@playwright/test'
import { openBoldRoomById } from './bold-chat-helpers.ts'
import { pair } from './pair.ts'
import { makeRoom } from './rooms.ts'

// 3.2.0: rename, pin, archive, project and JSON export for rooms other than the team room, the runs outcome filter and
// cost, and the deleted-messages toggle on the starter board. Fake adapter; no model is called.
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

for (const viewport of sizes) {
  const at = `${viewport.width}×${viewport.height}`
  const phone = viewport.width <= 860

  test(`a room can be renamed, pinned, given a project and archived at ${at}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const made = await makeRoom(page, 'tools')
    await openBoldRoomById(page, made.id)

    await page.getByRole('button', { name: 'Room menu' }).click()
    await expect(page.getByRole('menuitem', { name: 'Export as JSON' })).toHaveAttribute(
      'href',
      `/api/rooms/${made.id}/export.json`,
    )
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename room' })
    await expect(dialog).toHaveAttribute('data-protected', 'any')
    await dialog.getByRole('textbox').fill('Not A Slug')
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog.getByRole('alert')).toContainText('lowercase')
    const renamed = `${made.label.slice(1)}-b`
    await dialog.getByRole('textbox').fill(renamed)
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => {
        const list = (await (await page.request.get('/api/rooms')).json()) as {
          rooms: { id: string; name: string }[]
        }
        return list.rooms.find((room) => room.id === made.id)?.name
      })
      .toBe(`#${renamed}`)

    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    await page.getByRole('button', { name: 'Room menu' }).click()
    await expect(page.getByRole('menuitem', { name: 'Unpin' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Project…' }).click()
    const project = page.getByRole('dialog', { name: /^Project for/ })
    await project.getByPlaceholder('Project name').fill(`Launch ${Date.now().toString(36)}`)
    await project.getByRole('button', { name: 'Save' }).click()
    await expect(project).toHaveCount(0)

    // Archive: the room leaves the switcher until "Show archived" is on.
    await page.getByRole('button', { name: 'Room menu' }).click()
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click()
    await page.goto('/b')
    await page.locator('.roomtitle').click()
    const picker = page.getByRole('listbox', { name: 'Rooms and chats elsewhere' })
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('option', { name: new RegExp(`#${renamed}`) })).toHaveCount(0)
    await picker.getByRole('option', { name: /Show archived/ }).click()
    await expect(picker.getByRole('option', { name: new RegExp(`#${renamed}`) })).toBeVisible()
  })

  test(`an emptied room offers its deleted messages at ${at}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const made = await makeRoom(page, 'emptied')
    await openBoldRoomById(page, made.id)
    if (phone) {
      // An older room opens straight into its chat on a phone, which already carries the toggle.
      await expect(page.getByRole('button', { name: 'Show deleted messages' })).toBeVisible()
      return
    }
    await page.getByRole('button', { name: 'Show what was deleted' }).click()
    await expect(page.getByRole('button', { name: 'Hide deleted messages' })).toBeVisible()
  })

  test(`Recent runs filters by outcome and shows each run's cost at ${at}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    const run = (id: string, title: string, outcome: string, costUsd: number | null) => ({
      runId: id,
      title,
      origin: 'kanban',
      outcome,
      startedAt: '2026-01-01T12:00:00.000Z',
      durationSec: 95,
      model: 'fake-model',
      costUsd,
      task: null,
      brief: null,
      replaySeq: null,
    })
    await page.route('**/api/agents/builder/history*', (route) => {
      const failed = new URL(route.request().url()).searchParams.get('outcome') === 'failed'
      const items = [
        run('r1', 'Fix the pager', 'completed', 0.12),
        run('r2', 'Break the build', 'failed', null),
      ]
      return route.fulfill({
        json: {
          items: failed ? items.filter((item) => item.outcome === 'failed') : items,
          nextCursor: null,
        },
      })
    })
    await page.goto('/b/team/builder#agent-history')
    const history = page.locator('#agent-history')
    await expect(history.getByText('Fix the pager')).toBeVisible()
    await expect(history).toContainText('$0.12')
    await expect(history).toContainText('cost unknown')
    const filter = history.getByRole('group', { name: 'Filter runs by outcome' })
    await filter.getByRole('button', { name: 'Failed' }).click()
    await expect(history.getByText('Fix the pager')).toHaveCount(0)
    await expect(history.getByText('Break the build')).toBeVisible()
    await filter.getByRole('button', { name: 'All' }).click()
    await expect(history.getByText('Fix the pager')).toBeVisible()
  })
}
