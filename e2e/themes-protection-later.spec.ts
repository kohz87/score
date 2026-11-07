import { expect, test, type Page } from '@playwright/test'
import { allowIt } from './themes-decision.ts'
import { harmless, settle, unreadable, wear, wearApproval } from './themes-protection-helpers.ts'

test.describe('what a theme does later or on interaction can’t leave a decision hidden (gate #6)', () => {
  /** A rule that slipped past the sanitiser, written into the theme's own sheet (no DOM mutation follows). */
  async function slipIn(page: Page, ...rules: string[]) {
    await page.evaluate((texts) => {
      const sheet = document.adoptedStyleSheets.at(-1)!
      for (const text of texts) sheet.insertRule(text, sheet.cssRules.length)
    }, rules)
  }

  async function switchedOff(page: Page) {
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  }

  /** Settings has no stream or clock: nothing mutates the DOM there, so only the guard's own triggers can notice. */
  async function quietSettings(page: Page) {
    await page.goto('/b/settings/rules')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const rules = page.getByRole('region', { name: /Rules/ })
    await expect(rules).toBeVisible()
    await settle(page, 800)
    return rules
  }

  test('#6: a delayed animation that fades the page is caught when it ends', async ({ page }) => {
    await wear(page, harmless)
    const rules = await quietSettings(page)
    await slipIn(
      page,
      '@keyframes gate-fade { from { opacity: 1 } to { opacity: 0 } }',
      '.main { animation: gate-fade 0.4s 2s forwards; }',
    )
    await switchedOff(page)
    await settle(page, 1000)
    expect(await unreadable(rules)).toEqual([])
  })

  test('#6: a theme can’t animate at all (the sanitiser drops animation, transition and keyframes)', async ({
    page,
  }) => {
    const { card } = await wearApproval(
      page,
      '@keyframes gate-fade { from { opacity: 1 } to { opacity: 0 } }' +
        '.main { animation: gate-fade 0.4s 2s forwards; transition: opacity 1s; }' +
        '.bold-frame { animation-name: gate-fade; transition-delay: 3s; box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }',
    )
    await settle(page, 3500)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    expect(await unreadable(card)).toEqual([])
    const css = await page.evaluate(() =>
      document.adoptedStyleSheets
        .flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText))
        .join('\n'),
    )
    expect(css).not.toMatch(/animation|transition|keyframes/)
    expect(css).toContain('box-shadow')
  })

  test('#6: a hover rule that fades the page is caught on the first pointer move', async ({
    page,
  }) => {
    // The allowlist keeps `filter` and a faded ancestor out; the guard is the second wall, so the rule is slipped in
    // behind the sanitiser, as if it had missed it.
    await wear(page, harmless)
    const rules = await quietSettings(page)
    await slipIn(page, '.main:hover { opacity: 0; }')
    await page.mouse.move(5, 300)
    await page.mouse.move(400, 400)
    await switchedOff(page)
    await settle(page, 1000)
    expect(await unreadable(rules)).toEqual([])
  })

  test('#6: a focus rule that hides the page is caught when something takes focus', async ({
    page,
  }) => {
    await wear(page, harmless)
    const rules = await quietSettings(page)
    await slipIn(page, '.main:focus-within { filter: blur(8px); opacity: 0.1; }')
    await page.locator('.main :is(button, input, select, a[href])').first().focus()
    await switchedOff(page)
    await settle(page, 1000)
    expect(await unreadable(rules)).toEqual([])
  })

  test('#6: an action on a hidden decision is refused, nothing is sent, and Score says why', async ({
    page,
  }) => {
    const { card } = await wearApproval(page, harmless)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const decisions: string[] = []
    page.on('request', (request) => {
      if (/\/api\/approvals\/[^/]+\/decision/.test(request.url())) decisions.push(request.url())
    })
    // A slow fade, set to 90% of its run: no event has fired since it began, so only the click can notice.
    await slipIn(
      page,
      '@keyframes gate-slow { from { opacity: 1 } to { opacity: 0 } }',
      '.main { animation: gate-slow 600s linear forwards; }',
    )
    // Same task as the click: nothing between them (no timer, no observer) can notice the fade before the click does.
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        if ((animation as CSSAnimation).animationName === 'gate-slow')
          animation.currentTime = 540_000
      }
      ;[...document.querySelectorAll<HTMLButtonElement>('article[aria-label^="Needs you:"] button')]
        .find((b) => b.textContent === 'Allow')!
        .click()
    })
    await expect(page.locator('.look-banner')).toContainText('Nothing was sent', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    expect(decisions).toEqual([])
    // Score's own look is back: the approval is there to answer, and answering works.
    await settle(page, 1000)
    expect(await unreadable(card)).toEqual([])
    await allowIt(card)
  })
})
