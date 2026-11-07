import { expect, test } from '@playwright/test'
import {
  createNote,
  editor,
  openLibrary,
  setupLibrary,
  sizes,
  unique,
  unfold,
} from './bold-library-helpers.ts'

setupLibrary()

for (const size of sizes) {
  test.describe(size.name, () => {
    test('search opens a note hit', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const word = `zebrafinch${name.replace(/\W/g, '')}`
      const path = await createNote(page, name, `# ${name}\n\n${word} sings.\n`)
      await unfold(page)
      await page.getByPlaceholder('Search', { exact: true }).fill(word)
      const results = page.getByRole('region', { name: 'Search results' })
      await results.getByRole('button', { name: new RegExp(name) }).click()
      await expect(editor(page, path)).toBeVisible()
    })
  })
}
