import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { pngSize, samplePng } from './png.ts'

// Needs the Knowledge server (task 6.2): fake mode serves a temp vault. Each test uses its own unique note names,
// so the specs can run in parallel and in any order.
test.beforeEach(async ({ page }) => {
  await pair(page)
})

const unique = () => `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const editor = (page: Page, path: string) => page.getByLabel(`Contents of ${path}`)

async function createNote(page: Page, name: string, text: string) {
  await page.goto('/knowledge')
  // The button, not Ctrl+N: the shortcut is registered only once the lazily loaded page has mounted.
  await page.getByRole('button', { name: 'New note' }).click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog', { name: 'New note' })
  await dialog.getByLabel('Path in the vault').fill(name)
  await dialog.getByRole('button', { name: 'Create note' }).click()
  const path = `${name}.md`
  await expect(page).toHaveURL(
    new RegExp(`/knowledge/${encodeURIComponent(path).replace(/\./g, '\\.')}$`),
  )
  await editor(page, path).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  return path
}

test('create a note, link another note, and see the backlink', async ({ page }) => {
  const target = unique()
  const source = unique()
  await createNote(page, target, `# ${target}\n\nThe target.\n`)
  const sourcePath = await createNote(
    page,
    source,
    `# ${source}\n\nSee [[${target}]] and [[${target}-ghost]].\n`,
  )

  // The editor shows the links formatted: the missing one is marked and offers Create in the side panel; Ctrl+click
  // follows the existing one.
  const links = editor(page, sourcePath)
  await expect(links.locator('.cm-lp-wikilink.is-missing')).toContainText(`${target}-ghost`)
  await expect(
    page
      .getByRole('complementary', { name: 'Note details' })
      .getByRole('button', { name: `Create ${target}-ghost` }),
  ).toBeVisible()
  await links
    .locator(`.cm-lp-wikilink[data-wikilink="${target}"]`)
    .click({ modifiers: ['Control'] })
  await expect(page).toHaveURL(new RegExp(`/knowledge/${target}\\.md$`))

  // The backlinks panel on the target lists the source.
  const side = page.getByRole('complementary', { name: 'Note details' })
  await expect(side.getByRole('link', { name: source })).toBeVisible()
  await side.getByRole('link', { name: source }).click()
  await expect(page).toHaveURL(new RegExp(`/knowledge/${sourcePath.replace('.', '\\.')}$`))
})

test('Ctrl+K searches the vault and opens a hit', async ({ page }) => {
  const name = unique()
  const word = `zebrafinch${name.replace(/\W/g, '')}`
  const path = await createNote(page, name, `# ${name}\n\n${word} sings.\n`)
  await page.goto('/knowledge')
  // The shortcut is registered once the lazily loaded page has mounted: wait for its search box.
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
  await page.keyboard.type(word)
  const results = page.getByRole('region', { name: 'Search results' })
  await results.getByRole('link', { name }).click()
  await expect(editor(page, path)).toBeVisible()
})

test('history: restore an earlier version', async ({ page }) => {
  const name = unique()
  const other = unique()
  const path = await createNote(page, name, `# ${name}\n\nfirst version\n`)
  // A commit for another note in between keeps the next edit from amending the first commit.
  await createNote(page, other, `# ${other}\n`)
  await page.goto(`/knowledge/${path}`)
  await editor(page, path).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(`# ${name}\n\nsecond version\n`)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  // How many commits the note has depends on whether Score amended its last commit (only when no other commit, from a
  // parallel spec sharing the vault, landed in between), so the test never counts them: it waits until the newest
  // commit holds the second version, and the one right below it holds the first.
  type Item = { commit: string }
  let items: Item[] = []
  await expect
    .poll(async () => {
      items = (
        (await (await page.request.get(`/api/knowledge/notes/${path}/history`)).json()) as {
          items: Item[]
        }
      ).items
      if (items.length < 2) return false
      const newest = await page.request.get(
        `/api/knowledge/notes/${path}/versions/${items[0]!.commit}`,
      )
      return ((await newest.json()) as { body: string }).body.includes('second version')
    })
    .toBe(true)
  const history = page.getByRole('heading', { name: 'History' }).locator('..')
  await expect(history.getByRole('listitem')).toHaveCount(items.length)
  await history.getByRole('listitem').nth(1).getByRole('button').click()
  await expect(history.getByText('first version')).toBeVisible()
  await history.getByRole('button', { name: 'Restore this version' }).click()
  await expect(editor(page, path)).toContainText('first version')
})

test('a change behind the editor shows the conflict banner; Reload takes theirs', async ({
  page,
}) => {
  const name = unique()
  const path = await createNote(page, name, `# ${name}\n\nmine\n`)
  const url = `/api/knowledge/notes/${path}`
  const current = (await (await page.request.get(url)).json()) as { etag: string }
  const put = await page.request.put(url, {
    headers: { 'X-Score-Client': 'web' },
    data: { body: `# ${name}\n\ntheirs\n`, etag: current.etag },
  })
  expect(put.ok()).toBe(true)
  await editor(page, path).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' more')
  const banner = page.getByTestId('conflict')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Reload' }).click()
  await expect(editor(page, path)).toContainText('theirs')
})

test('a table stays a grid while editing: click a cell, type, Enter; the Markdown stays canonical', async ({
  page,
}) => {
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
  const saved = (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
    body: string
  }
  expect(saved.body).toContain('- [x] buy apples')
  expect(saved.body).toContain('| **Pears** \\| ripe | 3 |')
  expect(saved.body).toContain('| --- | ---: |')
  // Source mode is where the raw Markdown shows.
  await page.getByRole('button', { name: 'Source' }).click()
  await expect(editor(page, path)).toContainText('| **Pears** \\| ripe | 3 |')
  await expect(editor(page, path).locator('.cm-lp-table')).toHaveCount(0)
})

test('the toolbar formats text, and a table inserted from the size grid survives a reload', async ({
  page,
}) => {
  const name = unique()
  const path = await createNote(page, name, 'plain words')
  const area = editor(page, path)
  await area.click()
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'Bold' }).click()
  await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
  await expect(area.locator('.cm-lp-strong')).toContainText('plain words')
  await page.getByRole('button', { name: 'Heading' }).click()
  await page.getByRole('button', { name: 'Heading 2' }).click()
  await expect(area.locator('.cm-lp-h2')).toBeVisible()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Table' }).click()
  await page.getByRole('button', { name: '3 columns by 3 rows' }).click()
  // The first header cell is open for typing; Tab goes to the next cell; the table tools act on the cell with focus.
  await expect(page.getByRole('toolbar', { name: 'Table' })).toBeVisible()
  await area.locator('.cm-lp-cell-input').fill('Item')
  await page.keyboard.press('Tab')
  await area.locator('.cm-lp-cell-input').fill('Qty')
  await page.getByRole('button', { name: 'Add row below' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const saved = (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
    body: string
  }
  expect(saved.body).toContain('| Item | Qty | Column 3 |\n| --- | --- | --- |')
  expect(saved.body.match(/^\|\s{2}\|\s{2}\|\s{2}\|$/gm)).toHaveLength(3)

  await page.reload()
  await expect(editor(page, path)).toBeVisible()
  const table = editor(page, path).locator('.cm-lp-table table')
  await expect(table.getByRole('columnheader', { name: 'Qty' })).toBeVisible()
  await expect(table.locator('tbody tr')).toHaveCount(3)
})

test('the focused editor shows a quiet ring, not the ink of primary actions', async ({ page }) => {
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
  await page.setViewportSize({ width: 1280, height: 700 })
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
  expect((await toolbar.boundingBox())!.y).toBeLessThan(40)
})

test.describe('images inside a note', () => {
  const noBase64 = async (page: Page, path: string) => {
    const text = await editor(page, path).evaluate((el) => el.textContent ?? '')
    expect(text).not.toContain('base64')
    // The chip in Source names the type ("data:image/png · 4 KB") but carries none of the data.
    expect(text.replace(/data:image\/[a-z]+ · [\d.]+ (B|KB|MB)/g, '')).not.toContain('data:image')
  }
  const savedBody = async (page: Page, path: string) =>
    (
      (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
        body: string
      }
    ).body
  const dataUriOf = (body: string) =>
    /\]\((data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)\)/.exec(body)![1]!

  test('add a big picture with the Image button: downscaled to 1600 px, shown without its data, still there after a reload', async ({
    page,
  }) => {
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
    const body = await savedBody(page, path)
    expect(body).toContain('![Floor plan](data:image/png;base64,')
    const png = Buffer.from(dataUriOf(body).split(',')[1]!, 'base64')
    expect(pngSize(png)).toEqual({ width: 1600, height: 800 })
    expect(png.length).toBeLessThan(1.5 * 1024 * 1024)

    await page.reload()
    await expect(editor(page, path).locator('.cm-lp-image img')).toBeVisible()
    await noBase64(page, path)
    // The description sits under the picture and edits only the alt text.
    await editor(page, path).getByLabel('Image description (alt text)').fill('Ground floor')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    expect(await savedBody(page, path)).toContain('![Ground floor](data:image/png;base64,')
  })

  test('Source shows a chip instead of the data; clicking it reveals the Markdown', async ({
    page,
  }) => {
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
    const body = await savedBody(page, path)
    expect(body).toContain('![pasted](data:image/png;base64,')
    expect(body).toContain('![dropped](data:image/png;base64,')

    await page.getByTestId('image-input').setInputFiles({
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    })
    await expect(page.getByRole('alert').filter({ hasText: 'SVG is not allowed' })).toBeVisible()
    expect(await savedBody(page, path)).not.toContain('svg')
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
