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

    test('the team composer placeholder fits one line and names @ and / commands', async ({
      page,
    }) => {
      await openBoldRoom(page)
      const box = page.getByRole('combobox', { name: /^Message Team room/ })
      await expect(box).toBeVisible()
      const fits = await box.evaluate((el) => el.scrollHeight <= el.clientHeight)
      expect(fits).toBe(true)
      // 3.22.0: the context bar replaces the focus hint (it is not rendered with a footer); the placeholder says it.
      await expect(box).toHaveAttribute('placeholder', /@ someone · \/ for commands/)
    })

    test('long text is fully visible or scrollable in the composer', async ({ page }) => {
      await openBoldRoom(page)
      const box = page.getByRole('combobox', { name: /^Message Team room/ })
      await box.fill('word '.repeat(80))
      const one = await box.evaluate((el) => ({
        grew: el.clientHeight > 40,
        reachable: el.scrollHeight <= el.clientHeight || getComputedStyle(el).overflowY === 'auto',
      }))
      expect(one.grew).toBe(true)
      expect(one.reachable).toBe(true)
      await box.fill(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'))
      const twelve = await box.evaluate((el) => ({
        scrolls: el.scrollHeight > el.clientHeight,
        auto: getComputedStyle(el).overflowY === 'auto',
      }))
      expect(twelve).toEqual({ scrolls: true, auto: true })
    })

    test('a finished topic stays in the conversation, marked done, with its menu', async ({
      page,
    }) => {
      // 3.22.0: the folded "Show / Hide" job cards are gone with the job tabs; a finished topic is a divider.
      await openBoldRoom(page)
      if (size.width <= 860) {
        await expect(page.locator('.bold-job-fold')).toHaveCount(0)
        return
      }
      const divider = page.getByRole('separator', { name: /^Topic: Queue research, done/ })
      await expect(divider).toBeVisible()
      await expect(divider.getByRole('button', { name: 'Job menu' })).toBeVisible()
    })
  })
}

async function openLibrary(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // 3.22.0: the Library side-panel mode is gone; the same list and editor are the Knowledge page.
  await page.goto('/b/knowledge')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  await expect(page.getByTestId('bold-library')).toBeVisible()
}

for (const size of sizes) {
  test(`New folder in the Library notes, then a note into it (${size.name})`, async ({ page }) => {
    await pair(page)
    await openLibrary(page, size.width, size.height)
    const folder = `fold${Date.now().toString(36)}`
    await page
      .getByRole('complementary', { name: 'Folders' })
      .getByRole('button', { name: /New folder/ })
      .click()
    const dialog = page.getByRole('dialog', { name: 'New folder' })
    await dialog.getByLabel('Folder path').fill(folder)
    await dialog.getByRole('button', { name: /^Create/ }).click()
    // 3.22.0: the Knowledge page lists folders in its Folders rail (no collapsible folder headings in the notes list).
    const rail = page.getByRole('complementary', { name: 'Folders' })
    const heading = rail.getByRole('button', { name: new RegExp(`^${folder}`) })
    await expect(heading).toBeVisible()
    await heading.click()
    await page.getByRole('button', { name: 'New note' }).first().click()
    const note = page.getByRole('dialog', { name: 'New note' })
    await expect(note.getByLabel('Path in Knowledge')).toHaveValue(`${folder}/`)
    await note.getByLabel('Path in Knowledge').fill(`${folder}/first`)
    await note.getByRole('button', { name: 'Create note' }).click()
    await expect(page.getByLabel(`Contents of ${folder}/first.md`)).toBeVisible({ timeout: 15_000 })
  })
}
