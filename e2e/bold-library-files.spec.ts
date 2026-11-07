import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  createNote,
  editor,
  openLibrary,
  readZip,
  setupLibrary,
  showFiles,
  sizes,
  unfold,
  unique,
} from './bold-library-helpers.ts'
import { storedZip, textPdf } from './knowledge-fixtures.ts'

setupLibrary()

for (const size of sizes) {
  test.describe(size.name, () => {
    test('upload, folders, zip preview, files view and export', async ({ page }) => {
      await openLibrary(page, size)
      const folder = `docs-${unique()}`
      const suffix = unique()
      const pdfName = `budget-${suffix}.pdf`
      const notesName = `notes-${suffix}.md`
      const word = `heliotrope${unique()}`
      await showFiles(page)
      await unfold(page)
      await page.locator('.bold-library-main').getByRole('button', { name: 'New folder' }).click()
      await unfold(page)
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

      // 3.22.0: a phone's Knowledge page shows the Files view or the list; Back returns to the list with Search.
      const backToList = page.getByRole('button', { name: /Back to the notes/ })
      if (await backToList.isVisible()) await backToList.click()
      await page.getByPlaceholder('Search', { exact: true }).fill(word)
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

      const listBack = page.getByRole('button', { name: /Back to the notes/ })
      if (await listBack.isVisible()) await listBack.click()
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
      await unfold(page)
      await page.locator('.bold-library-main').getByRole('button', { name: 'New folder' }).click()
      await unfold(page)
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
