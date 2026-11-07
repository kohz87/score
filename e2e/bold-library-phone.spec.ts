import { expect, test } from '@playwright/test'
import {
  createNote,
  noteButton,
  openLibrary,
  setupLibrary,
  sizes,
  unique,
  unfold,
} from './bold-library-helpers.ts'

setupLibrary()

test('the phone sheet stacks a dialog above the tab bar and Escape only closes the dialog', async ({
  page,
}, testInfo) => {
  await openLibrary(page, sizes[1])
  // 3.22.0: the Library is the Knowledge page now (no modal side-panel sheet); the dialog rules stay.
  const panel = page.getByTestId('bold-library')
  await expect(panel).toBeVisible()

  await page.getByRole('button', { name: 'New note' }).click()
  const dialog = page.getByRole('dialog', { name: 'New note' })
  await expect(dialog).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('bold-library-dialog-390.png') })
  const overTabBar = await page.evaluate(() => {
    const tabs = document.querySelector('.bold-tabbar')
    if (!(tabs instanceof HTMLElement)) return false
    const rect = tabs.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return Boolean(hit?.closest('.kn-backdrop'))
  })
  expect(overTabBar).toBe(true)
  await dialog.getByLabel('Path in Knowledge').press('Escape')
  await expect(dialog).toBeHidden()
  await expect(panel).toBeVisible()
})

test('on a phone, tapping a note scrolls it into view and focuses its heading', async ({
  page,
}) => {
  await openLibrary(page, sizes[1])
  const first = unique()
  const second = unique()
  await createNote(page, first, `# ${first}\n\nFirst.\n`)
  await createNote(page, second, `# ${second}\n\nSecond.\n`)

  await unfold(page)
  await noteButton(page, first).click()
  const panel = page.getByTestId('bold-library')
  await expect(page.locator('.kn-note-head h2', { hasText: first })).toBeFocused()
  // 3.22.0: on the Knowledge page a phone shows the note full width with Back (the list is hidden); the page scrolls.
  await expect(page.getByRole('button', { name: /Back to the notes/ })).toBeVisible()
  await expect(noteButton(page, second)).toHaveCount(0)
  await expect(panel).toBeVisible()
})
