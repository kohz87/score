import { expect, test, type Page } from '@playwright/test'
import { CARD, harmless, settle, unreadable, wearApproval } from './themes-protection-helpers.ts'

test.describe('the guard measures contrast the way the Customizer does (gate #4)', () => {
  /** A rule that slipped past the sanitiser, written into the theme's own sheet; the guard must switch the theme off. */
  async function slipIn(page: Page, rule: string) {
    await page.evaluate((text) => {
      document.adoptedStyleSheets.at(-1)!.insertRule(text)
      document.body.append(document.createElement('i'))
    }, rule)
  }

  // 3.22.0: the card's buttons wear Score's own colours under any custom look (protected.css), so these measure on the
  // card's title text, which a theme still reaches; the buttons have their own test below.
  const cases: Record<string, string> = {
    // The finding's own reproduction: a valid computed colour the old parser could not read.
    'white in color() on white': `${CARD} .bold-request-head span { color: color(srgb 1 1 1) !important; background-color: white !important; }`,
    // A colour space the measurement can't read must not pass as readable.
    'a colour that can’t be measured': `${CARD} .bold-request-head span { color: color(rec2020 0.9 0.9 0.9) !important; background-color: white !important; }`,
    'oklch grey on white': `${CARD} .bold-request-head span { color: oklch(0.99 0 0) !important; background-color: white !important; }`,
    // Measured, but below AA (4.5:1) while above the old 3:1 floor: 3.7:1.
    'grey text below AA': `${CARD} .bold-request-head span { color: #858585 !important; background-color: white !important; }`,
    'grey title below AA': `${CARD} .bold-request-head span { color: #6b7080 !important; }`,
  }
  for (const [name, rule] of Object.entries(cases)) {
    test(`#4: ${name} is switched off`, async ({ page }) => {
      const { card } = await wearApproval(page, harmless)
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await slipIn(page, rule)
      await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
        timeout: 15_000,
      })
      await settle(page, 1000)
      expect(await unreadable(card)).toEqual([])
    })
  }
})

test('a theme rule that would make the card’s buttons unreadable is overridden by Score’s own colours', async ({
  page,
}) => {
  const { card } = await wearApproval(page, harmless)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await page.evaluate(() => {
    document.adoptedStyleSheets
      .at(-1)!
      .insertRule(
        'article[aria-label^="Needs you:"] button { color: color(srgb 1 1 1) !important; background-color: white !important; }',
      )
    document.body.append(document.createElement('i'))
  })
  await settle(page, 1000)
  expect(await unreadable(card)).toEqual([])
})
