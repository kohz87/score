import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { storedZip, textPdf } from './knowledge-fixtures.ts'
import { pair } from './pair.ts'
import { pngSize, samplePng } from './png.ts'

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

const unique = () => `bold-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const editor = (page: Page, path: string) => page.getByLabel(`Contents of ${path}`)
const noteButton = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Library notes' })
    .getByRole('button', { name: new RegExp(`^${name}`) })

test.beforeEach(async ({ page }) => {
  await pair(page)
})

async function openLibrary(page: Page, size: (typeof sizes)[number]) {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
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

async function showFiles(page: Page) {
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible()
}

function readZip(file: string): Record<string, string> {
  const data = readFileSync(file)
  const out: Record<string, string> = {}
  // The server streams entries with data descriptors, so the local headers do not carry sizes. Read the central
  // directory instead, as the classic knowledge-export spec does.
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = data.readUInt16LE(end + 10)
  let at = data.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    const method = data.readUInt16LE(at + 10)
    const size = data.readUInt32LE(at + 20)
    const nameLength = data.readUInt16LE(at + 28)
    const extra = data.readUInt16LE(at + 30)
    const comment = data.readUInt16LE(at + 32)
    const local = data.readUInt32LE(at + 42)
    const name = data.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const bytes = data.subarray(start, start + size)
    out[name] = (method === 8 ? inflateRawSync(bytes) : bytes).toString('utf8')
    at += 46 + nameLength + extra + comment
  }
  return out
}

for (const size of sizes) {
  test.describe(size.name, () => {
    test('create notes, follow a link, and see the backlink', async ({ page }) => {
      await openLibrary(page, size)
      const target = unique()
      const source = unique()
      const targetPath = await createNote(page, target, `# ${target}\n\nThe target.\n`)
      const sourcePath = await createNote(
        page,
        source,
        `# ${source}\n\nSee [[${target}]] and [[${target}-ghost]].\n`,
      )

      await expect(editor(page, sourcePath)).toContainText(`${target}-ghost`)
      await expect(
        page
          .getByRole('complementary', { name: 'Note details' })
          .getByRole('button', { name: `Create ${target}-ghost` }),
      ).toBeVisible()
      await editor(page, sourcePath)
        .locator(`.cm-lp-wikilink[data-wikilink="${target}"]`)
        .click({ modifiers: ['Control'] })
      await expect(editor(page, targetPath)).toBeVisible()
      const side = page.getByRole('complementary', { name: 'Note details' })
      await expect(side.getByRole('button', { name: source })).toBeVisible()
      await side.getByRole('button', { name: source }).click()
      await expect(editor(page, sourcePath)).toBeVisible()
    })

    test('search opens a note hit', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const word = `zebrafinch${name.replace(/\W/g, '')}`
      const path = await createNote(page, name, `# ${name}\n\n${word} sings.\n`)
      await page.getByPlaceholder('Search').fill(word)
      const results = page.getByRole('region', { name: 'Search results' })
      await results.getByRole('button', { name: new RegExp(name) }).click()
      await expect(editor(page, path)).toBeVisible()
    })

    test('history restores an earlier version', async ({ page }) => {
      await openLibrary(page, size)
      const name = unique()
      const other = unique()
      const path = await createNote(page, name, `# ${name}\n\nfirst version\n`)
      await createNote(page, other, `# ${other}\n`)
      await noteButton(page, name).click()
      await editor(page, path).click()
      await page.keyboard.press('Control+a')
      await page.keyboard.insertText(`# ${name}\n\nsecond version\n`)
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()

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

    test('a change behind the editor shows the conflict banner and Reload takes theirs', async ({
      page,
    }) => {
      await openLibrary(page, size)
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

    test('upload, folders, zip preview, files view and export', async ({ page }) => {
      await openLibrary(page, size)
      const folder = `docs-${unique()}`
      const suffix = unique()
      const pdfName = `budget-${suffix}.pdf`
      const notesName = `notes-${suffix}.md`
      const word = `heliotrope${unique()}`
      await showFiles(page)
      await page.getByRole('button', { name: 'New folder' }).click()
      const folderDialog = page.getByRole('dialog', { name: 'New folder' })
      await folderDialog.getByLabel('Folder path').fill(folder)
      await folderDialog.getByRole('button', { name: 'Create folder' }).click()
      await expect(page.getByRole('navigation', { name: 'Folder' }).getByText(folder)).toBeVisible()

      await page.getByTestId('kn-upload-input').setInputFiles([
        { name: pdfName, mimeType: 'application/pdf', buffer: textPdf(`Budget ${word}`) },
        {
          name: notesName,
          mimeType: 'text/markdown',
          buffer: Buffer.from('# Notes\n\nCafé ☕\n'),
        },
      ])
      await expect(page.getByText('Added 2 files')).toBeVisible({ timeout: 30_000 })
      const table = page.getByRole('region', { name: 'Files in this folder' })
      await expect(table.getByRole('button', { name: pdfName, exact: true })).toBeVisible()
      await expect(
        table.getByRole('button', { name: notesName.replace(/\.md$/i, ''), exact: true }),
      ).toBeVisible()

      await page.getByPlaceholder('Search').fill(word)
      const results = page.getByRole('region', { name: 'Search results' })
      await results
        .getByRole('button', { name: new RegExp(pdfName.replaceAll('.', '\\.')) })
        .click()
      await expect(page.locator('.kn-doc-text')).toContainText(word)

      await showFiles(page)
      const folderDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Export this folder' }).click()
      const folderZip = await folderDownload
      expect(folderZip.suggestedFilename()).toMatch(
        new RegExp(`^knowledge-${folder}-\\d{4}-\\d{2}-\\d{2}\\.zip$`),
      )
      const exported = readZip((await folderZip.path())!)
      expect(Object.keys(exported).sort()).toEqual(['README.txt', pdfName, notesName].sort())

      const zipName = unique()
      await page.getByTestId('kn-upload-input').setInputFiles({
        name: `${zipName}.zip`,
        mimeType: 'application/zip',
        buffer: storedZip({ 'one.md': `# One ${zipName}`, 'tool.exe': 'MZ' }),
      })
      const zipDialog = page.getByRole('dialog', { name: new RegExp(`Zip file: ${zipName}\\.zip`) })
      await expect(zipDialog).toBeVisible({ timeout: 15_000 })
      await expect(zipDialog.getByText('1 file will be added; 1 will be skipped.')).toBeVisible()
      await zipDialog.getByRole('button', { name: 'Unzip' }).click()
      // Uploads go to the folder on show (as the classic page does), so the zip unpacks under it.
      await expect(
        page.getByText(new RegExp(`Unzipped 1 file into ${folder}/${zipName} \\(1 skipped\\)`)),
      ).toBeVisible({
        timeout: 30_000,
      })

      await page.getByRole('button', { name: 'Export', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Export all of Knowledge' })
      await expect(dialog.getByText(/before compression/)).toBeVisible()
      const vaultDownload = page.waitForEvent('download')
      await dialog.getByRole('button', { name: 'Download zip' }).click()
      expect((await vaultDownload).suggestedFilename()).toMatch(/^knowledge-vault-/)
    })

    test('a zip kept as a zip is not sent a second time', async ({ page }) => {
      await openLibrary(page, size)
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
        buffer: storedZip({ 'one.md': `# One ${name}` }),
      })
      const zipDialog = page.getByRole('dialog', { name: new RegExp(`Zip file: ${name}\\.zip`) })
      await expect(zipDialog).toBeVisible({ timeout: 15_000 })
      await zipDialog.getByRole('radio', { name: /Keep as a zip/ }).check()
      await zipDialog.getByRole('button', { name: 'Keep as a zip' }).click()
      await expect(page.getByText(new RegExp(`Added ${name}\\.zip at the top level`))).toBeVisible({
        timeout: 30_000,
      })
      await expect(
        page
          .getByRole('region', { name: 'Files in this folder' })
          .getByRole('button', { name: `${name}.zip`, exact: true }),
      ).toBeVisible()
      expect(puts).toHaveLength(1)
      expect(puts[0]).toContain('mode=preview')
    })

    test('downloads a single note and a selected file', async ({ page }) => {
      await openLibrary(page, size)
      const folder = `downloads-${unique()}`
      const suffix = unique()
      const noteName = `notes-${suffix}.md`
      const dataName = `data-${suffix}.csv`
      await showFiles(page)
      await page.getByRole('button', { name: 'New folder' }).click()
      const folderDialog = page.getByRole('dialog', { name: 'New folder' })
      await folderDialog.getByLabel('Folder path').fill(folder)
      await folderDialog.getByRole('button', { name: 'Create folder' }).click()
      await expect(page.getByRole('navigation', { name: 'Folder' }).getByText(folder)).toBeVisible()
      await page.getByTestId('kn-upload-input').setInputFiles([
        {
          name: noteName,
          mimeType: 'text/markdown',
          buffer: Buffer.from('# Notes\n\nDownload me.\n'),
        },
        { name: dataName, mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') },
      ])
      await expect(page.getByText('Added 2 files')).toBeVisible({ timeout: 30_000 })

      const table = page.getByRole('region', { name: 'Files in this folder' })
      await table.getByRole('button', { name: noteName.replace(/\.md$/i, ''), exact: true }).click()
      await expect(editor(page, `${folder}/${noteName}`)).toBeVisible()
      const noteDownload = page.waitForEvent('download')
      await page.getByRole('link', { name: 'Download', exact: true }).click()
      const note = await noteDownload
      expect(note.suggestedFilename()).toBe(noteName)
      expect(readFileSync((await note.path())!, 'utf8')).toBe('# Notes\n\nDownload me.\n')

      await showFiles(page)
      await page.getByRole('checkbox', { name: `Select ${dataName}` }).check()
      const selectionDownload = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download selected (1)' }).click()
      const selected = readZip((await (await selectionDownload).path())!)
      expect(Object.keys(selected).sort()).toEqual(['README.txt', `${folder}/${dataName}`].sort())
    })

    test('moving a note updates links to it', async ({ page }) => {
      await openLibrary(page, size)
      const target = unique()
      const moved = unique()
      const source = unique()
      const targetPath = await createNote(page, target, `# ${target}\n\nMove me.\n`)
      const sourcePath = await createNote(page, source, `# ${source}\n\nSee [[${target}]].\n`)

      await noteButton(page, target).click()
      await expect(editor(page, targetPath)).toBeVisible()
      await page.getByRole('button', { name: 'Rename or move' }).click()
      const dialog = page.getByRole('dialog', {
        name: new RegExp(`Rename or move ${target}`),
      })
      await dialog.getByLabel('New path').fill(moved)
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()
      await expect(editor(page, `${moved}.md`)).toBeVisible({ timeout: 15_000 })
      await expect(
        page.getByText(new RegExp(`Moved to ${moved}\\.md\\. Updated links in 1 note`)),
      ).toBeVisible()

      const updated = (await (
        await page.request.get(`/api/knowledge/notes/${sourcePath}`)
      ).json()) as {
        body: string
      }
      expect(updated.body).toContain(`[[${moved}]]`)
      expect((await page.request.get(`/api/knowledge/notes/${targetPath}`)).status()).toBe(404)
      await noteButton(page, source).click()
      await expect(
        editor(page, sourcePath).locator(`.cm-lp-wikilink[data-wikilink="${moved}"]`),
      ).toContainText(moved)
    })

    test('deleting the open note shows Pick a note instead of opening another', async ({
      page,
    }) => {
      await openLibrary(page, size)
      const first = unique()
      const second = unique()
      const firstPath = await createNote(page, first, `# ${first}\n\nFirst.\n`)
      await createNote(page, second, `# ${second}\n\nSecond.\n`)

      await noteButton(page, first).click()
      await expect(editor(page, firstPath)).toBeVisible()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Delete ${first}?` })
      await dialog.getByRole('button', { name: 'Delete note' }).click()
      await expect(page.getByText('Pick a note', { exact: true })).toBeVisible({ timeout: 15_000 })
      await expect(noteButton(page, first)).toHaveCount(0)
      await expect(noteButton(page, second)).toBeVisible()
      expect((await page.request.get(`/api/knowledge/notes/${firstPath}`)).status()).toBe(404)
    })

    test('an existing name offers Replace and Keep both', async ({ page }) => {
      await openLibrary(page, size)
      await showFiles(page)
      const base = `clash-${unique()}`
      const name = `${base}.csv`
      const upload = (content: string) =>
        page.getByTestId('kn-upload-input').setInputFiles({
          name,
          mimeType: 'text/csv',
          buffer: Buffer.from(content),
        })

      await upload('old,value\n1,2\n')
      await expect(page.getByText(new RegExp(`Added ${name} at the top level`))).toBeVisible({
        timeout: 30_000,
      })
      await upload('new,value\n3,4\n')
      const clash = page.getByRole('dialog', { name: /already exists/ })
      await expect(clash).toBeVisible()
      await expect(clash.getByRole('button', { name: 'Keep both' })).toBeVisible()
      await expect(clash.getByRole('button', { name: /^Replace/ })).toBeVisible()
      await clash.getByRole('button', { name: /^Replace/ }).click()
      await expect
        .poll(async () => {
          const response = await page.request.get(`/api/knowledge/documents/${name}`)
          if (!response.ok()) return false
          return ((await response.json()) as { text: string }).text.includes('new,value')
        })
        .toBe(true)
      await page
        .getByRole('region', { name: 'Files in this folder' })
        .getByRole('button', { name, exact: true })
        .click()
      // A CSV shows as a table: the replaced file's cells, not its raw text.
      const table = page.locator('.kn-doc .chat-doc-table')
      // The first CSV row is the header.
      await expect(table.getByRole('row', { name: 'new value', exact: true })).toBeVisible()

      await showFiles(page)
      await upload('third,value\n5,6\n')
      const keep = page.getByRole('dialog', { name: /already exists/ })
      await expect(keep).toBeVisible()
      await keep.getByRole('button', { name: 'Keep both' }).click()
      await expect(
        page
          .getByRole('region', { name: 'Files in this folder' })
          .getByRole('button', { name: `${base} (2).csv`, exact: true }),
      ).toBeVisible({ timeout: 30_000 })
    })

    test('a note in a Git-ignored folder is marked as not kept in history', async ({ page }) => {
      await openLibrary(page, size)
      const folder = `nohistory-${unique()}`
      for (const name of readdirSync(tmpdir()))
        if (name.startsWith('score-fake-vault-'))
          writeFileSync(join(tmpdir(), name, '.gitignore'), `${folder}/\n`, { flag: 'a' })
      const path = await createNote(
        page,
        `${folder}/private-note`,
        '# Private note\n\nKept on disk only.\n',
      )
      await expect(page.getByTestId('not-in-history')).toHaveText('Not kept in history')
      await expect(page.getByTestId('history-not-kept')).toContainText(
        '.gitignore excludes this folder',
      )
      await expect(page.getByTestId('history-missed')).toHaveCount(0)
      expect(path).toBe(`${folder}/private-note.md`)
    })
  })
}

test('the phone sheet stacks a dialog above the tab bar and Escape only closes the dialog', async ({
  page,
}, testInfo) => {
  await openLibrary(page, sizes[1])
  const panel = page.getByRole('complementary', { name: 'Side panel' })
  const box = await panel.boundingBox()
  expect(box?.width).toBeGreaterThan(350)
  expect(box?.height).toBeGreaterThan(800)
  await expect(panel).toHaveAttribute('aria-modal', 'true')

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

  const close = page.getByRole('button', { name: 'Close side panel' })
  await close.click()
  await expect(panel).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open side panel' })).toBeFocused()
})

test('on a phone, tapping a note scrolls it into view and focuses its heading', async ({
  page,
}) => {
  await openLibrary(page, sizes[1])
  const first = unique()
  const second = unique()
  await createNote(page, first, `# ${first}\n\nFirst.\n`)
  await createNote(page, second, `# ${second}\n\nSecond.\n`)

  await noteButton(page, first).click()
  const panel = page.getByTestId('bold-library')
  await expect(page.locator('.kn-note-head h2', { hasText: first })).toBeFocused()
  await expect.poll(async () => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})
