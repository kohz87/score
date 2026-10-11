import fs from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Knowledge export (PLAN 6.7): a folder and a selection come out as zips whose contents are compared here.
test.beforeEach(async ({ page }) => {
  await pair(page)
})

const unique = () => `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Reads a zip through its central directory (stored or deflated entries). */
function readZip(file: string): Record<string, string> {
  const buf = fs.readFileSync(file)
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

test('export a folder and a selection, and download a single note', async ({ page }) => {
  const folder = `exp-${unique()}`
  await page.goto('/knowledge?files=')
  await page.getByTestId('kn-upload-input').waitFor({ state: 'attached', timeout: 15_000 })
  await page.getByRole('button', { name: 'New folder' }).click()
  const dialog = page.getByRole('dialog', { name: 'New folder' })
  await dialog.getByLabel('Folder path').fill(folder)
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('navigation', { name: 'Folder' }).getByText(folder)).toBeVisible()
  await page.getByTestId('kn-upload-input').setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nCafé ☕\n') },
    { name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') },
  ])
  await expect(page.getByText('Added 2 files')).toBeVisible({ timeout: 30_000 })

  // Export this folder.
  const folderDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export this folder' }).click()
  const folderZip = await folderDownload
  expect(folderZip.suggestedFilename()).toMatch(
    new RegExp(`^knowledge-${folder}-\\d{4}-\\d{2}-\\d{2}\\.zip$`),
  )
  const folderPath = await folderZip.path()
  const folderFiles = readZip(folderPath)
  expect(Object.keys(folderFiles).sort()).toEqual(['README.txt', 'data.csv', 'notes.md'])
  expect(folderFiles['data.csv']).toBe('a,b\n1,2\n')
  expect(folderFiles['notes.md']).toBe('# Notes\n\nCafé ☕\n')

  // Select one file; the button counts the selection and keeps the vault path.
  await page.getByRole('checkbox', { name: 'Select data.csv' }).check()
  await expect(page.getByRole('button', { name: 'Download selected (1)' })).toBeVisible()
  const selectedDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download selected (1)' }).click()
  const selectedFiles = readZip(await (await selectedDownload).path())
  expect(Object.keys(selectedFiles).sort()).toEqual(['README.txt', `${folder}/data.csv`])

  // A single note downloads as Markdown from its page.
  await page.goto(`/knowledge/${folder}/notes.md`)
  const noteDownload = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download' }).click()
  const note = await noteDownload
  expect(note.suggestedFilename()).toBe('notes.md')
  expect(fs.readFileSync(await note.path(), 'utf8')).toBe('# Notes\n\nCafé ☕\n')
})

test('the whole vault shows its size first', async ({ page }) => {
  await page.goto('/knowledge')
  await page.getByRole('button', { name: 'Export Knowledge' }).click({ timeout: 15_000 })
  const dialog = page.getByRole('dialog', { name: 'Export all of Knowledge' })
  await expect(dialog.getByText(/\d+ files?, .* before compression/)).toBeVisible()
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download zip' }).click()
  expect((await download).suggestedFilename()).toMatch(/^knowledge-vault-/)
  await expect(dialog).toBeHidden()
})
