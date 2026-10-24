import { expect, test, type Locator } from '@playwright/test'
import { openBoldRoomWith } from './bold-room-fixtures.ts'
import { pair } from './pair.ts'
import {
  boldThemeIds,
  rgb,
  themeColour,
  wearBuiltin,
  type BoldThemeId,
} from './themes-bold-fixtures.ts'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'

// PLAN 11.9d: themes and the Customizer on the new shell. A built-in theme paints the bold shell through the colours it
// sets for the classic one; the ways back work on /b; the Customizer previews the new screens.
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })

const themed = boldThemeIds.filter((id): id is Exclude<BoldThemeId, 'score'> => id !== 'score')

// A theme whose ink/card pair fails AA in both modes. The engine must put its protected surfaces back on Score's own
// colours, including the bold shell's own tokens (protected.css keys those on the shell's data-look).
const failing: MockTheme = {
  id: 'failing',
  name: 'Failing contrast',
  source: 'custom',
  manifest: {
    colors: {
      light: { ground: '#ffffff', card: '#ffffff', ink: '#eeeeee' },
      dark: { ground: '#000000', card: '#000000', ink: '#222222' },
    },
  },
}

/** [text, background] a protected surface wears in each fallback mode (prototype's dark and light sets). */
const protectedPair = {
  light: {
    request: ['rgb(255, 255, 255)', 'rgb(18, 19, 26)'],
    privacy: ['rgb(94, 98, 108)', 'rgb(255, 255, 255)'],
  },
  dark: {
    request: ['rgb(18, 19, 26)', 'rgb(236, 236, 241)'],
    privacy: ['rgb(169, 173, 184)', 'rgb(22, 23, 30)'],
  },
} as const

/** WCAG AA for the text and the fill a person reads it on. */
async function expectReadable(locator: Locator, [colour, background]: readonly [string, string]) {
  await expect(locator).toBeVisible()
  await locator.evaluate(
    (element, [foreground, fill]) => {
      const channel = (value: number) => {
        const c = value / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      const read = (value: string) => value.match(/\d+/g)!.map(Number)
      const ratio = (a: string, b: string) => {
        const [ar, ag, ab] = read(a)
        const [br, bg, bb] = read(b)
        const one = 0.2126 * channel(ar!) + 0.7152 * channel(ag!) + 0.0722 * channel(ab!)
        const two = 0.2126 * channel(br!) + 0.7152 * channel(bg!) + 0.0722 * channel(bb!)
        return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
      }
      if (ratio(foreground, fill) < 4.5) throw new Error(`${foreground} on ${fill} is below AA`)
      const box = (element as HTMLElement).getBoundingClientRect()
      if (box.width === 0 || box.height === 0) throw new Error('no box')
    },
    [colour, background] as const,
  )
}

for (const mode of ['light', 'dark'] as const) {
  test(`a failing theme wears Score’s protected colours on bold decisions and privacy (${mode})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('score.theme', value), mode)
    await openBoldRoomWith(page, {}, async (frame) => {
      const look: Look = { active: 'failing', mode }
      await mockThemes(frame, [failing], look)
    })
    await expect(page.locator('html')).toHaveAttribute('data-contrast-fallback', '')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await expect(page.locator('[data-ui="bold"]')).toHaveAttribute('data-look', mode)

    // A protected decision card is painted from Score's bold pair, not the failing theme's card and ink.
    const request = page.locator('[data-ui="bold"] .bold-request').first()
    const expected = protectedPair[mode]
    await expect(request).toHaveCSS('color', expected.request[0])
    await expect(request).toHaveCSS('background-color', expected.request[1])
    await expect(request).toContainText(
      /May I install a package\?|The review ended without a verdict/,
    )
    await expectReadable(request, expected.request)

    // The privacy promise in a one-to-one: Score's muted text on Score's panel fill.
    await page.goto('/b?with=builder')
    const privacy = page.locator('#bold-side-panel .bold-dm-privacy[data-protected]')
    await expect(privacy).toContainText('Only you and builder see this')
    await expect(privacy).toHaveCSS('color', expected.privacy[0])
    await expect(privacy).toHaveCSS('background-color', expected.privacy[1])
    await expectReadable(privacy, expected.privacy)
  })
}

test('a failing theme on a dark device, with Look on system, keeps the bold light switch readable', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  // No score.theme: Look follows the device. The failing theme makes the engine set data-contrast-fallback.
  await page.addInitScript(() => localStorage.removeItem('score.theme'))
  await openBoldRoomWith(page, {}, async (frame) => {
    const look: Look = { active: 'failing', mode: 'system' }
    await mockThemes(frame, [failing], look)
  })
  await expect(page.locator('html')).toHaveAttribute('data-contrast-fallback', '')
  const shell = page.locator('[data-ui="bold"]')
  await expect(shell).toHaveAttribute('data-look', 'dark')

  // Search's switch is for this visit only: it changes data-look, not data-theme or score.theme.
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Search and commands' })
  await dialog.getByRole('combobox', { name: 'Search or run a command' }).fill('Switch to light')
  await dialog.getByRole('option', { name: 'Switch to light' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(shell).toHaveAttribute('data-look', 'light')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  expect(await page.evaluate(() => localStorage.getItem('score.theme'))).toBeNull()

  // The dark @media copy must not win: Score's light pair, not light ink on a white panel.
  const request = page.locator('[data-ui="bold"] .bold-request').first()
  await expect(request).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(request).toHaveCSS('background-color', 'rgb(18, 19, 26)')
  await expectReadable(request, ['rgb(255, 255, 255)', 'rgb(18, 19, 26)'])
  // Open the one-to-one through the shell: a page load would drop the visit-only light override.
  await page.getByRole('button', { name: /^One to one with builder,/ }).click()
  await expect(shell).toHaveAttribute('data-look', 'light')
  const privacy = page.locator('#bold-side-panel .bold-dm-privacy[data-protected]')
  await expect(privacy).toBeVisible()
  await expect(privacy).toHaveCSS('color', 'rgb(94, 98, 108)')
  await expect(privacy).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expectReadable(privacy, ['rgb(94, 98, 108)', 'rgb(255, 255, 255)'])
})

test('a failing theme gives protected text with no fill an opaque Score ground', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('score.theme', 'dark'))
  await openBoldRoomWith(page, { shared: true, source: true }, async (frame) => {
    const look: Look = { active: 'failing', mode: 'dark' }
    await mockThemes(frame, [failing], look)
  })
  await expect(page.locator('html')).toHaveAttribute('data-contrast-fallback', '')
  const expected: [string, string] = ['rgb(236, 236, 241)', 'rgb(26, 28, 35)']

  // A shared message paints its text bubble itself; its wrapper is the protected surface that needs the fill.
  await page.getByRole('tab', { name: /Activity feed/ }).click()
  const shared = page.locator('[data-ui="bold"] .bold-shared')
  await expect(shared).toContainText('shared from a one-to-one with you')
  // Asserted on the element itself, so an ancestor's fill can't stand in for the fallback's.
  await expect(shared).toHaveCSS('background-color', expected[1])
  await expect(shared).toHaveCSS('color', expected[0])
  await expectReadable(shared, expected)

  // Started by paints the prototype's deep card; in the fallback that is Score's own deep, not the theme's.
  const started = page.getByRole('article', { name: /^Started by Tickets/ })
  await expect(started).toContainText('TCK-142')
  const deep: [string, string] = [expected[0], 'rgb(22, 23, 30)']
  await expect(started).toHaveCSS('background-color', deep[1])
  await expect(started).toHaveCSS('color', deep[0])
  await expectReadable(started, deep)
})

for (const id of themed) {
  for (const mode of ['light', 'dark'] as const) {
    test(`${id} paints the bold shell in ${mode}`, async ({ page }) => {
      await pair(page)
      await wearBuiltin(page, id, mode)
      await page.goto('/b/team')
      const shell = page.locator('[data-ui="bold"]')
      await expect(shell).toHaveAttribute('data-look', mode)
      await expect(page.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible()
      // The shell's ground and its panels are the theme's ground and card.
      await expect(shell).toHaveCSS('background-color', rgb(themeColour(id, mode, 'ground')))
      const panel = await page
        .locator('.bold-shell .panel, .bold-shell .card, .bold-shell [class*="team-card"]')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      expect([rgb(themeColour(id, mode, 'card')), 'rgba(0, 0, 0, 0)']).toContain(panel)
      await expect(shell).toHaveCSS('color', rgb(themeColour(id, mode, 'ink')))
    })
  }
}

test('Score itself keeps the prototype’s dark and light sets', async ({ page }) => {
  await pair(page)
  await wearBuiltin(page, 'score', 'dark')
  await page.goto('/b/team')
  const shell = page.locator('[data-ui="bold"]')
  await expect(shell).toHaveCSS('background-color', 'rgb(18, 19, 26)')
})

test('safe mode and the reset shortcut work on the new shell', async ({ page }) => {
  await pair(page)
  await wearBuiltin(page, 'harbour', 'dark')
  await page.goto('/b/team')
  const shell = page.locator('[data-ui="bold"]')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await expect(shell).toHaveCSS('background-color', rgb(themeColour('harbour', 'dark', 'ground')))

  await page.goto('/b/team?look=safe')
  await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  await expect(shell).toHaveCSS('background-color', 'rgb(18, 19, 26)')
  const banner = page.getByRole('status').filter({ hasText: 'Safe look' })
  await expect(banner).toBeVisible()
  // The way back from the banner leads to the new look's own Settings › Look.
  await banner.getByRole('link', { name: 'Settings › Look' }).click()
  await expect(page).toHaveURL(/\/b\/settings\/look/)
  await expect(page.getByRole('heading', { name: 'Look', exact: true })).toBeVisible()

  await page.goto('/b/team')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await page.keyboard.press('Control+Shift+Digit0')
  await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  await expect(shell).toHaveCSS('background-color', 'rgb(18, 19, 26)')
})

test('the Customizer previews the new look’s screens in the chosen colours', async ({ page }) => {
  await pair(page)
  await page.goto('/settings/look/customize')
  await expect(page.getByRole('heading', { name: 'Customize' })).toBeVisible()
  const picker = page.getByLabel('Page to preview')
  const frame = page.frameLocator('iframe[title="Preview of your theme"]')
  const hostBody = page.locator('body')

  await picker.selectOption({ label: 'New look: Team' })
  await expect(frame.getByRole('heading', { name: 'Your team', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  const shell = frame.locator('[data-ui="bold"]')
  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  await expect(shell).toHaveAttribute('data-look', 'light')
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await expect(shell).toHaveAttribute('data-look', 'dark')

  await picker.selectOption({ label: 'New look: Room' })
  await expect(
    frame.locator('[data-ui="bold"] .bold-sidecol, [data-ui="bold"] .side').first(),
  ).toBeVisible({
    timeout: 30_000,
  })
  // The room fits its own frame; the Customizer page around it is untouched.
  await expect(hostBody).not.toHaveClass(/fit/)

  await picker.selectOption({ label: 'New look: Agent page' })
  await expect(frame.locator('[data-ui="bold"] h1').first()).toBeVisible({ timeout: 30_000 })
  await picker.selectOption({ label: 'New look: Settings' })
  await expect(frame.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
})
