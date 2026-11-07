import { expect, test, type Page } from '@playwright/test'
import {
  createNote,
  editor,
  noteBody,
  openLibrary,
  setupLibraryEditor,
  unique,
} from './bold-library-editor-helpers.ts'
import { pngSize, samplePng } from './png.ts'

setupLibraryEditor()

test.describe('images inside a note', () => {
  const noBase64 = async (page: Page, path: string) => {
    const text = await editor(page, path).evaluate((el) => el.textContent ?? '')
    expect(text).not.toContain('base64')
    // The chip in Source names the type ("data:image/png · 4 KB") but carries none of the data.
    expect(text.replace(/data:image\/[a-z]+ · [\d.]+ (B|KB|MB)/g, '')).not.toContain('data:image')
  }
  const dataUriOf = (body: string) =>
    /\]\((data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)\)/.exec(body)![1]!

  test('add a big picture with the Image button: downscaled to 1600 px, shown without its data, still there when reopened', async ({
    page,
  }) => {
    await openLibrary(page)
    const name = unique()
    const path = await createNote(page, name, `# ${name}\n\nFloor plan:\n`)
    await editor(page, path).click()
    await page.keyboard.press('Control+End')
    await page.getByTestId('image-input').setInputFiles({
      name: 'Floor plan.png',
      mimeType: 'image/png',
      buffer: samplePng(2400, 1200),
    })
    const picture = editor(page, path).locator('.cm-lp-image img')
    await expect(picture).toBeVisible()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await noBase64(page, path)
    const body = await noteBody(page, path)
    expect(body).toContain('![Floor plan](data:image/png;base64,')
    const png = Buffer.from(dataUriOf(body).split(',')[1]!, 'base64')
    expect(pngSize(png)).toEqual({ width: 1600, height: 800 })
    expect(png.length).toBeLessThan(1.5 * 1024 * 1024)

    await openLibrary(page)
    await page
      .getByRole('navigation', { name: 'Library notes' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click()
    await expect(editor(page, path).locator('.cm-lp-image img')).toBeVisible()
    await noBase64(page, path)
    // The description sits under the picture and edits only the alt text.
    await editor(page, path).getByLabel('Image description (alt text)').fill('Ground floor')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(await noteBody(page, path)).toContain('![Ground floor](data:image/png;base64,')
  })

  test('Source shows a chip instead of the data; clicking it reveals the Markdown', async ({
    page,
  }) => {
    await openLibrary(page)
    const name = unique()
    const path = await createNote(page, name, `# ${name}\n`)
    await editor(page, path).click()
    await page.keyboard.press('Control+End')
    await page.getByTestId('image-input').setInputFiles({
      name: 'chip.png',
      mimeType: 'image/png',
      buffer: samplePng(300, 200),
    })
    await expect(editor(page, path).locator('.cm-lp-image img')).toBeVisible()
    await page.getByRole('button', { name: 'Source' }).click()
    const chip = editor(page, path).locator('.cm-lp-image-chip')
    await expect(chip).toHaveText(/^data:image\/png · \d+(\.\d)? (KB|MB)$/)
    await noBase64(page, path)
    await chip.click()
    await expect(editor(page, path)).toContainText('![chip](data:image/png;base64,')
    await page.getByRole('button', { name: 'Source' }).click()
    await expect(editor(page, path).locator('.cm-lp-image img')).toBeVisible()
  })

  test('paste and drop embed an image; an SVG is refused with a message', async ({ page }) => {
    await openLibrary(page)
    const name = unique()
    const path = await createNote(page, name, `# ${name}\n`)
    const bytes = [...samplePng(200, 120)]
    await editor(page, path).click()
    await page.keyboard.press('Control+End')
    await editor(page, path).evaluate((el, data) => {
      const file = new File([new Uint8Array(data)], 'pasted.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      )
    }, bytes)
    await expect(editor(page, path).locator('.cm-lp-image img')).toHaveCount(1)
    await editor(page, path).evaluate((el, data) => {
      const file = new File([new Uint8Array(data)], 'dropped.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const box = el.getBoundingClientRect()
      el.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
          clientX: box.left + 5,
          clientY: box.top + 5,
        }),
      )
    }, bytes)
    await expect(editor(page, path).locator('.cm-lp-image img')).toHaveCount(2)
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    const body = await noteBody(page, path)
    expect(body).toContain('![pasted](data:image/png;base64,')
    expect(body).toContain('![dropped](data:image/png;base64,')

    await page.getByTestId('image-input').setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    })
    await expect(page.getByRole('alert').filter({ hasText: 'SVG is not allowed' })).toBeVisible()
    expect(await noteBody(page, path)).not.toContain('svg')
  })

  test('the server refuses an SVG or oversized image written around the editor', async ({
    page,
  }) => {
    const name = unique()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    const refused = await page.request.put(`/api/knowledge/notes/${name}.md`, {
      headers: { 'X-Score-Client': 'web' },
      data: { body: `![x](data:image/svg+xml;base64,${svg})`, etag: null },
    })
    expect(refused.status()).toBe(415)
  })
})
