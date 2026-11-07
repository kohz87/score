import { expect, test } from '@playwright/test'
import {
  createNote,
  editor,
  openLibrary,
  setupLibraryEditor,
  unique,
} from './bold-library-editor-helpers.ts'

setupLibraryEditor()

test('Ctrl+K searches the vault and opens a note hit in the Library', async ({ page }) => {
  await openLibrary(page)
  const name = unique()
  const word = `zebrafinch${name.replace(/\W/g, '')}`
  const path = await createNote(page, name, `# ${name}\n\n${word} sings.\n`)
  await page.goto('/b?open=1')
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const box = page.getByRole('combobox', { name: 'Search or run a command' })
  await expect(box).toBeFocused()
  await page.keyboard.type(word)
  await page
    .getByRole('option', { name: new RegExp(name) })
    .first()
    .click()
  await expect(editor(page, path)).toBeVisible({ timeout: 15_000 })
})
