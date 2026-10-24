import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'

// PLAN 11.9d: the seven built-in themes (Score and the six packaged in apps/server/themes), served as the server would
// answer for them, so the specs show what ships on the bold shell.
export const boldThemeIds = [
  'score',
  'paper',
  'night',
  'dense',
  'harbour',
  'ledger',
  'studio',
] as const
export type BoldThemeId = (typeof boldThemeIds)[number]

const root = join(import.meta.dirname, '../apps/server/themes')
const types: Record<string, string> = {
  png: 'image/png',
  woff2: 'font/woff2',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

function packaged(id: Exclude<BoldThemeId, 'score'>): MockTheme {
  const manifest = JSON.parse(readFileSync(join(root, id, 'theme.json'), 'utf8')) as {
    name: string
  } & Record<string, unknown>
  let css = ''
  try {
    css = readFileSync(join(root, id, 'style.css'), 'utf8')
  } catch {
    // Night shift has no stylesheet of its own.
  }
  return { id, name: manifest.name, source: 'builtin', manifest, css }
}

/** Answers the theme routes with `id` active in `mode`; the packaged themes' own files stand behind their asset URLs. */
export async function wearBuiltin(page: Page, id: BoldThemeId, mode: 'light' | 'dark') {
  const look: Look = { active: id, mode }
  const themes = (['harbour', 'ledger', 'studio'] as const).map(packaged)
  // Paper, Night shift and Dense are packs the app itself carries: the list only names them.
  await mockThemes(page, themes, look)
  for (const theme of themes) {
    await page.route(`**/api/themes/${theme.id}/assets/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        `/api/themes/${theme.id}/assets/`,
        '',
      )
      await route.fulfill({
        body: readFileSync(join(root, theme.id, 'assets', path)),
        contentType: types[path.slice(path.lastIndexOf('.') + 1)],
      })
    })
  }
  return look
}

/** A theme's colour for a mode, as the page resolves it (a pack's colours come from the manifest of the same name). */
export function themeColour(
  id: Exclude<BoldThemeId, 'score'>,
  mode: 'light' | 'dark',
  token: string,
) {
  const manifest = JSON.parse(readFileSync(join(root, id, 'theme.json'), 'utf8')) as {
    colors: Record<string, Record<string, string>>
  }
  return manifest.colors[mode]![token]!
}

/** `#rrggbb` as the `rgb(r, g, b)` a computed style reports. */
export function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `rgb(${n(0)}, ${n(1)}, ${n(2)})`
}
