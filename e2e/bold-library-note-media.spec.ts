import { expect, test } from '@playwright/test'
import {
  createNote,
  editor,
  openLibrary,
  setupLibrary,
  sizes,
  unique,
} from './bold-library-helpers.ts'
import { pngSize, samplePng } from './png.ts'

setupLibrary()

for (const size of sizes) {
  test.describe(size.name, () => {
    test('toolbar formatting, a table and an image stay in the panel editor', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | ---: |\n| Apples | 3 |\n\nFloor plan:\n`,
      )
      await expect(editor(page, path).locator('.cm-lp-table table')).toBeVisible()
      await page.getByTestId('image-input').setInputFiles({
        name: 'Floor plan.png',
        mimeType: 'image/png',
        buffer: samplePng(1800, 900),
      })
      const picture = editor(page, path).locator('.cm-lp-image img')
      await expect(picture).toBeVisible()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      const body = (
        (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
          body: string
        }
      ).body
      const data = /!\[Floor plan\]\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)/.exec(body)
      expect(data).not.toBeNull()
      expect(pngSize(Buffer.from(data![1]!, 'base64'))).toEqual({ width: 1600, height: 800 })
    })
  })
}
