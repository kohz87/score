import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// 3.19.0: the Knowledge page against the fake adapter (it has knowledge notes).
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

for (const size of sizes) {
  test(`Knowledge from the navigation, open a note, search (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize(size)
    await pair(page)
    await page.goto('/b')
    const phone = size.width < 600
    const nav = page.getByRole('navigation', { name: 'Main' })
    await nav.getByRole('button', { name: 'Knowledge' }).click()
    await expect(page).toHaveURL(/\/b\/knowledge$/)
    await expect(page.getByRole('heading', { name: 'Knowledge', level: 1 })).toBeVisible()
    const folders = page.getByRole('complementary', { name: 'Folders' })
    await expect(folders.getByRole('button', { name: /^All notes/ })).toBeVisible()

    const list = page.getByRole('navigation', { name: 'Library notes' })
    const first = list.locator('.bold-knowledge-row').first()
    await expect(first).toBeVisible()
    await first.click()
    await expect(page).toHaveURL(/\/b\/knowledge\?note=/)
    await expect(page.getByRole('button', { name: 'Share to a chat' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    if (phone) {
      await page.getByRole('button', { name: /Back to the notes/ }).click()
      await expect(folders).toBeVisible()
    }

    // Opening a note rewrites ?note=, which clears the search box once; retype until the results show.
    await expect(async () => {
      await page.getByPlaceholder('Search').fill('a')
      await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible({
        timeout: 1500,
      })
    }).toPass({ timeout: 10_000 })

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)
  })
}

test('a Team address leads to Agents', async ({ page }) => {
  await pair(page)
  await page.goto('/b/team/builder')
  await expect(page).toHaveURL(/\/b\/agents\/builder$/)
})
