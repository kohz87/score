import { expect, test, type Page } from '@playwright/test'
import { layoutThemes, openWithTheme } from './themes-layout-fixtures.ts'
import type { MockTheme } from './themes-fixtures.ts'

// Screenshots for the 9.3 review (fake mode, mocked themes). Only runs when SCORE_UI_SHOTS_DIR names a folder.
const dir = process.env.SCORE_UI_SHOTS_DIR
test.skip(!dir, 'set SCORE_UI_SHOTS_DIR to take the review screenshots')
test.use({ timezoneId: 'UTC', locale: 'en-GB' })

async function shot(
  page: Page,
  name: string,
  theme: MockTheme,
  path: string,
  options: { width?: number; mode?: 'light' | 'dark'; after?: (page: Page) => Promise<void> } = {},
) {
  await page.setViewportSize({ width: options.width ?? 1440, height: 1000 })
  await page.addInitScript(
    (mode) => localStorage.setItem('score.theme', mode),
    options.mode ?? 'light',
  )
  await openWithTheme(page, [theme], { active: theme.id, mode: options.mode ?? 'light' })
  await page.goto(path)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await page.evaluate(() => document.fonts.ready)
  await options.after?.(page)
  if (path.startsWith('/chat'))
    await page
      .locator('.chat-scroll')
      .evaluate((el) => (el.scrollTop = 0))
      .catch(() => undefined)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
}

test('review screenshots', async ({ browser }) => {
  const t = layoutThemes
  const run = async (
    name: string,
    theme: MockTheme,
    path: string,
    options: Parameters<typeof shot>[4] = {},
  ) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await shot(page, name, theme, path, options)
    await context.close()
  }
  await run('nav-top', t.navTop, '/now')
  await run('nav-left', t.navLeft, '/now')
  await run('nav-right', t.navRight, '/now')
  await run('nav-launcher', t.navLauncher, '/now')
  await run('nav-launcher-open', t.navLauncher, '/now', {
    after: async (page) => {
      await page.getByRole('button', { name: 'Menu' }).click()
      await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible()
    },
  })
  await run('menu', t.menu, '/now')
  await run('chat-bubbles', t.bubbles, '/chat/room-activity-feed')
  await run('chat-bubbles-dark', t.bubbles, '/chat/room-activity-feed', { mode: 'dark' })
  await run('chat-rooms-right', t.roomsRight, '/chat/room-activity-feed')
  await run('chat-rooms-hidden', t.roomsHidden, '/chat/room-activity-feed')
  await run('now-grid', t.nowGrid, '/now')
  await run('now-no-ask', t.nowNoAsk, '/now')
  await run('width-narrow', t.narrow, '/now')
  await run('width-full', t.full, '/now')
  await run('glass-cover', t.glassCover, '/now')
  await run('glass-cover-chat', t.glassCover, '/chat/room-activity-feed')
  await run('glass-tile', t.glassTile, '/now')
  await run('compact-sharp', t.compactSharp, '/now')
  await run('airy-round', t.airyRound, '/now')
  await run('harbour-now', t.harbour, '/now')
  await run('harbour-user', t.harbour, '/u/rooms/room-activity-feed')
  await run('phone-launcher', t.navLauncher, '/now', { width: 390 })
  await run('phone-harbour', t.harbour, '/now', { width: 390 })
  await run('phone-bubbles', t.bubbles, '/chat/room-activity-feed', { width: 390 })
})
