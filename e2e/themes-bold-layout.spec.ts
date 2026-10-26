import { expect, test, type Page } from '@playwright/test'
import { openBoldRoomWith } from './bold-room-fixtures.ts'
import { samplePng } from './png.ts'
import { layoutThemes as t } from './themes-layout-fixtures.ts'
import { mockThemes, type MockTheme } from './themes-fixtures.ts'

// Ported from themes-layout.spec.ts (PLAN 9.3): the shape and background options of a theme manifest on the new shell.
// The classic navigation, menu, content-width and chat-layout options went with the classic shell (decisions 131/132).
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

async function wear(page: Page, theme: MockTheme, mode: 'light' | 'dark' = 'dark') {
  await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
  await openBoldRoomWith(page, {}, async (frame) => {
    await mockThemes(frame, [theme], { active: theme.id, mode })
    await frame.route('**/api/themes/*/assets/**', (route) =>
      route.fulfill({ body: samplePng(960, 640), contentType: 'image/png' }),
    )
  })
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await expect(page.locator('[data-ui="bold"]')).toBeVisible()
}
const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property)

test.describe('background', () => {
  test('the picture is the page background, fitted to cover under its veil', async ({ page }) => {
    const assets: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/assets/')) assets.push(new URL(request.url()).pathname)
    })
    await wear(page, t.glassCover)
    expect(await style(page, 'body', 'background-image')).toContain(
      '/api/themes/glass-cover/assets/img/bg.png',
    )
    expect(await style(page, 'body', 'background-size')).toContain('cover')
    expect(assets).toContain('/api/themes/glass-cover/assets/img/bg.png')
  })

  test('tile repeats the picture and the dim veil is part of it', async ({ page }) => {
    await wear(page, t.glassTile)
    expect(await style(page, 'body', 'background-repeat')).toContain('repeat')
    expect(await style(page, 'body', 'background-size')).toContain('auto')
    expect(await style(page, 'body', 'background-image')).toContain('linear-gradient')
  })

  test('a protected card keeps a solid background in front of the picture', async ({ page }) => {
    await wear(page, t.glassCover)
    const ask = page.locator('[data-ui="bold"] .bold-request').first()
    await expect(ask).toBeVisible()
    const paint = await ask.evaluate((el) => {
      const style = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return {
        image: style.backgroundImage,
        blur: style.backdropFilter,
        opaque: !/\/ 0\.\d+\)$|, 0\.\d+\)$/.test(style.backgroundColor),
        onTop: !!top && el.contains(top),
      }
    })
    expect(paint).toEqual({ image: 'none', blur: 'none', opaque: true, onTop: true })
  })

  test('a surface that holds a protected element without its own background stays solid', async ({
    page,
  }) => {
    await wear(page, t.glassCover)
    await page.goto('/b/team/builder')
    await expect(page.locator('.bold-agent')).toBeVisible()
    const holders = await page.evaluate(() =>
      [...document.querySelectorAll('[data-protected]:not(.agent-glyph):not(.needs-you-dot)')].map(
        (el) => {
          for (let node: Element | null = el.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (style.backdropFilter !== 'none') return { blurred: true }
          }
          return { blurred: false }
        },
      ),
    )
    for (const holder of holders) expect(holder.blurred).toBe(false)
  })
})

test.describe('old themes still load', () => {
  test('layout.now and /now or /tasks menu paths are accepted by the new shell', async ({
    page,
  }) => {
    await wear(page, t.legacy)
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' }).first()).toContainText('Team')
  })

  test('the boot cache holds the resolved look', async ({ page }) => {
    await wear(page, t.harbour)
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('score.look.cache')!))
    expect(cache.attributes['data-radius']).toBe('round')
  })
})
