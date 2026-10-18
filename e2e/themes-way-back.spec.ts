import { expect, test } from '@playwright/test'
import { ACCEPTED_TOKEN, custom, dropped, wear } from './themes-consent-helpers.ts'

// Cross-audit of v1.8.0 (K1, X7 and X15): the ways back from a theme, in Chromium with theme CSS the sanitiser accepts.

// ---------------------------------------------------------------------------------------------------------------------
// X15: a reset made on this page survives a late theme list

test.describe('X15: the way back survives a slow theme list', () => {
  test('Ctrl+Shift+0 pressed before GET /api/themes lands is not undone by it', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const look = await wear(page, ACCEPTED_TOKEN, {
      active: 'gate',
      mode: 'light',
      resetGeneration: 0,
    })
    await page.goto('/now')
    await custom(page)
    // This device has never seen a reset; the host has reset once since (generation 1), and the list is slow.
    look.resetGeneration = 1
    await page.evaluate(() => window.localStorage.removeItem('score.look.generation'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    await page.route(
      (url) => url.pathname === '/api/themes',
      async (route) => {
        await gate
        await route.fallback()
      },
    )
    await page.goto('/now')
    await expect(page.locator('main')).toBeVisible()
    await page.keyboard.press('Control+Shift+Digit0')
    await dropped(page)
    release()
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('score.look.generation')))
      .toBe('1')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    expect(await page.evaluate(() => window.localStorage.getItem('score.look.device'))).toBe(
      'score',
    )
  })

  test('the chat-first way back is on the page before the list arrives', async ({ page }) => {
    test.setTimeout(90_000)
    await wear(page)
    await page.goto('/u')
    await custom(page)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    await page.route(
      (url) => url.pathname === '/api/themes',
      async (route) => {
        await gate
        await route.fallback()
      },
    )
    await page.goto('/u')
    await custom(page)
    // The boot cache put the custom look on the page; the list has not answered.
    await expect(page.getByRole('navigation', { name: 'Way back' })).toBeVisible()
    release()
  })
})
