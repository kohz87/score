import { expect, test } from '@playwright/test'
import { mockThemes, tidyTheme, type Look } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { visualHello } from './visual-fixtures.ts'

test.describe('shared and per-device looks', () => {
  test('a device can pick its own theme, and "Use the shared theme" goes back', async ({
    page,
  }) => {
    const look: Look = { active: 'tidy', mode: 'light' }
    await mockThemes(page, [tidyTheme], look)
    await pair(page)
    await page.goto('/b/settings/look')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-look', 'custom')
    const styles = page.getByRole('radiogroup', { name: 'Style on this device' })
    await expect(styles.getByRole('radio', { name: 'Tidy' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await styles.getByRole('radio', { name: 'Night shift' }).click()
    await expect(html).toHaveAttribute('data-pack', 'night')
    await expect(html).not.toHaveAttribute('data-look', 'custom')
    await expect(
      page.getByText(/This device uses Night shift instead of the shared Tidy/),
    ).toBeVisible()
    await page.reload()
    await expect(html).toHaveAttribute('data-pack', 'night')
    await page.getByRole('button', { name: 'Use the shared theme' }).click()
    await expect(html).toHaveAttribute('data-look', 'custom')
    await expect(html).toHaveAttribute('data-pack', 'score')
  })

  test('"Theme for every device" saves through PUT /api/look', async ({ page }) => {
    const look: Look = { active: 'score', mode: 'system' }
    const puts = await mockThemes(page, [tidyTheme], look)
    await pair(page)
    await page.goto('/b/settings/look')
    await page.getByLabel('Theme for every device').selectOption('tidy')
    await page.getByLabel('Colours for every device').selectOption('dark')
    await page.getByRole('button', { name: 'Save for every device' }).click()
    await expect.poll(() => puts.length).toBe(1)
    expect(puts[0]).toEqual({ activeTheme: 'tidy', mode: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('look.changed on the stream switches an open page', async ({ page }) => {
    const look: Look = { active: 'score', mode: 'system' }
    await mockThemes(page, [tidyTheme], look)
    let announce = false
    await page.route('**/api/stream**', async (route) => {
      const hello = `event: stream.hello\ndata: ${JSON.stringify(visualHello)}\n\n`
      const changed = `event: look.changed\nid: 2\ndata: ${JSON.stringify({
        seq: 2,
        ts: '2026-10-17T00:00:00.000Z',
        type: 'look.changed',
        data: { activeTheme: 'tidy', mode: 'system' },
      })}\n\n`
      await route.fulfill({
        contentType: 'text/event-stream',
        body: announce ? hello + changed : hello,
      })
    })
    await pair(page)
    await page.goto('/b?open=1')
    await expect(page.locator('html')).toHaveAttribute('data-pack', 'score')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    // Another device saved a new shared theme.
    look.active = 'tidy'
    announce = true
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom', { timeout: 20_000 })
  })

  test('the saved look is painted before the app starts', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'score.look.cache',
        JSON.stringify({
          id: 'tidy',
          attributes: {
            'data-pack': 'score',
            'data-layout': 'top',
            'data-density': 'comfortable',
            'data-look': 'custom',
            'data-radius': 'round',
          },
          css: ":root:root[data-look='custom'][data-theme='light']{--ground:#e8f0e8;}",
        }),
      )
      localStorage.setItem('score.theme', 'light')
    })
    await page.route('**/assets/*.js', (route) => route.abort())
    await page.goto('/pair')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(232, 240, 232)',
    )
    // Safe mode skips the cache.
    await page.goto('/pair?look=safe')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })
})
