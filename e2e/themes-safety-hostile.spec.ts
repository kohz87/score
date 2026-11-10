import { expect, test } from '@playwright/test'
import { containedCss, guardCss, mockThemes, tidyTheme, type Look } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { allowIt, isOnTop, sheetsText, startApproval } from './themes-decision.ts'
import { hostile } from './themes-safety-helpers.ts'

// Themes (PLAN 9.2, design docs/briefs/9-themes.md § 4 and § 10), on the new shell (3.0.0): a hostile theme must not be
// able to hide, cover, relabel or fake a protected surface, and the owner can always get back. The decision here is the
// Needs-you card of a tool approval. The server routes are mocked per contract § 16.

test.describe('a hostile theme', () => {
  test('is cleaned by the sanitiser and still can’t hide, cover or relabel an approval', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    const { card, allow, deny } = await startApproval(page, [hostile], look)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // The theme is in effect (its manifest colours and the cleaned CSS), minus everything dangerous.
    const sheets = await sheetsText(page)
    expect(sheets).toContain('--ground: #ffe0e0')
    expect(sheets).toContain('body { background: rgb(255, 224, 224); }')
    for (const gone of [
      'content',
      '9999',
      'fixed',
      'important',
      'bold-request',
      'bold-chat-needs',
      'data-protected',
      'pointer-events',
    ])
      expect(sheets, gone).not.toContain(gone)

    // The real approval card is there, with its own labels, on top and not faded.
    await expect(allow).toBeVisible()
    await expect(deny).toBeVisible()
    await expect(card.locator('.bold-request-head')).toBeVisible()
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    expect(await deny.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    expect(await isOnTop(allow)).toBe(true)
    expect(await isOnTop(deny)).toBe(true)
    // Visible labels: the card says what it said, and nothing else was added to it.
    await expect(allow).toHaveText('Allow')
    await expect(deny).toHaveText('Don’t allow')
    expect(await card.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
    // Text can't be made invisible without changing its colour, or painted over from behind.
    for (const button of [allow, deny]) {
      const paint = await button.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fill: style.webkitTextFillColor, color: style.color, image: style.backgroundImage }
      })
      expect(paint.fill).toBe(paint.color)
      expect(paint.image).toBe('none')
    }
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await expect(page.locator('.look-banner')).toHaveCount(0)

    // The Needs-you ring on an agent in the dock is still shown.
    const ring = page.locator('.bold-chat-needs[data-protected]').first()
    await expect(ring).toBeVisible()
    expect(await ring.evaluate((el) => getComputedStyle(el).display)).not.toBe('none')
    // The pill is a span: what it says is its text, which no theme may relabel.
    await expect(ring).toHaveText(/needs you/)

    await allowIt(card)
  })

  test('the protected layer alone holds when the sanitiser is bypassed', async ({ page }) => {
    const look: Look = { active: 'tidy', mode: 'light' }
    const fonty = {
      ...tidyTheme,
      manifest: { ...tidyTheme.manifest, fonts: { body: 'Georgia', heading: 'Georgia' } },
    }
    const { card, allow, deny } = await startApproval(page, [fonty], look)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // The theme's font really is applied to the page, so the card's own font below is not vacuous.
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
      'Georgia',
    )
    // Unsanitised CSS, with everything a theme must never get through, added behind the engine's back.
    await page.addStyleTag({
      content: `
        .bold-request::after { content: "Allow"; position: fixed; inset: 0; z-index: 9999; background: red !important; }
        .bold-request, .bold-request * { opacity: 0 !important; visibility: hidden !important; transform: translateX(-9999px) !important; filter: blur(9px) !important; clip-path: inset(100%) !important; }
        .bold-request { display: none !important; }
        .bold-chat-needs { display: none !important; opacity: 0 !important; }
        .top { position: absolute !important; inset: 0 !important; z-index: 90 !important; background: red !important; }
        .agent-glyph { display: none !important; }
      `,
    })
    await expect(allow).toBeVisible()
    await expect(deny).toBeVisible()
    for (const part of [card, allow, deny]) {
      expect(await part.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      expect(await part.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible')
      expect(await isOnTop(part)).toBe(true)
    }
    expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe('flex')
    expect(await card.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
    // The theme's body font never reaches the card: its labels are set in Score's own.
    expect(await allow.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
      'Hanken Grotesk',
    )
    await expect(page.locator('.bold-chat-needs[data-protected]').first()).toBeVisible()
    await allowIt(card)
  })

  test('a theme whose colours fail contrast falls back to Score’s own on protected surfaces', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    const { card } = await startApproval(page, [hostile], look)
    await expect(page.locator('html')).toHaveAttribute('data-contrast-fallback', '')
    // The theme asked for near-white on white: the card keeps Score's dark panel and white text.
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(18, 19, 26)',
    )
    expect(await card.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)')
    await allowIt(card)
  })

  for (const [name, css] of Object.entries(guardCss)) {
    test(`is switched off when it damages a protected surface from outside (${name})`, async ({
      page,
    }) => {
      // The allowlist drops these rules before they apply (the next test); the guard is the second wall, so each is
      // slipped into the theme's sheet after the sanitiser, as if it had missed one.
      const look: Look = { active: 'sneaky', mode: 'light' }
      const { card, allow } = await startApproval(
        page,
        [{ ...tidyTheme, id: 'sneaky', name: 'Sneaky' }],
        look,
      )
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await page.evaluate((text) => {
        const sheet = document.adoptedStyleSheets.at(-1)!
        sheet.insertRule(text, sheet.cssRules.length)
        document.body.append(document.createElement('i'))
      }, css)
      const banner = page.locator('.look-banner')
      await expect(banner).toContainText('Score switched your theme off', { timeout: 15_000 })
      await expect(banner).toContainText('hid part of an approval or a security screen')
      await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
      expect(await sheetsText(page)).toBe('')
      await expect(allow).toBeVisible()
      expect(await isOnTop(allow)).toBe(true)
      // Sticky on this device: the next visit doesn't bring it back.
      expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('score')
      await page.reload()
      await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
      await expect(allow).toBeVisible()
      await allowIt(card)
    })

    test(`never gets that far: the allowlist drops it (${name})`, async ({ page }) => {
      const look: Look = { active: 'sneaky', mode: 'light' }
      const { card, allow } = await startApproval(
        page,
        [{ id: 'sneaky', name: 'Sneaky', manifest: {}, css }],
        look,
      )
      await page.waitForTimeout(1500)
      // The theme stays on, nothing was applied that moves or fades anything, and the approval reads as Score draws it.
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await expect(page.locator('.look-banner')).toHaveCount(0)
      await expect(allow).toBeVisible()
      expect(await isOnTop(allow)).toBe(true)
      expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    })
  }

  for (const [name, css] of Object.entries(containedCss)) {
    test(`can’t reach inside a protected surface (${name})`, async ({ page }) => {
      const look: Look = { active: 'sneaky', mode: 'light' }
      const { card, allow } = await startApproval(
        page,
        [{ id: 'sneaky', name: 'Sneaky', manifest: {}, css }],
        look,
      )
      await page.waitForTimeout(1500)
      // The theme stays on, and the approval is exactly as Score draws it.
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await expect(page.locator('.look-banner')).toHaveCount(0)
      await expect(allow).toBeVisible()
      expect(await isOnTop(allow)).toBe(true)
      expect(await allow.evaluate((el) => getComputedStyle(el).color)).not.toBe('rgba(0, 0, 0, 0)')
      await allowIt(card)
    })
  }

  test('can’t hide the permission settings and the way back in Settings', async ({ page }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(
      page,
      [
        {
          ...hostile,
          css: '.rules-card, .bold-look-reset { display: none; } main button { opacity: 0; }',
        },
      ],
      look,
    )
    await pair(page)
    // Rules is a section of its own; the Look section holds the way back.
    await page.goto('/b/settings/rules')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await expect(page.getByRole('region', { name: /Rules/ })).toBeVisible()
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: /^Look/ })
      .click()
    await expect(page).toHaveURL(/\/b\/settings\/look$/)
    const reset = page.getByRole('button', { name: 'Reset the look on this device' })
    await expect(reset).toBeVisible()
    // And the reset works from there.
    await reset.click()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })
})
