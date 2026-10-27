import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { storedZip, textPdf } from './knowledge-fixtures.ts'
import { pair } from './pair.ts'
import { pngSize, samplePng } from './png.ts'

// 3.0.0: what the classic knowledge, knowledge-export, knowledge-files and visual specs proved that bold-library.spec.ts
// does not: the table and toolbar editing, the focus ring, the sticky toolbar, pictures inside a note, the exact contents
// of exported zips, the download headers, and zip safety. The Library is the side panel's Library view (`/b`).
test.use({ reducedMotion: 'reduce' })

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

const unique = () => `lib-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const editor = (page: Page, path: string) => page.getByLabel(`Contents of ${path}`)

test.beforeEach(async ({ page }) => {
  await pair(page)
})

async function openLibrary(page: Page, size: (typeof sizes)[number] = sizes[0]) {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.goto('/b')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  if (size.width < 861) await page.getByRole('button', { name: 'Open side panel' }).click()
  await page.locator('button.side-toggle').click()
  await page.getByRole('button', { name: /^Library/ }).click()
  await expect(page.getByTestId('bold-library')).toBeVisible()
}

async function createNote(page: Page, name: string, text: string) {
  await page.getByRole('button', { name: 'New note' }).click()
  const dialog = page.getByRole('dialog', { name: 'New note' })
  await dialog.getByLabel('Path in Knowledge').fill(name)
  await dialog.getByRole('button', { name: 'Create note' }).click()
  const path = `${name}.md`
  await expect(editor(page, path)).toBeVisible({ timeout: 15_000 })
  await editor(page, path).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  return path
}

const noteBody = async (page: Page, path: string) =>
  (
    (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
      body: string
    }
  ).body

async function showFiles(page: Page) {
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible()
}

async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)
}

/** Reads a zip through its central directory (stored or deflated entries). */
function readZip(file: string): Record<string, string> {
  const buf = readFileSync(file)
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const extra = buf.readUInt16LE(at + 30)
    const comment = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    at += 46 + nameLength + extra + comment
  }
  return out
}

test('Ctrl+K searches the vault and opens a note hit in the Library', async ({ page }) => {
  await openLibrary(page)
  const name = unique()
  const word = `zebrafinch${name.replace(/\W/g, '')}`
  const path = await createNote(page, name, `# ${name}\n\n${word} sings.\n`)
  await page.goto('/b')
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

for (const size of sizes) {
  test.describe(`note editing at ${size.name}`, () => {
    test('a table stays a grid while editing: click a cell, type, Enter; the Markdown stays canonical', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | ---: |\n| Apples | 3 |\n\n- [ ] buy apples\n\nEnd\n`,
      )
      const table = editor(page, path).locator('.cm-lp-table table')
      await expect(table.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
      await expect(table.getByRole('cell', { name: 'Apples' })).toBeVisible()
      // The task checkbox is a named button that edits the source.
      await editor(page, path).getByRole('checkbox', { name: 'Task: buy apples' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      // Clicking a cell opens an input in it; the grid never turns into raw pipes.
      await table.getByRole('cell', { name: 'Apples' }).click()
      const field = table.getByRole('textbox', { name: 'Item, row 1' })
      await expect(field).toBeFocused()
      await expect(editor(page, path).locator('.cm-lp-table')).toHaveCount(1)
      await expect(editor(page, path)).not.toContainText('| Apples |')
      // With the caret in the table, its tools show in the toolbar.
      await expect(page.getByRole('toolbar', { name: 'Table' })).toBeVisible()
      await field.fill('**Pears** | ripe')
      await page.keyboard.press('Enter')
      await expect(table.getByRole('cell', { name: 'Pears | ripe' })).toBeVisible()
      await expect(table.locator('td strong')).toHaveText('Pears')
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      const saved = await noteBody(page, path)
      expect(saved).toContain('- [x] buy apples')
      expect(saved).toContain('| **Pears** \\| ripe | 3 |')
      expect(saved).toContain('| --- | ---: |')
      // Source mode is where the raw Markdown shows.
      await page.getByRole('button', { name: 'Source' }).click()
      await expect(editor(page, path)).toContainText('| **Pears** \\| ripe | 3 |')
      await expect(editor(page, path).locator('.cm-lp-table')).toHaveCount(0)
      await expect(page.locator('.cm-editor.cm-source')).toBeVisible()
      if (size.width < 500) await noPageOverflow(page)
    })

    test('a column is dragged wider and stays so after a reload; cells dragged across are copied (3.8.3)', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | **4** |\n`,
      )
      const table = editor(page, path).locator('.cm-lp-table table')
      const first = table.getByRole('columnheader', { name: 'Item' })
      const before = (await first.boundingBox())!.width
      const handle = first.locator('.cm-lp-col-resize')
      const grip = (await handle.boundingBox())!
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.mouse.move(grip.x + grip.width / 2 + 120, grip.y + grip.height / 2, { steps: 6 })
      await page.mouse.up()
      await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(before + 80)
      // The note itself is unchanged: widths live on this device.
      expect(await noteBody(page, path)).toContain('| Item | Qty |')
      await page.reload()
      await openLibrary(page, size)
      await page
        .getByRole('navigation', { name: 'Library notes' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
      const again = editor(page, path).locator('.cm-lp-table table')
      await expect
        .poll(
          async () =>
            (await again.getByRole('columnheader', { name: 'Item' }).boundingBox())!.width,
        )
        .toBeGreaterThan(before + 80)

      // A touch drag scrolls on a phone (a cell's own text is copied from its field there): the range is a mouse thing.
      if (size.width < 500) return
      // Drag from Apples to 4: four cells; Ctrl+C copies what they show.
      const apples = (await again.getByRole('cell', { name: 'Apples' }).boundingBox())!
      await page.mouse.move(apples.x + 10, apples.y + apples.height / 2)
      await page.mouse.down()
      // Pressing a cell starts its edit, which may scroll the editor: measure the target after.
      const four = (await again.locator('td').nth(3).boundingBox())!
      await page.mouse.move(four.x + 10, four.y + four.height / 2, { steps: 6 })
      await page.mouse.up()
      await expect(again.locator('.cm-lp-cell-selected')).toHaveCount(4)
      await page.keyboard.press('Control+c')
      await expect(editor(page, path).getByRole('status')).toHaveText('Copied 4 cells')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Apples\t3\nPears\t4')
    })

    test('the corner grip widens the whole table and a row grip makes a row taller; both stay after a reload (3.8.4)', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n| Item | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 4 |\n`,
      )
      const table = () => editor(page, path).locator('.cm-lp-table table')
      const drag = async (grip: Locator, dx: number, dy: number) => {
        const box = (await grip.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 })
        await page.mouse.up()
      }
      const tableWidth = async () => (await table().boundingBox())!.width
      const rowHeight = async () =>
        (await table().locator('tbody tr').first().boundingBox())!.height
      const width = await tableWidth()
      const height = await rowHeight()
      await drag(table().locator('.cm-lp-table-resize'), 90, 0)
      await expect.poll(tableWidth).toBeGreaterThan(width + 60)
      await drag(table().locator('tbody tr').first().locator('.cm-lp-row-resize'), 0, 40)
      await expect.poll(rowHeight).toBeGreaterThan(height + 25)
      expect(await noteBody(page, path)).toContain('| Item | Qty |')
      await page.reload()
      await openLibrary(page, size)
      await page
        .getByRole('navigation', { name: 'Library notes' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
      await expect.poll(tableWidth).toBeGreaterThan(width + 60)
      await expect.poll(rowHeight).toBeGreaterThan(height + 25)
    })

    test('the toolbar formats text, and a table inserted from the size grid survives reopening', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(page, name, 'plain words')
      const area = editor(page, path)
      await area.click()
      await page.keyboard.press('Control+a')
      await page.getByRole('button', { name: 'Bold' }).click()
      await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(area.locator('.cm-lp-strong')).toContainText('plain words')
      await page.getByRole('button', { name: 'Heading' }).click()
      await page.getByRole('button', { name: 'Heading 2' }).click()
      await expect(area.locator('.cm-lp-h2')).toBeVisible()
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Table', exact: true }).click()
      await page.getByRole('button', { name: '4 columns by 3 rows' }).hover()
      await expect(page.getByText('4 × 3')).toBeVisible()
      await page.getByRole('button', { name: '3 columns by 3 rows' }).click()
      // The first header cell is open for typing; Tab goes to the next cell; the table tools act on the cell in focus.
      await expect(page.getByRole('toolbar', { name: 'Table' })).toBeVisible()
      await area.locator('.cm-lp-cell-input').fill('Item')
      await page.keyboard.press('Tab')
      await area.locator('.cm-lp-cell-input').fill('Qty')
      await page.getByRole('button', { name: 'Add row below' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      const saved = await noteBody(page, path)
      expect(saved).toContain('| Item | Qty | Column 3 |\n| --- | --- | --- |')
      expect(saved.match(/^\|\s{2}\|\s{2}\|\s{2}\|$/gm)).toHaveLength(3)

      // Open it again from scratch: the table is still a grid.
      await openLibrary(page, size)
      await page
        .getByRole('navigation', { name: 'Library notes' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
      const table = editor(page, path).locator('.cm-lp-table table')
      await expect(table.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
      await expect(table.locator('tbody tr')).toHaveCount(3)
      if (size.width < 500) await noPageOverflow(page)
    })

    test('the focused editor shows a quiet ring, not the ink of primary actions', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(page, name, `# ${name}\n`)
      await editor(page, path).click()
      const ring = await page.locator('.cm-editor.cm-focused').evaluate((el) => ({
        style: getComputedStyle(el).outlineStyle,
        color: getComputedStyle(el).outlineColor,
      }))
      expect(ring.style).toBe('solid')
      expect(ring.color).not.toBe('rgb(18, 19, 26)')
    })

    test('the toolbar stays in view while a long note scrolls', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const path = await createNote(
        page,
        name,
        `# ${name}\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i}`).join('\n\n')}\n`,
      )
      await editor(page, path).click()
      await page.keyboard.press('Control+End')
      const toolbar = page.getByRole('toolbar', { name: 'Formatting' })
      await expect(toolbar).toBeInViewport({ ratio: 1 })
      // Near the top of the panel that scrolls, not far down the page.
      const panel = page.getByTestId('bold-library')
      const gap = (await toolbar.boundingBox())!.y - (await panel.boundingBox())!.y
      expect(gap).toBeLessThan(120)
    })
  })
}

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

test('an exported folder and a selection hold exactly the uploaded bytes', async ({ page }) => {
  await openLibrary(page)
  const folder = `exp-${unique()}`
  await showFiles(page)
  await page.locator('.bold-library-main').getByRole('button', { name: 'New folder' }).click()
  const dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Folder path').fill(folder)
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('navigation', { name: 'Folder' }).getByText(folder)).toBeVisible()
  await page.getByTestId('kn-upload-input').setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nCafé ☕\n') },
    { name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') },
  ])
  await expect(page.getByText('Added 2 files')).toBeVisible({ timeout: 30_000 })

  const folderDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export this folder' }).click()
  const folderZip = await folderDownload
  expect(folderZip.suggestedFilename()).toMatch(
    new RegExp(`^knowledge-${folder}-\\d{4}-\\d{2}-\\d{2}\\.zip$`),
  )
  const folderFiles = readZip((await folderZip.path())!)
  expect(Object.keys(folderFiles).sort()).toEqual(['README.txt', 'data.csv', 'notes.md'])
  expect(folderFiles['data.csv']).toBe('a,b\n1,2\n')
  expect(folderFiles['notes.md']).toBe('# Notes\n\nCafé ☕\n')

  // Select one file; the button counts the selection and keeps the vault path.
  await page.getByRole('checkbox', { name: 'Select data.csv' }).check()
  const selectedDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download selected (1)' }).click()
  const selectedFiles = readZip((await (await selectedDownload).path())!)
  expect(Object.keys(selectedFiles).sort()).toEqual(['README.txt', `${folder}/data.csv`])
  expect(selectedFiles[`${folder}/data.csv`]).toBe('a,b\n1,2\n')
})

test('a PDF downloads as an attachment, never rendered from Score’s origin, and its text is searchable', async ({
  page,
}) => {
  await openLibrary(page)
  const folder = `docs-${unique()}`
  const word = `heliotrope${unique()}`
  await showFiles(page)
  await page.locator('.bold-library-main').getByRole('button', { name: 'New folder' }).click()
  const dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Folder path').fill(folder)
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('navigation', { name: 'Folder' }).getByText(folder)).toBeVisible()
  await page.getByTestId('kn-upload-input').setInputFiles({
    name: 'budget.pdf',
    mimeType: 'application/pdf',
    buffer: textPdf(`Budget ${word} review`),
  })
  await expect(page.getByText(new RegExp(`Added ${folder}/budget\\.pdf`))).toBeVisible({
    timeout: 30_000,
  })
  await page.getByPlaceholder('Search').fill(word)
  const hit = page.getByRole('region', { name: 'Search results' }).getByRole('button').first()
  await expect(hit).toContainText('PDF', { timeout: 15_000 })

  const response = await page.request.get(`/api/knowledge/files/${folder}/budget.pdf?download=1`)
  expect(response.headers()['content-disposition']).toMatch(/^attachment/)
  expect(response.headers()['content-security-policy']).toContain('sandbox')
})

test('a zip asks: unzip into a folder, skipping what is unsafe, and nothing escapes the folder', async ({
  page,
}) => {
  await openLibrary(page)
  await showFiles(page)
  const name = unique()
  const puts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/knowledge/files/'))
      puts.push(request.url())
  })
  await page.getByTestId('kn-upload-input').setInputFiles({
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: storedZip({
      'one.md': `# One ${name}`,
      'sub/data.csv': 'a,b\n1,2\n',
      'tool.exe': 'MZ',
      '../escape.md': 'nope',
    }),
  })
  const zipDialog = page.getByRole('dialog', { name: new RegExp(`Zip file: ${name}\\.zip`) })
  await expect(zipDialog).toBeVisible({ timeout: 15_000 })
  await expect(zipDialog.getByText('2 files will be added; 2 will be skipped.')).toBeVisible()
  await zipDialog.getByRole('button', { name: 'Unzip' }).click()
  await expect(page.getByText(new RegExp(`Unzipped 2 files into .*${name}`))).toBeVisible({
    timeout: 30_000,
  })
  // The previewed zip is not sent a second time (10.3): one PUT, the preview.
  expect(puts).toHaveLength(1)
  expect(puts[0]).toContain('mode=preview')
  const escaped = await page.request.get('/api/knowledge/notes/escape.md')
  expect(escaped.status()).toBe(404)
})
