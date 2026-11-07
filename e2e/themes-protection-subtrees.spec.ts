import { expect, test } from '@playwright/test'
import { isOnTop } from './themes-decision.ts'
import {
  CARD,
  glyphPaint,
  harmless,
  settle,
  unreadable,
  wearApproval,
} from './themes-protection-helpers.ts'

test.describe('theme CSS stays out of protected subtrees', () => {
  test('#3: approval title and description can’t be made invisible by position or tag', async ({
    page,
  }) => {
    const { card, allow } = await wearApproval(
      page,
      `${CARD} > div:first-child > span { color: transparent; }` +
        `${CARD} span { -webkit-text-fill-color: transparent; opacity: 0; }` +
        `${CARD} code { display: none; }`,
    )
    await settle(page)
    expect(await unreadable(card)).toEqual([])
    await expect(allow).toBeVisible()
    await expect(card.locator('code')).toBeVisible()
    // Contained rather than switched off: the rest of the theme stays on.
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  })

  test('#3: the guard looks at every element with text, not a list of tags', async ({ page }) => {
    const { card } = await wearApproval(page, harmless)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // As if a rule had slipped through the sanitiser: the approval's own words go invisible, in the theme's sheet.
    await page.evaluate((selector) => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(`${selector} > div:first-child > span { color: transparent; }`)
      document.body.append(document.createElement('i'))
    }, CARD)
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await settle(page, 1000) // Score’s own entrance motion
    expect(await unreadable(card)).toEqual([])
  })

  test('#5: the guard compares what glyph shapes paint, not just their wrapper', async ({
    page,
  }) => {
    await wearApproval(page, harmless)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // As if a rule had slipped through the sanitiser: every path takes another shape (the wrapper stays exactly as it was).
    await page.evaluate(() => {
      document.adoptedStyleSheets.at(-1)!.insertRule('svg path { d: path("M1 1 L2 2"); }')
      document.body.append(document.createElement('i'))
    })
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('#5: a theme can’t erase or reshape agent glyph shapes', async ({ page }) => {
    await wearApproval(
      page,
      ':root svg path, :root svg circle, :root svg rect { opacity: 0; fill: transparent; stroke: transparent; }' +
        'svg path { d: path("M0 0 L1 1"); transform: scale(0); }' +
        'svg { visibility: hidden; filter: blur(4px); clip-path: inset(100%); }',
    )
    await settle(page)
    const worn = await glyphPaint(page)
    expect(worn.length).toBeGreaterThan(0)
    // The same page without the theme.
    await page.goto('/b?look=safe')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.locator('.agent-glyph').first()).toBeVisible()
    // The same wait as for the worn page: the room's lists fill in after the first glyph shows, and a page measured
    // before they have arrived has fewer glyphs than one measured after.
    await settle(page)
    const plain = await glyphPaint(page)
    // (The room may have gained a message between the two loads: compare what the glyphs look like, not how many.)
    expect([...new Set(worn)].sort()).toEqual([...new Set(plain)].sort())
    expect(await isOnTop(page.locator('.agent-glyph').first())).toBe(true)
  })
})
