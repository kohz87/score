import { expect, test, type Page } from '@playwright/test'
import { openBoldRoom } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'

// PLAN 2.1.2: a one-line composer placeholder, folders in the Library notes list, finished jobs folded in the room.
const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

for (const size of sizes) {
  test.describe(size.name, () => {
    test.use({ reducedMotion: 'reduce', viewport: { width: size.width, height: size.height } })

    test('the team composer placeholder fits one line and the hint shows on focus', async ({
      page,
    }) => {
      await openBoldRoom(page)
      const box = page.getByRole('combobox', { name: /^Message Team room/ })
      await expect(box).toBeVisible()
      const fits = await box.evaluate((el) => el.scrollHeight <= el.clientHeight)
      expect(fits).toBe(true)
      await box.focus()
      await expect(page.locator('.chat-composer-hint')).toBeVisible()
    })

    test('a finished job is folded; Show opens it and Hide folds it again', async ({ page }) => {
      await openBoldRoom(page)
      const show = page.getByRole('button', { name: 'Show Queue research' })
      if (size.width <= 860) {
        // The phone reads one job at a time: no fold in a job's own thread.
        await expect(page.locator('.bold-job-fold')).toHaveCount(0)
        return
      }
      await expect(show).toBeVisible()
      await expect(page.locator('.bold-job-fold', { hasText: 'Queue research' })).toContainText(
        'message',
      )
      await show.click()
      await expect(page.getByRole('link', { name: 'Open result: Queue research' })).toBeVisible()
      await page.getByRole('button', { name: 'Hide' }).click()
      await expect(show).toBeVisible()
    })
  })
}

async function openLibrary(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  if (width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()
  await page.locator('button.side-toggle').click()
  await page.getByRole('button', { name: /^Library/ }).click()
  await expect(page.getByTestId('bold-library')).toBeVisible()
}

for (const size of sizes) {
  test(`New folder in the Library notes, then a note into it (${size.name})`, async ({ page }) => {
    await pair(page)
    await openLibrary(page, size.width, size.height)
    const folder = `fold${Date.now().toString(36)}`
    const nav = page.getByRole('navigation', { name: 'Library notes' })
    await nav.getByRole('button', { name: 'New folder' }).click()
    const dialog = page.getByRole('dialog', { name: 'New folder' })
    await dialog.getByLabel('Folder path').fill(folder)
    await dialog.getByRole('button', { name: /^Create/ }).click()
    const heading = nav.getByRole('button', { name: new RegExp(folder) })
    await expect(heading).toBeVisible()
    await nav.getByRole('button', { name: 'New note' }).click()
    const note = page.getByRole('dialog', { name: 'New note' })
    await expect(note.getByLabel('Path in Knowledge')).toHaveValue(`${folder}/`)
    await note.getByLabel('Path in Knowledge').fill(`${folder}/first`)
    await note.getByRole('button', { name: 'Create note' }).click()
    await expect(page.getByLabel(`Contents of ${folder}/first.md`)).toBeVisible({ timeout: 15_000 })
    await heading.click()
    await expect(heading).toHaveAttribute('aria-expanded', 'false')
  })
}
