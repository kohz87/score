import { expect, test, type Page } from '@playwright/test'
import type { MockTheme } from './themes-fixtures.ts'
import { layoutThemes as t, openWithTheme } from './themes-layout-fixtures.ts'

// Baselines for the layout model (PLAN 9.3): every option of a theme manifest, from the mocked themes of
// themes-layout-fixtures.ts on the frozen visual data, in light, dark and at phone width where it matters. The
// default look's baselines (visual.spec.ts, packs-visual.spec.ts, ...) are untouched by this file.

type Variant = 'light' | 'dark' | 'phone'
const widths: Record<Variant, number> = { light: 1440, dark: 1440, phone: 390 }
const all: Variant[] = ['light', 'dark', 'phone']

type Shot = {
  name: string
  theme: MockTheme
  path: string
  ready: string
  variants: Variant[]
  /** Extra steps before the picture (open the drawer, scroll the thread). */
  prepare?: (page: Page, variant: Variant) => Promise<void>
  /** The picture is the window, not the whole page (a drawer is fixed to it). */
  viewportOnly?: boolean
}

const now = { path: '/now', ready: '.now-score' }
const chat = { path: '/chat/room-activity-feed', ready: '.chat-message' }
const user = { path: '/u/rooms/room-activity-feed', ready: '.chat-message' }

/** The thread opens at its end, where the exact offset moves by a pixel: pin it to the top. */
async function scrollTop(page: Page) {
  await page.locator('.chat-scroll').evaluate((el) => (el.scrollTop = 0))
}
async function chatTop(page: Page, variant: Variant) {
  if (variant === 'phone') await page.getByRole('button', { name: 'Show room details' }).click()
  await scrollTop(page)
}

const shots: Shot[] = [
  { name: 'nav-left', theme: t.navLeft, ...now, variants: all },
  { name: 'nav-right', theme: t.navRight, ...now, variants: ['light', 'phone'] },
  { name: 'nav-launcher', theme: t.navLauncher, ...now, variants: ['light', 'phone'] },
  {
    name: 'nav-launcher-open',
    theme: t.navLauncher,
    ...now,
    variants: ['light', 'dark'],
    viewportOnly: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Menu' }).click()
      await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible()
    },
  },
  { name: 'menu', theme: t.menu, ...now, variants: ['light', 'phone'] },
  { name: 'width-narrow', theme: t.narrow, ...now, variants: ['light'] },
  { name: 'width-full', theme: t.full, ...now, variants: ['light'] },
  { name: 'now-grid', theme: t.nowGrid, ...now, variants: all },
  { name: 'now-no-ask', theme: t.nowNoAsk, ...now, variants: ['light'] },
  { name: 'chat-bubbles', theme: t.bubbles, ...chat, variants: all, prepare: chatTop },
  { name: 'chat-rooms-right', theme: t.roomsRight, ...chat, variants: ['light'], prepare: chatTop },
  {
    name: 'chat-rooms-hidden',
    theme: t.roomsHidden,
    ...chat,
    variants: ['light'],
    prepare: chatTop,
  },
  {
    name: 'chat-rooms-hidden-open',
    theme: t.roomsHidden,
    ...chat,
    variants: ['light'],
    viewportOnly: true,
    prepare: async (page) => {
      await scrollTop(page)
      await page.getByRole('button', { name: 'Rooms' }).click()
      await expect(page.getByRole('dialog', { name: 'Rooms' })).toBeVisible()
    },
  },
  { name: 'compact-sharp', theme: t.compactSharp, ...now, variants: all },
  { name: 'airy-round', theme: t.airyRound, ...now, variants: ['light', 'phone'] },
  { name: 'px-radius', theme: t.pxRadius, ...now, variants: ['light'] },
  { name: 'glass-cover', theme: t.glassCover, ...now, variants: all },
  {
    name: 'glass-cover-chat',
    theme: t.glassCover,
    ...chat,
    variants: ['light', 'dark'],
    prepare: chatTop,
  },
  { name: 'glass-tile', theme: t.glassTile, ...now, variants: ['light'] },
  { name: 'harbour-now', theme: t.harbour, ...now, variants: all },
  { name: 'harbour-user', theme: t.harbour, ...user, variants: all, prepare: scrollTop },
]

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

for (const shot of shots) {
  for (const variant of shot.variants) {
    test(`${shot.name}, ${variant}`, async ({ page }) => {
      const mode = variant === 'dark' ? 'dark' : 'light'
      await page.setViewportSize({ width: widths[variant], height: 1100 })
      await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
      // The room stage's members wander when Lively: a Chat shot needs them where they start.
      if (shot.path.startsWith('/chat')) await page.emulateMedia({ reducedMotion: 'reduce' })
      await openWithTheme(page, [shot.theme], { active: shot.theme.id, mode })
      await page.goto(shot.path)
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await expect(page.locator(shot.ready).first()).toBeVisible()
      await expect(page.getByText(/^Loading/)).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.locator('html[data-motion]')).toHaveCount(0)
      // The first page of a cold browser settles a beat later (late font weights): wait for a steady height.
      await expect
        .poll(async () => {
          const first = await page.evaluate(() => document.documentElement.scrollHeight)
          await page.waitForTimeout(150)
          return first === (await page.evaluate(() => document.documentElement.scrollHeight))
        })
        .toBe(true)
      await shot.prepare?.(page, variant)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1)
      await expect(page).toHaveScreenshot(`layout-${shot.name}-${variant}.png`, {
        fullPage: !shot.viewportOnly,
        animations: 'disabled',
        maxDiffPixelRatio: 0.005,
      })
    })
  }
}
