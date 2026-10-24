import { expect, test, type Page } from '@playwright/test'
import { openPackagedTheme, packagedThemeIds } from './themes-builtin-fixtures.ts'

// Baselines for the built-in themes of PLAN 9.5 (Harbour, Ledger, Studio), from the shipped theme files on the frozen
// visual data: Now, Chat, Settings and the chat-first user view, in light, dark and at phone width.
type Variant = 'light' | 'dark' | 'phone'
const widths: Record<Variant, number> = { light: 1440, dark: 1440, phone: 390 }
const variants: Variant[] = ['light', 'dark', 'phone']

const pages = [
  { name: 'now', path: '/now', ready: '.now-score' },
  { name: 'chat', path: '/chat/room-activity-feed', ready: '.chat-message' },
  { name: 'settings', path: '/settings/rules', ready: '.rules-columns' },
  { name: 'user', path: '/u/rooms/room-activity-feed', ready: '.chat-message' },
] as const

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

/** The thread opens at its end, where the offset moves by a pixel: pin it to the top. */
async function pinThread(page: Page) {
  await page
    .locator('.chat-scroll')
    .first()
    .evaluate((el) => (el.scrollTop = 0))
}

for (const id of packagedThemeIds) {
  for (const target of pages) {
    for (const variant of variants) {
      test(`${id} ${target.name}, ${variant}`, async ({ page }) => {
        const mode = variant === 'dark' ? 'dark' : 'light'
        await page.setViewportSize({ width: widths[variant], height: 1100 })
        await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
        // The room stage's members animate: a Chat shot needs them where they start.
        if (target.name === 'chat') await page.emulateMedia({ reducedMotion: 'reduce' })
        await openPackagedTheme(page, id, mode)
        await page.goto(target.path)
        if (target.name === 'chat' && variant === 'phone')
          await page.getByRole('button', { name: 'Show room details' }).click()
        await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
        await expect(page.locator(target.ready).first()).toBeVisible()
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
        if (target.name === 'chat' || target.name === 'user') await pinThread(page)
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
        ).toBeLessThanOrEqual(1)
        await expect(page).toHaveScreenshot(`builtin-${id}-${target.name}-${variant}.png`, {
          fullPage: true,
          animations: 'disabled',
          maxDiffPixelRatio: 0.005,
        })
      })
    }
  }
}
