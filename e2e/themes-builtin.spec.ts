import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { allowIt, isOnTop, startApproval } from './themes-decision.ts'

const packagedThemeIds = ['harbour', 'ledger', 'studio'] as const
type PackagedThemeId = (typeof packagedThemeIds)[number]

// The built-in themes of PLAN 9.5 (Harbour, Ledger, Studio) against the real fake-mode server: they are listed, they
// apply from Settings › Look with the settings of their manifest, their files load, and they keep every protected
// surface and every way back (design docs/briefs/9-themes.md § 4), like any imported theme. On the new shell (3.0.0) the
// protected card is the Needs-you card of the approval fixture; the theme routes stay the real server's.

const attributes: Record<PackagedThemeId, Record<string, string>> = {
  harbour: {
    'data-nav': 'left',
    'data-width': 'wide',
    'data-radius': 'round',
    'data-border': 'hairline',
    'data-elevation': 'raised',
    'data-surface': 'glass',
    'data-chat': 'bubbles',
    'data-density': 'comfortable',
    'data-backdrop': 'cover',
  },
  ledger: {
    'data-nav': 'launcher',
    'data-width': 'full',
    'data-radius': 'sharp',
    'data-border': 'hairline',
    'data-elevation': 'flat',
    'data-surface': 'solid',
    'data-density': 'compact',
  },
  studio: {
    'data-nav': 'right',
    'data-width': 'narrow',
    'data-radius': 'custom',
    'data-border': 'none',
    'data-elevation': 'floating',
    'data-density': 'airy',
    'data-rooms': 'hidden',
  },
}

/** Picks the theme for this device (the real server serves it); the caller pairs, directly or by opening the room. */
async function useTheme(page: Page, id: PackagedThemeId, mode: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ([theme, m]) => {
      localStorage.setItem('score.look.device', theme!)
      localStorage.setItem('score.theme', m!)
    },
    [id, mode],
  )
}

for (const id of packagedThemeIds) {
  test.describe(id, () => {
    test('is offered in Settings › Look and applies its manifest', async ({ page }) => {
      await pair(page)
      await page.goto('/b/settings/look')
      const styles = page.getByRole('radiogroup', { name: 'Style on this device' })
      for (const name of ['Score', 'Paper', 'Night shift', 'Dense', 'Harbour', 'Ledger', 'Studio'])
        await expect(styles.getByRole('radio', { name: new RegExp(name) })).toBeVisible()
      const radio = styles.locator(`[data-theme-choice="${id}"]`)
      await expect(radio).toContainText(/\w{4,}/)
      await radio.click()
      const html = page.locator('html')
      await expect(html).toHaveAttribute('data-look', 'custom')
      for (const [name, value] of Object.entries(attributes[id]))
        await expect(html, name).toHaveAttribute(name, value)
      await expect(page.locator('.look-banner')).toHaveCount(0)
      await expect(html).not.toHaveAttribute('data-contrast-fallback', '')
      // It survives a reload (the boot cache paints it before the app starts).
      await page.reload()
      await expect(html).toHaveAttribute('data-look', 'custom')
      await expect(html).toHaveAttribute('data-nav', attributes[id]['data-nav']!)
    })

    test('loads its own files (picture, fonts) from Score', async ({ page }) => {
      await useTheme(page, id)
      await pair(page)
      const files: { url: string; status: number; type: string }[] = []
      page.on('response', (response) => {
        const url = new URL(response.url())
        if (url.pathname.startsWith(`/api/themes/${id}/assets/`))
          files.push({
            url: url.pathname,
            status: response.status(),
            type: response.headers()['content-type'] ?? '',
          })
      })
      await page.goto('/b/team')
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await page.evaluate(() => document.fonts.ready)
      if (id === 'harbour') {
        await expect
          .poll(() => files.find((file) => file.url.endsWith('/img/harbour.png'))?.status)
          .toBe(200)
        expect(files.find((file) => file.url.endsWith('.png'))?.type).toBe('image/png')
        expect(
          await page.evaluate(() => getComputedStyle(document.body).backgroundImage),
        ).toContain('/api/themes/harbour/assets/img/harbour.png')
      } else {
        const family =
          id === 'ledger' ? 'theme-ledger-JetBrains-Mono' : 'theme-studio-Source-Serif-4'
        // The heading font is the theme's own face and has actually loaded.
        await expect(page.locator('h1').first()).toBeVisible()
        await expect
          .poll(() =>
            page.evaluate(
              (name) => document.fonts.check(`600 20px "${name}"`) && document.fonts.size > 0,
              family,
            ),
          )
          .toBe(true)
        expect(
          await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).fontFamily),
        ).toContain(family)
        expect(files.every((file) => file.status === 200 && file.type === 'font/woff2')).toBe(true)
        expect(files.length).toBeGreaterThan(0)
      }
    })

    for (const mode of ['light', 'dark'] as const) {
      test(`keeps approvals, the Needs-you marker and agent shapes intact (${mode})`, async ({
        page,
      }) => {
        await useTheme(page, id, mode)
        const { card, allow, deny } = await startApproval(page, null)
        await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
        await expect(page.locator('.look-banner')).toHaveCount(0)
        await expect(page.locator('html')).not.toHaveAttribute('data-contrast-fallback', '')
        for (const part of [card, allow, deny]) {
          await expect(part).toBeVisible()
          expect(await part.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
          expect(await isOnTop(part)).toBe(true)
        }
        // A protected card is solid in every theme: no glass, no picture behind its words.
        const paint = await card.evaluate((el) => {
          const style = getComputedStyle(el)
          return {
            fill: style.backgroundColor,
            blur: style.backdropFilter,
            image: style.backgroundImage,
          }
        })
        expect(paint.fill).toMatch(/^rgb\(/)
        expect(paint.blur).toBe('none')
        expect(paint.image).toBe('none')
        expect(await allow.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
          'Hanken Grotesk',
        )
        await expect(page.locator('.bold-needs[data-protected]').first()).toBeVisible()
        await expect(page.locator('.agent-glyph').first()).toBeVisible()
        await allowIt(card)
      })
    }

    test('the protected layer holds when CSS is added behind the sanitiser', async ({ page }) => {
      await useTheme(page, id)
      const { card, allow, deny } = await startApproval(page, null)
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await page.addStyleTag({
        content: `
          .bold-request, .bold-request * { opacity: 0 !important; visibility: hidden !important; transform: translateX(-9999px) !important; }
          .bold-request { display: none !important; }
          .bold-needs { display: none !important; }
          .agent-glyph { display: none !important; }
        `,
      })
      for (const part of [card, allow, deny]) {
        await expect(part).toBeVisible()
        expect(await part.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
        expect(await isOnTop(part)).toBe(true)
      }
      await expect(page.locator('.bold-needs[data-protected]').first()).toBeVisible()
      await allowIt(card)
    })

    test('Settings stays reachable, and the way back works (safe look, Ctrl+Shift+0)', async ({
      page,
    }) => {
      await useTheme(page, id)
      await pair(page)
      await page.goto('/b')
      const html = page.locator('html')
      await expect(html).toHaveAttribute('data-look', 'custom')
      const settings = page.getByRole('button', { name: 'Settings', exact: true })
      await expect(settings).toBeVisible()
      await settings.click()
      await expect(page).toHaveURL(/\/b\/settings/)
      // Settings opens its first section; the Look section holds the reset.
      await page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: /^Look/ })
        .click()
      await expect(
        page.getByRole('button', { name: 'Reset the look on this device' }),
      ).toBeVisible()

      await page.goto('/b?look=safe')
      await expect(page.locator('.look-banner')).toContainText('Safe look')
      await expect(html).not.toHaveAttribute('data-look', 'custom')
      await expect(html).toHaveAttribute('data-pack', 'score')

      await page.goto('/b')
      await expect(html).toHaveAttribute('data-look', 'custom')
      await page.keyboard.press('Control+Shift+Digit0')
      await expect(html).not.toHaveAttribute('data-look', 'custom')
      await page.reload()
      await expect(html).not.toHaveAttribute('data-look', 'custom')
    })
  })
}

// A built-in theme must never trip the guard: its own pages (Settings › Look, the team room) keep it on, on a desktop
// and on a phone, in both modes. (Found when Harbour was switched off on Settings by the Settings button's own pill.)
for (const id of ['paper', 'night', 'dense', ...packagedThemeIds] as const) {
  for (const [mode, viewport] of [
    ['dark', { width: 1440, height: 900 }],
    ['light', { width: 1440, height: 900 }],
    ['light', { width: 390, height: 844 }],
  ] as const) {
    test(`${id} is not switched off by the guard on Settings › Look and the room (${mode}, ${viewport.width})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await useTheme(page, id, mode)
      await pair(page)
      for (const path of ['/b/settings/look', '/b']) {
        await page.goto(path)
        if ((packagedThemeIds as readonly string[]).includes(id))
          await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
        await page.waitForTimeout(2500)
        await expect(page.locator('.look-banner'), path).toHaveCount(0)
        await expect(page.locator('html'), path).not.toHaveAttribute('data-contrast-fallback', '')
      }
    })
  }
}
