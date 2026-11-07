import { expect, type Page } from '@playwright/test'
import { makePng } from './png.ts'

// Shared setup for the theme Customizer specs. Themes made by a spec are deleted at the end so other specs see the same
// list as before.

export const web = { 'x-score-client': 'web' }
export const made = new Set<string>()

export async function cleanUp(page: Page) {
  for (const id of made) await page.request.delete(`/api/themes/${id}`, { headers: web })
  made.clear()
}

export const frame = (page: Page) => page.frameLocator('iframe[title="Preview of your theme"]')
export const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

export async function openCustomizer(page: Page, path = '/settings/look/customize') {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Customizer' })).toBeVisible()
  await expect(frame(page).locator('[data-ui="bold"]')).toBeVisible({ timeout: 30_000 })
}

export const busyPicture = () =>
  makePng(120, 80, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [255, 255, 255] : [20, 20, 90]))

export const importZip = (page: Page, zip: Uint8Array, query = '') =>
  page.request.post(`/api/themes/import${query}`, {
    headers: web,
    multipart: {
      file: { name: 'theme.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) },
    },
  })
const textOf = (value: string) => new TextEncoder().encode(value)
export const manifestOf = (id: string, name: string, extra: object = {}) =>
  textOf(JSON.stringify({ format: 1, id, name, version: '1.0.0', ...extra }))

// J1 (fourth-gate finding 2): file URLs name the package revision, and a copy is one snapshot of it.
const snapManifest = (id: string, name: string) => ({
  format: 1,
  id,
  name,
  version: '1.0.0',
  background: { image: 'asset:img/b.png', fit: 'cover', dim: 0 },
})
export async function putSnap(
  page: Page,
  id: string,
  name: string,
  etag: string | null,
  picture: Buffer,
) {
  const res = await page.request.put(`/api/themes/${id}`, {
    headers: web,
    data: {
      manifest: snapManifest(id, name),
      css: '',
      etag,
      assets: { 'img/b.png': picture.toString('base64') },
      licenses: { LICENSE: `licence of ${name}` },
    },
  })
  expect(res.status()).toBe(200)
  return (await res.json()) as { etag: string }
}
