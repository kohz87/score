import { expect, test } from '@playwright/test'
import {
  openLibrary,
  readZip,
  setupLibraryEditor,
  showFiles,
  unique,
} from './bold-library-editor-helpers.ts'
import { storedZip, textPdf } from './knowledge-fixtures.ts'

setupLibraryEditor()

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
  await page.getByPlaceholder('Search', { exact: true }).fill(word)
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
