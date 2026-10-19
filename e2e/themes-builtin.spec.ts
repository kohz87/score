import { expect, test, type Locator, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'
import { packagedThemeIds, type PackagedThemeId } from './themes-builtin-fixtures.ts'

// The built-in themes of PLAN 9.5 (Harbour, Ledger, Studio) against the real fake-mode server: they are listed, they
// apply from Settings › Look with the settings of their manifest, their files load, and they keep every protected
// surface and every way back (design docs/briefs/9-themes.md § 4), like any imported theme.

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

async function useTheme(page: Page, id: PackagedThemeId, mode: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ([theme, m]) => {
      localStorage.setItem('score.look.device', theme!)
      localStorage.setItem('score.theme', m!)
    },
    [id, mode],
  )
  await pair(page)
}

async function startApproval(page: Page): Promise<{ card: Locator }> {
  const room = await makeRoom(page, 'builtin')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto(`/chat/${room.id}`)
  const card = page.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeAttached({ timeout: 20_000 })
  return { card }
}

async function isOnTop(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return false
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return !!top && (element === top || element.contains(top))
  })
}

for (const id of packagedThemeIds) {
  test.describe(id, () => {
    test('is offered in Settings › Look and applies its manifest', async ({ page }) => {
      await pair(page)
      await page.goto('/settings/look')
      const styles = page.getByRole('region', { name: 'Look' }).getByRole('radiogroup', {
        name: 'Style',
      })
      for (const name of ['Score', 'Paper', 'Night shift', 'Dense', 'Harbour', 'Ledger', 'Studio'])
        await expect(styles.getByRole('radio', { name: new RegExp(name) })).toBeVisible()
      const radio = styles.locator(`[data-pack-choice="${id}"]`)
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
      await page.goto('/now')
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
        const { card } = await startApproval(page)
        await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
        await expect(page.locator('.look-banner')).toHaveCount(0)
        await expect(page.locator('html')).not.toHaveAttribute('data-contrast-fallback', '')
        const approve = card.getByRole('button', { name: 'Approve' })
        const deny = card.getByRole('button', { name: 'Deny' })
        for (const part of [card, approve, deny]) {
          await expect(part).toBeVisible()
          expect(await part.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
          expect(await isOnTop(part)).toBe(true)
        }
        // A protected card is solid and dark in every theme: Score's own colours, never the theme's glass or ground.
        expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(
          /^rgb\((18|36), /,
        )
        expect(await card.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none')
        expect(await approve.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
          'Hanken Grotesk',
        )
        await expect(page.getByRole('img', { name: 'Needs you' }).first()).toBeVisible()
        await expect(page.locator('.agent-glyph').first()).toBeVisible()
        await approve.click()
        await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
      })
    }

    test('the protected layer holds when CSS is added behind the sanitiser', async ({ page }) => {
      await useTheme(page, id)
      const { card } = await startApproval(page)
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await page.addStyleTag({
        content: `
          .chat-approval, .chat-approval * { opacity: 0 !important; visibility: hidden !important; transform: translateX(-9999px) !important; }
          .chat-approval { display: none !important; }
          .needs-you-dot { display: none !important; }
          .agent-glyph { display: none !important; }
        `,
      })
      const approve = card.getByRole('button', { name: 'Approve' })
      for (const part of [card, approve, card.getByRole('button', { name: 'Deny' })]) {
        await expect(part).toBeVisible()
        expect(await part.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
        expect(await isOnTop(part)).toBe(true)
      }
      await expect(page.getByRole('img', { name: 'Needs you' }).first()).toBeVisible()
      await approve.click()
      await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
    })

    test('Settings stays reachable, and the way back works (safe look, Ctrl+Shift+0)', async ({
      page,
    }) => {
      await useTheme(page, id)
      await page.goto('/now')
      const html = page.locator('html')
      await expect(html).toHaveAttribute('data-look', 'custom')
      if (id === 'ledger') await page.getByRole('button', { name: 'Menu' }).click()
      const settings = (
        id === 'ledger'
          ? page.getByRole('dialog', { name: 'Menu' })
          : page.getByRole('navigation', { name: 'Main' })
      ).getByRole('link', { name: 'Settings' })
      await expect(settings).toBeVisible()
      await settings.click()
      await expect(page).toHaveURL(/\/settings/)
      // Settings opens its first section; the Look page holds the reset.
      await page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Look', exact: true })
        .click()
      await expect(
        page.getByRole('region', { name: 'Look' }).getByRole('button', {
          name: 'Reset look on this device',
        }),
      ).toBeVisible()

      await page.goto('/now?look=safe')
      await expect(page.locator('.look-banner')).toContainText('Safe look')
      await expect(html).not.toHaveAttribute('data-look', 'custom')
      await expect(html).toHaveAttribute('data-pack', 'score')

      await page.goto('/now')
      await expect(html).toHaveAttribute('data-look', 'custom')
      await page.keyboard.press('Control+Shift+Digit0')
      await expect(html).not.toHaveAttribute('data-look', 'custom')
      await page.reload()
      await expect(html).not.toHaveAttribute('data-look', 'custom')
    })
  })
}
