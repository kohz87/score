import { expect, test } from '@playwright/test'

// Anchored: an unanchored title can also match another link that starts with the same letters.
const navName = (title: string) => new RegExp(`^${title}\\b`)

const destinations = [
  ['/chat', 'Chat'],
  ['/team', 'Team'],
  ['/knowledge', 'Knowledge'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
] as const

for (const [path, title] of destinations) {
  test(`${title} loads with bundled fonts and all requests stay on 127.0.0.1`, async ({ page }) => {
    const external: string[] = []
    const fonts: string[] = []
    page.on('request', (request) => {
      // Only addresses that go over the network: `blob:` and `data:` URLs never leave the page.
      const url = new URL(request.url())
      if (/^(https?|wss?):$/.test(url.protocol) && url.hostname !== '127.0.0.1')
        external.push(request.url())
      if (request.resourceType() === 'font') fonts.push(request.url())
    })
    await page.goto(path)
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: navName(title) }),
    ).toHaveAttribute('aria-current', 'page')
    await page.evaluate(() => document.fonts.ready)
    expect(fonts.length).toBeGreaterThan(0)
    expect(external).toEqual([])
  })
}

test('each main nav link navigates and the root redirects to the new shell', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL('/b')
  await page.goto('/chat')
  const nav = page.getByRole('navigation', { name: 'Main' })
  for (const [path, title] of destinations) {
    await nav.getByRole('link', { name: navName(title) }).click()
    await expect(page).toHaveURL(path === '/settings' ? '/settings/models' : path)
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
    await expect(nav.getByRole('link', { name: navName(title) })).toHaveAttribute(
      'aria-current',
      'page',
    )
  }
})

test('Ctrl+K opens the palette, traps focus, navigates and returns focus', async ({ page }) => {
  await page.goto('/chat')
  const trigger = page.getByRole('button', { name: /Search or run a command/ })
  // The shortcut listener is registered in an effect after first paint; wait for the app to render.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Search or run a command' })
  const input = dialog.getByRole('searchbox', { name: 'Search destinations' })
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Close command palette' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  // The last entry is the last Settings section (PLAN 10.1).
  await expect(dialog.getByRole('link').last()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close command palette' })).toBeFocused()
  await input.fill('Reports')
  await input.press('Enter')
  await expect(page).toHaveURL('/reports')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(input).toBeFocused()
  await input.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

for (const width of [360, 719]) {
  test(`the ${width}px header folds its nav into the menu without overflowing the page`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/chat')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL('/settings/models')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  })
}

for (const status of [204, 401]) {
  test(`pairing clears its token from the URL and handles ${status}`, async ({ page }) => {
    let requests = 0
    await page.route('**/api/session/pair', async (route) => {
      requests += 1
      expect(route.request().postDataJSON()).toEqual({ token: 'example-token' })
      expect(route.request().headers()['x-score-client']).toBe('web')
      expect(await page.evaluate(() => location.hash)).toBe('')
      await route.fulfill(
        status === 204
          ? { status }
          : { status, json: { error: { code: 'not_paired', message: 'Invalid token' } } },
      )
    })
    await page.goto('/pair#example-token')
    await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible()
    await expect(page.getByRole('status')).toContainText(
      status === 204 ? 'This browser is paired' : 'invalid or expired',
    )
    await expect(page).toHaveURL('/pair')
    expect(requests).toBe(1)
    await page.reload()
    await expect(page.getByRole('status')).toContainText('server terminal at startup')
    expect(requests).toBe(1)
  })
}
