import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

export const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

export const unique = () =>
  `bold-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
export const editor = (page: Page, path: string) => page.getByLabel(`Contents of ${path}`)
export const noteButton = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Library notes' })
    .getByRole('button', { name: new RegExp(`^${name}`) })

export function setupLibrary() {
  test.beforeEach(async ({ page }) => {
    await pair(page)
  })
}

export async function openLibrary(page: Page, size: (typeof sizes)[number]) {
  await page.setViewportSize({ width: size.width, height: size.height })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // 3.22.0: the Library side-panel mode is gone; the same editor is the Knowledge page.
  await page.goto('/b/knowledge')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  await expect(page.getByTestId('bold-library')).toBeVisible()
}

export async function createNote(page: Page, name: string, text: string) {
  // 3.22.0: on a phone the Knowledge page shows the list or one note; "New note" is on the list.
  const back = page.getByRole('button', { name: /Back to the notes/ })
  if (await back.isVisible()) await back.click()
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

/** 3.8.1: on a phone the notes list folds while a note is open; this opens it again (nothing to do when it's open). */
export async function unfold(page: Page) {
  const fold = page.getByRole('button', { name: /^Notes and files/ })
  if (await fold.isVisible()) await fold.click()
  // 3.22.0: on the Knowledge page a phone shows the list or the note; the back link returns to the list.
  const back = page.getByRole('button', { name: /Back to the notes/ })
  const inFiles = await page.getByRole('heading', { name: 'Files' }).isVisible()
  if (!inFiles && (await back.isVisible())) await back.click()
}

export async function showFiles(page: Page) {
  await unfold(page)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible()
}

export function readZip(file: string): Record<string, string> {
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
