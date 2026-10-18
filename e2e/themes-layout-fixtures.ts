import { expect, type Page } from '@playwright/test'
import { fixtureNow } from './now-fixture.ts'
import { samplePng } from './png.ts'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { visualFixtures, visualHello } from './visual-fixtures.ts'

// Mocked theme manifests for the layout model (PLAN 9.3), served on top of the 9.2 visual fixture: every option of
// `layout`, `shape` and `background` has a theme here, so the specs (and the baselines) exercise it in the real app.

/** The frozen API of the visual specs (clock, REST and stream), plus the theme routes for `themes`. */
export async function openWithTheme(
  page: Page,
  themes: MockTheme[],
  look: Look,
  options: { assets?: boolean } = {},
): Promise<void> {
  await page.clock.setFixedTime(new Date(fixtureNow))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/stream') {
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`,
      })
      return
    }
    url.searchParams.delete('tz')
    const key = `${url.pathname}${url.search}`
    const fixture = visualFixtures[key]
    expect(fixture, `Missing visual fixture: ${key}`).toBeDefined()
    await route.fulfill({ json: fixture })
  })
  // Later routes win: the theme routes answer before the generic one.
  await mockThemes(page, themes, look)
  if (options.assets !== false) {
    // Theme assets are served by Score; here a fixed picture stands in.
    const picture = samplePng(960, 640)
    await page.route('**/api/themes/*/assets/**', (route) =>
      route.fulfill({ body: picture, contentType: 'image/png' }),
    )
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
}

export const theme = (id: string, manifest: Record<string, unknown>, css = ''): MockTheme => ({
  id,
  name: id,
  source: 'custom',
  manifest,
  css,
})

const nav = (value: 'top' | 'left' | 'right' | 'launcher') => ({ layout: { nav: value } })

/** One theme per option, so a failure names the option. */
export const layoutThemes = {
  navTop: theme('nav-top', nav('top')),
  navLeft: theme('nav-left', nav('left')),
  navRight: theme('nav-right', nav('right')),
  navLauncher: theme('nav-launcher', nav('launcher')),
  menu: theme('menu', {
    layout: {
      menu: [
        { to: '/chat', label: 'Talk' },
        { to: '/now', label: 'Today' },
        { to: '/tasks' },
        { to: '/reports', label: 'Numbers' },
      ],
    },
  }),
  narrow: theme('narrow', { layout: { contentWidth: 'narrow' } }),
  full: theme('full', { layout: { contentWidth: 'full' } }),
  nowGrid: theme('now-grid', {
    layout: {
      now: {
        columns: 2,
        cards: [
          { card: 'room', span: 2 },
          { card: 'made-today', span: 1 },
          { card: 'needs-you', span: 1 },
          { card: 'timeline', span: 2 },
          { card: 'composer', span: 2 },
        ],
      },
    },
  }),
  /** No needs-you card listed: Score adds it. */
  nowNoAsk: theme('now-no-ask', {
    layout: {
      now: {
        columns: 3,
        cards: [
          { card: 'timeline', span: 3 },
          { card: 'room', span: 2 },
          { card: 'made-today', span: 1 },
        ],
      },
    },
  }),
  bubbles: theme('bubbles', {
    colors: {
      light: { 'bubble-own': '#2f5d50', 'bubble-own-ink': '#ffffff' },
      dark: { 'bubble-own': '#2f5d50', 'bubble-own-ink': '#ffffff' },
    },
    layout: { chat: { messages: 'bubbles' } },
  }),
  roomsRight: theme('rooms-right', { layout: { chat: { roomList: 'right' } } }),
  roomsHidden: theme('rooms-hidden', { layout: { chat: { roomList: 'hidden-until-opened' } } }),
  compactSharp: theme('compact-sharp', {
    shape: {
      radius: 'sharp',
      density: 'compact',
      border: 'strong',
      elevation: 'flat',
      surface: 'solid',
    },
  }),
  airyRound: theme('airy-round', {
    shape: {
      radius: 'round',
      density: 'airy',
      border: 'none',
      elevation: 'floating',
      surface: 'solid',
    },
  }),
  pxRadius: theme('px-radius', { shape: { radius: 18, border: 'hairline', elevation: 'raised' } }),
  glassCover: theme('glass-cover', {
    colors: { light: { ground: '#dfe6f0' }, dark: { ground: '#10151c' } },
    shape: { surface: 'glass', border: 'hairline', elevation: 'raised', radius: 'soft' },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 20 },
  }),
  glassTile: theme('glass-tile', {
    shape: { surface: 'glass', elevation: 'floating' },
    background: { image: 'asset:img/bg.png', fit: 'tile', dim: 40 },
  }),
  /** Everything at once, with the user view overriding some of it. */
  harbour: theme('harbour', {
    colors: { light: { 'bubble-own': '#1f4e79', 'bubble-own-ink': '#ffffff' } },
    shape: { surface: 'glass', elevation: 'raised', border: 'hairline', radius: 'round' },
    layout: {
      nav: 'left',
      contentWidth: 'wide',
      chat: { messages: 'bubbles', roomList: 'left' },
    },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 30 },
    views: {
      user: {
        shape: { radius: 'sharp', surface: 'solid' },
        layout: { contentWidth: 'narrow', chat: { roomList: 'right' } },
        background: { image: 'asset:img/bg.png', fit: 'cover', dim: 55 },
      },
    },
  }),
}
