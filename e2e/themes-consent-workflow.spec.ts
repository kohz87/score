import { expect, test, type Page } from '@playwright/test'
import { ACCEPTED_TOKEN, custom, drawn, dropped, wear } from './themes-consent-helpers.ts'
import { openCodingRecipeStart } from './recipe-run.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Starting a workflow

// 2.8.0: starting a saved recipe is Start a job. The decision (the "Before it starts" checklist, the coding reach, the
// button) is one protected surface there; hostile accepted theme CSS can't hide any part of it.
test.describe('X1: starting a recipe from Start a job is one decision', () => {
  const startCss = [
    '.start-checks, .start-checks * { opacity: 0; color: transparent; }',
    '.start-reach, .start-reach * { opacity: 0; color: transparent; }',
    '.start-limits, .start-limits * { opacity: 0; color: transparent; }',
    '.start-ask, .start-ask * { opacity: 0; color: transparent; }',
    '.start-ack { opacity: 0; }',
    '.start-actions { opacity: 0; }',
  ].join('\n')

  /** The guard may catch the hidden rule before the click or at it: either way the theme is off and nothing is sent. */
  async function expectOff(page: Page, sent: unknown[]) {
    await expect(page.locator('.look-banner')).toContainText('Score switched your theme off', {
      timeout: 15_000,
    })
    await dropped(page)
    expect(sent).toEqual([])
  }

  async function startDialog(page: Page) {
    const opened = await openCodingRecipeStart(page, `Consent ${Date.now().toString(36)}`)
    await custom(page)
    // The theme's own sheet is on the page (the last adopted one) before a rule is added to it.
    await expect
      .poll(() => page.evaluate(() => document.adoptedStyleSheets.length))
      .toBeGreaterThan(0)
    return opened
  }

  test('accepted theme CSS cannot hide the checklist, the reach or the button', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page, `${ACCEPTED_TOKEN}\n${startCss}`)
    const { dialog } = await startDialog(page)
    await drawn(dialog.getByRole('region', { name: 'Before it starts' }))
    const reach = dialog.locator('.start-reach')
    await expect(reach).toHaveAttribute('data-protected', 'block')
    await drawn(reach.getByText(/Reads any file you can read/))
    await drawn(dialog.getByRole('button', { name: 'Start the job' }))
    await drawn(dialog.locator('label[for="start-cap"]'))
    await drawn(dialog.getByLabel(/^Spend cap/))
    await drawn(dialog.getByText('Ask me before'))
    await drawn(dialog.getByText('Only risky actions'))
    await custom(page)
  })

  test('a budget field hidden past the theme guard refuses the click on Start and nothing is sent', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, bodies } = await startDialog(page)
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await dialog
      .locator('.start-reach')
      .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
      .check()
    await expect(dialog.getByRole('button', { name: 'Start the job' })).toBeEnabled({
      timeout: 20_000,
    })
    // Accepted CSS can't hide a field of this form (the dialog is protected); a rule that slipped past is caught when
    // the person acts, because the whole decision is measured, not only the control.
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.start-limits, .start-limits * { opacity: 0 !important; color: transparent !important; }',
        )
      // In the same task, so a re-applied theme can't drop the rule before the click.
      document.querySelector<HTMLButtonElement>('.start-go')!.click()
    })
    await expectOff(page, bodies)
  })

  test('hidden reach text refuses the click on Start and nothing is sent', async ({ page }) => {
    test.setTimeout(90_000)
    await wear(page)
    const { dialog, bodies } = await startDialog(page)
    await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
    await dialog
      .locator('.start-reach')
      .getByRole('checkbox', { name: /I understand what these coding agents can read/ })
      .check()
    await expect(dialog.getByRole('button', { name: 'Start the job' })).toBeEnabled({
      timeout: 20_000,
    })
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule('.start-reach, .start-reach * { color: transparent !important; }')
      document.querySelector<HTMLButtonElement>('.start-go')!.click()
    })
    await expectOff(page, bodies)
  })
})
