import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

// Theme packs (PLAN 8.3): the picker switches live, the choice survives a reload, and the side layout keeps the same
// links in the same order and falls back to the top bar on a phone.
test('Settings › Look › Style: a pack applies live, survives a reload and the side rail keeps the same links', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/settings')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-pack', 'score')
  await expect(html).toHaveAttribute('data-layout', 'top')
  const nav = page.getByRole('navigation', { name: 'Main' })
  const links = await nav.getByRole('link').allInnerTexts()
  expect(links.map((text) => text.trim())).toEqual([
    'Now',
    'Chat',
    'Tasks',
    'Team',
    'Knowledge',
    'Reports',
    'Settings',
  ])

  const region = page.getByRole('region', { name: 'Look' })
  await region.getByRole('button', { name: 'Style: Score' }).click()
  const styles = region.getByRole('radiogroup', { name: 'Style' })
  await styles.getByRole('radio', { name: /Night shift/ }).click()
  await expect(html).toHaveAttribute('data-pack', 'night')
  await expect(html).toHaveAttribute('data-layout', 'side')
  expect(await nav.getByRole('link').allInnerTexts()).toEqual(links)
  // The rail sits at the left, the page content to its right.
  const railBox = (await page.locator('.top-bar').boundingBox())!
  const contentBox = (await page.locator('.page-content').boundingBox())!
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(contentBox.x)
  // The same links are reachable by keyboard and still navigate.
  await nav.getByRole('link', { name: 'Chat' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/chat/)

  await page.reload()
  await expect(html).toHaveAttribute('data-pack', 'night')
  await expect(html).toHaveAttribute('data-layout', 'side')

  // A phone gets today's top bar and the menu button, whatever the pack.
  await page.setViewportSize({ width: 390, height: 800 })
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  await expect(nav).toBeHidden()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/settings')
  await page
    .getByRole('region', { name: 'Look' })
    .getByRole('button', { name: /^Style:/ })
    .click()
  await page.getByRole('radio', { name: /^Score/ }).click()
  await expect(html).toHaveAttribute('data-pack', 'score')
  await page.reload()
  await expect(html).toHaveAttribute('data-layout', 'top')
})

test('the saved pack is applied before the app starts (no flash of the default look)', async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem(
      'score.look',
      JSON.stringify({ pack: 'paper', layout: 'top', density: 'comfortable' }),
    ),
  )
  await page.route('**/assets/*.js', (route) => route.abort())
  await page.goto('/pair')
  await expect(page.locator('html')).toHaveAttribute('data-pack', 'paper')
})
