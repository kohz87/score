import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'

export const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const

export const unique = () =>
  `lib-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
export const editor = (page: Page, path: string) => page.getByLabel(`Contents of ${path}`)

export function setupLibraryEditor() {
  test.use({ reducedMotion: 'reduce' })
  test.beforeEach(async ({ page }) => {
    await pair(page)
  })
}

export async function openLibrary(page: Page, size: (typeof sizes)[number] = sizes[0]) {
  await page.setViewportSize({ width: size.width, height: size.height })
  // The Library needs the width: a folded chat list (3.21.0) gives it back.
  await page.addInitScript(() => localStorage.setItem('score.chats.folded', '1'))
  // 3.22.0: the Library side-panel mode is gone; the same editor is the Knowledge page.
  await page.goto('/b/knowledge')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
  await expect(page.getByTestId('bold-library')).toBeVisible()
}

export async function createNote(page: Page, name: string, text: string) {
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

export const noteBody = async (page: Page, path: string) =>
  (
    (await (await page.request.get(`/api/knowledge/notes/${path}`)).json()) as {
      body: string
    }
  ).body

export async function showFiles(page: Page) {
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible()
}

export async function noPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)
}

/** Reads a zip through its central directory (stored or deflated entries). */
export function readZip(file: string): Record<string, string> {
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
