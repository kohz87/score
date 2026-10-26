import type { Page, Route } from '@playwright/test'

// Mocks of contract § 16 (`/api/themes*`, `/api/look`): the server routes are built in parallel (PLAN 9.1), so the
// specs answer them here, exactly as the contract defines them. Shapes follow packages/contract/src/themes.ts.

export type MockTheme = {
  id: string
  name: string
  source?: 'builtin' | 'imported' | 'custom'
  manifest?: Record<string, unknown>
  css?: string
  /** The line under the name in the picker (the manifest's `description` on a real server). */
  description?: string
}
export type Look = {
  active: string
  mode: 'light' | 'dark' | 'system'
  /** Bumped by the host's `score look reset` (contract § 16); absent means 0. */
  resetGeneration?: number
}

const builtins: MockTheme[] = [
  { id: 'score', name: 'Score', source: 'builtin' },
  { id: 'paper', name: 'Paper', source: 'builtin' },
  { id: 'night', name: 'Night shift', source: 'builtin' },
  { id: 'dense', name: 'Dense', source: 'builtin' },
]

const summary = (theme: MockTheme) => ({
  id: theme.id,
  name: theme.name,
  version: '1.0.0',
  author: null,
  description: theme.description ?? null,
  source: theme.source ?? 'imported',
  updatedAt: '2026-10-17T00:00:00.000Z',
  hasCss: !!theme.css,
})

const detail = (theme: MockTheme) => ({
  summary: summary(theme),
  manifest: { format: 1, id: theme.id, name: theme.name, version: '1.0.0', ...theme.manifest },
  css: theme.css ?? '',
  assets: [],
  etag: `etag-${theme.id}`,
})

/** Answers GET /api/themes, GET /api/themes/:id and PUT /api/look. `look` is mutable: tests change it mid-run. */
export async function mockThemes(page: Page, themes: MockTheme[], look: Look) {
  const all = [...builtins, ...themes]
  const puts: unknown[] = []
  await page.route('**/api/themes**', async (route: Route) => {
    const url = new URL(route.request().url())
    const id = url.pathname.replace(/^\/api\/themes\/?/, '')
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405 })
    if (!id)
      return route.fulfill({
        json: {
          items: all.map(summary),
          active: look.active,
          mode: look.mode,
          resetGeneration: look.resetGeneration ?? 0,
        },
      })
    const theme = all.find((item) => item.id === id)
    if (!theme)
      return route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: 'No such theme.' } },
      })
    return route.fulfill({ json: detail(theme) })
  })
  await page.route('**/api/look', async (route: Route) => {
    if (route.request().method() !== 'PUT') return route.fulfill({ status: 405 })
    const body = route.request().postDataJSON() as { activeTheme: string; mode: Look['mode'] }
    puts.push(body)
    look.active = body.activeTheme
    look.mode = body.mode
    return route.fulfill({ status: 204 })
  })
  return puts
}

/**
 * A theme that tries everything the design (§ 4, § 10) worries about. Written as a theme author would, so the browser
 * sanitiser has to catch the dangerous parts; the rest is left for the protected layer and the guard.
 */
export const hostileCss = `
.bold-request::after { content: "Allow"; position: fixed; inset: 0; z-index: 9999; background: red; }
.bold-request button { opacity: 0 !important; display: none; }
.bold-request-head { visibility: hidden; }
main button { -webkit-text-fill-color: transparent; background-image: linear-gradient(#fff, #fff); }
.bold-needs { display: none !important; }
.bold-question, .bold-approval, [data-protected] { opacity: 0 !important; transform: scale(0); }
main { pointer-events: none; }
body { background: #ffe0e0; }
/* Pulling the top bar over the page is guardCss.coveringBar: it buries the Settings link, the guard switches it off. */
.top { z-index: 9999; background: red; }
`

export const hostileManifest = {
  colors: {
    light: {
      ground: '#ffe0e0',
      card: '#ffffff',
      ink: '#101010',
      'panel-ink': '#f1f1f1',
      'panel-card': '#ffffff',
    },
  },
  shape: { radius: 'sharp', elevation: 'floating', border: 'strong' },
}

/**
 * What CSS alone can't stop: the card faded, filtered or covered from outside, and tokens that wash its colours out. The
 * runtime guard notices and switches the theme off.
 */
export const guardCss = {
  coveringBar:
    '.top { position: absolute; inset: 0; z-index: 50; background: rgb(255 0 0 / 90%); }',
  fadedAncestor: '.main { opacity: 0.05; }',
  filteredAncestor: '.main { filter: blur(6px); }',
  washedOutTokens:
    ':root { --ink: #ffffff; --card: #ffffff; --panel-ink: #ffffff; --panel-card: #ffffff; --chat-text: #ffffff; }',
}

/**
 * Rules that name things inside a protected surface by tag or position. The engine keeps every theme rule out of
 * protected subtrees (G1 #3), so these change nothing there and the theme stays on.
 */
export const containedCss = {
  hiddenButton: 'main button { display: none; }',
  invisibleText: 'main button:not(#a):not(#b) { color: transparent; }',
  hiddenByStructure: 'article[aria-label^="Needs you:"] > div { display: none; }',
}

/** Something harmless, to switch to and from. */
export const tidyTheme: MockTheme = {
  id: 'tidy',
  name: 'Tidy',
  source: 'custom',
  manifest: {
    colors: { light: { ground: '#e8f0e8', card: '#fcfffc' }, dark: { ground: '#0c140c' } },
    shape: { radius: 'round' },
  },
  css: '.main { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }',
}
