import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { openWithTheme } from './themes-layout-fixtures.ts'
import type { MockTheme } from './themes-fixtures.ts'

// The packaged built-in themes of 9.5 (apps/server/themes/<id>), read from disk and served by mocked theme routes on
// the frozen visual data, exactly as the real server would answer for them: the baselines show the shipped files.
export const packagedThemeIds = ['harbour', 'ledger', 'studio'] as const
export type PackagedThemeId = (typeof packagedThemeIds)[number]

const root = join(import.meta.dirname, '../apps/server/themes')

export function packagedTheme(id: PackagedThemeId): MockTheme {
  const manifest = JSON.parse(readFileSync(join(root, id, 'theme.json'), 'utf8')) as {
    name: string
  } & Record<string, unknown>
  return {
    id,
    name: manifest.name,
    source: 'builtin',
    manifest,
    css: readFileSync(join(root, id, 'style.css'), 'utf8'),
  }
}

const types: Record<string, string> = {
  png: 'image/png',
  woff2: 'font/woff2',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

/** The frozen API of the visual specs, with a packaged theme active and its real asset files behind the asset URLs. */
export async function openPackagedTheme(
  page: Page,
  id: PackagedThemeId,
  mode: 'light' | 'dark',
): Promise<void> {
  await openWithTheme(page, [packagedTheme(id)], { active: id, mode }, { assets: false })
  await page.route(`**/api/themes/${id}/assets/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(`/api/themes/${id}/assets/`, '')
    const body = readFileSync(join(root, id, 'assets', path))
    await route.fulfill({ body, contentType: types[path.slice(path.lastIndexOf('.') + 1)] })
  })
}
