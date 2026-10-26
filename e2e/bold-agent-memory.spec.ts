import { expect, test } from '@playwright/test'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// 3.1.0 (decision 133): the Remembers card searches as you type and asks before it forgets a note.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

for (const viewport of sizes) {
  test(`Remembers search and forget confirm at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await pair(page)
    let items = [
      { id: 'm1', text: 'Prefers small commits', source: 'you', at: '2026-10-24T10:00:00.000Z' },
      { id: 'm2', text: 'Deploys on Fridays', source: 'you', at: '2026-10-24T10:00:00.000Z' },
    ]
    const deleted: string[] = []
    await page.route('**/api/agents/builder/memory**', async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') return route.fallback()
      const q = new URL(request.url()).searchParams.get('q')?.toLowerCase() ?? ''
      await route.fulfill({
        json: { items: items.filter((i) => i.text.toLowerCase().includes(q)), nextCursor: null },
      })
    })
    await page.route('**/api/agents/builder/memory/*', async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback()
      const id = route.request().url().split('/').pop()!
      deleted.push(id)
      items = items.filter((i) => i.id !== id)
      await route.fulfill({ status: 204, body: '' })
    })
    await page.goto('/b/team/builder')
    await page
      .getByRole('button', {
        name: 'More: memory, skills, tools, workspace, repeating jobs, delete',
      })
      .click()
    const card = page.locator('#agent-memory')
    await expect(card.locator('.listrow')).toHaveCount(2)
    await card.getByRole('searchbox', { name: 'Search memory' }).fill('FRIDAY')
    await expect(card.locator('.listrow')).toHaveCount(1)
    await expect(card.locator('mark')).toHaveText('Friday')
    await card.getByRole('searchbox', { name: 'Search memory' }).fill('nothing here')
    await expect(card.getByText('No memories match “nothing here”.')).toBeVisible()
    await card.getByRole('searchbox', { name: 'Search memory' }).fill('')
    await expect(card.locator('.listrow')).toHaveCount(2)

    await card.getByRole('button', { name: 'Forget: Deploys on Fridays' }).click()
    const confirm = card.getByRole('group', { name: 'Remove memory' })
    await expect(confirm).toHaveAttribute('data-protected', 'block')
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    expect(deleted).toEqual([])
    await card.getByRole('button', { name: 'Forget: Deploys on Fridays' }).click()
    await card
      .getByRole('group', { name: 'Remove memory' })
      .getByRole('button', { name: 'Remove' })
      .click()
    await expect(card.getByText('Deploys on Fridays')).toHaveCount(0)
    expect(deleted).toEqual(['m2'])
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
}
