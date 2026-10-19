import { expect, test } from '@playwright/test'
import { openPackagedTheme } from './themes-builtin-fixtures.ts'

// A side rail (left: Harbour, right: Studio) ends with one row: the terminal button and the avatar. The avatar's menu
// opens above that row and stays inside the rail, which scrolls and so cuts off anything wider (owner, 2026-10-19: the
// two buttons sat in one column and the menu's "System" choice was cut off).
test.use({ timezoneId: 'UTC', locale: 'en-GB' })

for (const theme of ['harbour', 'studio'] as const) {
  test(`${theme}: terminal and avatar share the rail's last row, and the avatar menu fits the rail`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    await openPackagedTheme(page, theme, 'light')
    // After the theme's own routes, so this answer wins: the terminal is on, as on a live server with SCORE_TERMINAL=1.
    await page.route('**/api/session/security', (route) =>
      route.fulfill({
        json: { passwordSet: false, origins: [], terminal: true, terminalUnavailable: null },
      }),
    )
    await page.goto('/now')
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'side')
    const terminal = page.locator('.top-bar-terminal')
    const avatar = page.locator('.avatar-menu > button').first()
    await expect(terminal).toBeVisible()
    const [t, a] = [(await terminal.boundingBox())!, (await avatar.boundingBox())!]
    expect(Math.abs(t.y - a.y)).toBeLessThanOrEqual(1)
    expect(a.x).toBeGreaterThan(t.x + t.width)

    await avatar.click()
    const popover = page.locator('.avatar-popover')
    await expect(popover).toBeVisible()
    const rail = (await page.locator('.top-bar').boundingBox())!
    const menu = (await popover.boundingBox())!
    expect(menu.x).toBeGreaterThanOrEqual(rail.x)
    expect(menu.x + menu.width).toBeLessThanOrEqual(rail.x + rail.width)
    expect(
      await page.locator('.top-bar').evaluate((bar) => bar.scrollWidth - bar.clientWidth),
    ).toBe(0)
    for (const name of ['Light', 'Dark', 'System']) {
      const choice = popover.getByRole('menuitemradio', { name })
      await expect(choice).toBeVisible()
      expect(await choice.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
  })
}
