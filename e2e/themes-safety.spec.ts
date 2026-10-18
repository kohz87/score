import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  containedCss,
  guardCss,
  hostileCss,
  hostileManifest,
  mockThemes,
  tidyTheme,
  type Look,
  type MockTheme,
} from './themes-fixtures.ts'
import { layoutThemes, theme as layoutTheme } from './themes-layout-fixtures.ts'
import { samplePng } from './png.ts'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'
import { visualHello } from './visual-fixtures.ts'

// Themes (PLAN 9.2, design docs/briefs/9-themes.md § 4 and § 10): a hostile theme must not be able to hide, cover,
// relabel or fake a protected surface, and the owner can always get back. The server routes are mocked per contract § 16.

const hostile: MockTheme = {
  id: 'hostile',
  name: 'Hostile',
  source: 'imported',
  manifest: hostileManifest,
  css: hostileCss,
}

async function startApproval(page: Page): Promise<{ card: Locator; roomId: string }> {
  const room = await makeRoom(page, 'look')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto(`/chat/${room.id}`)
  const card = page.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeAttached({ timeout: 20_000 })
  return { card, roomId: room.id }
}

/** The topmost element at the middle of `target` is `target` or inside it: nothing covers it. */
async function isOnTop(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return false
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return !!top && (element === top || element.contains(top))
  })
}

// The engine confines every theme rule to the outside of protected subtrees (G1 #3); that guard names data-protected
// and is not part of what the theme wrote, so it is taken out before the text is judged.
async function sheetsText(page: Page): Promise<string> {
  const text = await page.evaluate(() =>
    [
      ...document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText)),
      ...[...document.querySelectorAll('style[data-score-look]')].map((s) => s.textContent ?? ''),
    ].join('\n'),
  )
  return text.replaceAll(':where(:not([data-protected], [data-protected] *))', '')
}

test.describe('a hostile theme', () => {
  test('is cleaned by the sanitiser and still can’t hide, cover or relabel an approval', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await pair(page)
    const { card } = await startApproval(page)
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
      'chat-approval',
      'data-protected',
      'pointer-events',
    ])
      expect(sheets, gone).not.toContain(gone)

    // The real approval card is there, with its own labels, on top and not faded.
    const approve = card.getByRole('button', { name: 'Approve' })
    const deny = card.getByRole('button', { name: 'Deny' })
    await expect(approve).toBeVisible()
    await expect(deny).toBeVisible()
    await expect(card.locator('.chat-approval-title')).toBeVisible()
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    expect(await deny.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    expect(await isOnTop(approve)).toBe(true)
    expect(await isOnTop(deny)).toBe(true)
    // Visible labels: the card says what it said, and nothing else was added to it.
    await expect(approve).toHaveText('Approve')
    await expect(deny).toHaveText('Deny')
    expect(await card.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
    // Text can't be made invisible without changing its colour, or painted over from behind.
    for (const button of [approve, deny]) {
      const paint = await button.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fill: style.webkitTextFillColor, color: style.color, image: style.backgroundImage }
      })
      expect(paint.fill).toBe(paint.color)
      expect(paint.image).toBe('none')
    }
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await expect(page.locator('.look-banner')).toHaveCount(0)

    // The Needs-you marker in the top bar is still shown.
    const dot = page.getByRole('img', { name: 'Needs you' }).first()
    await expect(dot).toBeVisible()
    expect(await dot.evaluate((el) => getComputedStyle(el).display)).not.toBe('none')

    await approve.click()
    await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
  })

  test('the protected layer alone holds when the sanitiser is bypassed', async ({ page }) => {
    const look: Look = { active: 'tidy', mode: 'light' }
    const fonty = {
      ...tidyTheme,
      manifest: { ...tidyTheme.manifest, fonts: { body: 'Georgia', heading: 'Georgia' } },
    }
    await mockThemes(page, [fonty], look)
    await pair(page)
    const { card } = await startApproval(page)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
      'Georgia',
    )
    // Unsanitised CSS, with everything a theme must never get through, added behind the engine's back.
    await page.addStyleTag({
      content: `
        .chat-approval::after { content: "Approve"; position: fixed; inset: 0; z-index: 9999; background: red !important; }
        .chat-approval, .chat-approval * { opacity: 0 !important; visibility: hidden !important; transform: translateX(-9999px) !important; filter: blur(9px) !important; clip-path: inset(100%) !important; }
        .chat-approval { display: none !important; }
        .needs-you-dot { display: none !important; opacity: 0 !important; }
        .top-bar { position: absolute !important; inset: 0 !important; z-index: 90 !important; background: red !important; }
        .agent-glyph { display: none !important; }
      `,
    })
    const approve = card.getByRole('button', { name: 'Approve' })
    const deny = card.getByRole('button', { name: 'Deny' })
    await expect(approve).toBeVisible()
    await expect(deny).toBeVisible()
    for (const part of [card, approve, deny]) {
      expect(await part.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
      expect(await part.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible')
      expect(await isOnTop(part)).toBe(true)
    }
    expect(await card.evaluate((el) => getComputedStyle(el).display)).toBe('flex')
    expect(await card.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
    // The theme's body font never reaches the card: its labels are set in Score's own.
    expect(await approve.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(
      'Hanken Grotesk',
    )
    await expect(page.getByRole('img', { name: 'Needs you' }).first()).toBeVisible()
    await approve.click()
    await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
  })

  test('a theme whose colours fail contrast falls back to Score’s own on protected surfaces', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await pair(page)
    const { card } = await startApproval(page)
    await expect(page.locator('html')).toHaveAttribute('data-contrast-fallback', '')
    // The theme asked for near-white on white: the card keeps Score's dark panel and white text.
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(18, 19, 26)',
    )
    expect(await card.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)')
    await card.getByRole('button', { name: 'Approve' }).click()
    await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
  })

  for (const [name, css] of Object.entries(guardCss)) {
    test(`is switched off when it damages a protected surface from outside (${name})`, async ({
      page,
    }) => {
      // The allowlist drops these rules before they apply (the next test); the guard is the second wall, so each is
      // slipped into the theme's sheet after the sanitiser, as if it had missed one.
      const look: Look = { active: 'sneaky', mode: 'light' }
      await mockThemes(page, [{ ...tidyTheme, id: 'sneaky', name: 'Sneaky' }], look)
      await pair(page)
      const { card } = await startApproval(page)
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
      await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible()
      expect(await isOnTop(card.getByRole('button', { name: 'Approve' }))).toBe(true)
      // Sticky on this device: the next visit doesn't bring it back.
      expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('score')
      await page.reload()
      await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
      await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible()
      await card.getByRole('button', { name: 'Approve' }).click()
      await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
    })

    test(`never gets that far: the allowlist drops it (${name})`, async ({ page }) => {
      const look: Look = { active: 'sneaky', mode: 'light' }
      await mockThemes(page, [{ id: 'sneaky', name: 'Sneaky', manifest: {}, css }], look)
      await pair(page)
      const { card } = await startApproval(page)
      await page.waitForTimeout(1500)
      // The theme stays on, nothing was applied that moves or fades anything, and the approval reads as Score draws it.
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await expect(page.locator('.look-banner')).toHaveCount(0)
      const approve = card.getByRole('button', { name: 'Approve' })
      await expect(approve).toBeVisible()
      expect(await isOnTop(approve)).toBe(true)
      expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    })
  }

  for (const [name, css] of Object.entries(containedCss)) {
    test(`can’t reach inside a protected surface (${name})`, async ({ page }) => {
      const look: Look = { active: 'sneaky', mode: 'light' }
      await mockThemes(page, [{ id: 'sneaky', name: 'Sneaky', manifest: {}, css }], look)
      await pair(page)
      const { card } = await startApproval(page)
      await page.waitForTimeout(1500)
      // The theme stays on, and the approval is exactly as Score draws it.
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await expect(page.locator('.look-banner')).toHaveCount(0)
      const approve = card.getByRole('button', { name: 'Approve' })
      await expect(approve).toBeVisible()
      expect(await isOnTop(approve)).toBe(true)
      expect(await approve.evaluate((el) => getComputedStyle(el).color)).not.toBe(
        'rgba(0, 0, 0, 0)',
      )
      await approve.click()
      await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
    })
  }

  test('can’t hide the password dialogs, permission settings and the way back in Settings', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(
      page,
      [
        {
          ...hostile,
          css: '.rules-card, .guard-form, .look-reset { display: none; } main button { opacity: 0; }',
        },
      ],
      look,
    )
    await pair(page)
    await page.goto('/settings')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const region = page.getByRole('region', { name: 'Look' })
    await expect(region.getByRole('button', { name: 'Reset look on this device' })).toBeVisible()
    await expect(region.getByLabel(/Ask for the security password/)).toBeVisible()
    await expect(page.getByRole('region', { name: /Rules/ })).toBeVisible()
    // And the reset works from there.
    await region.getByRole('button', { name: 'Reset look on this device' }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })
})

test.describe('the way back', () => {
  test('?look=safe skips the theme and the device choice for this visit and says so', async ({
    page,
  }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await page.addInitScript(() => localStorage.setItem('score.look.device', 'hostile'))
    await pair(page)
    await page.goto('/settings')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.goto('/now?look=safe')
    const banner = page.locator('.look-banner')
    await expect(banner).toContainText('Safe look: your theme is off for this visit')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.locator('html')).toHaveAttribute('data-pack', 'score')
    expect(await sheetsText(page)).toBe('')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(236, 238, 242)',
    )
    // The link goes to Settings › Look without leaving safe mode.
    await banner.getByRole('link', { name: 'Settings › Look' }).click()
    await expect(page).toHaveURL(/\/settings#look/)
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.getByRole('region', { name: 'Look' })).toBeVisible()
    // The device choice is untouched: the next ordinary visit has the theme again.
    expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('hostile')
    await page.goto('/now')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  })

  test('Ctrl+Shift+0 resets the look on this device', async ({ page }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await pair(page)
    await page.goto('/now')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.keyboard.press('Control+Shift+Digit0')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    expect(await page.evaluate(() => localStorage.getItem('score.look.device'))).toBe('score')
    // The old theme's cache is gone (the runtime then caches Score's own look).
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('score.look.cache') ?? '{}').id),
    ).not.toBe('hostile')
    await page.reload()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('⌘K has “Reset look on this device”', async ({ page }) => {
    const look: Look = { active: 'hostile', mode: 'light' }
    await mockThemes(page, [hostile], look)
    await pair(page)
    await page.goto('/now')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search or run a command' })
    await palette.getByRole('searchbox').fill('reset look')
    await palette.getByRole('button', { name: 'Reset look on this device' }).click()
    await expect(palette).toBeHidden()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('a theme that can’t be loaded is skipped with a banner', async ({ page }) => {
    const look: Look = { active: 'gone', mode: 'light' }
    await mockThemes(page, [], look)
    await pair(page)
    await page.goto('/now')
    await expect(page.locator('.look-banner')).toContainText('Your theme couldn’t be loaded')
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  })
})

test.describe('shared and per-device looks', () => {
  test('a device can pick its own theme, and "Use the shared theme" goes back', async ({
    page,
  }) => {
    const look: Look = { active: 'tidy', mode: 'light' }
    await mockThemes(page, [tidyTheme], look)
    await pair(page)
    await page.goto('/settings')
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-look', 'custom')
    const region = page.getByRole('region', { name: 'Look' })
    const styles = region.getByRole('radiogroup', { name: 'Style' })
    await expect(styles.getByRole('radio', { name: /Tidy/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await styles.getByRole('radio', { name: /Night shift/ }).click()
    await expect(html).toHaveAttribute('data-pack', 'night')
    await expect(html).not.toHaveAttribute('data-look', 'custom')
    await expect(
      region.getByText(/This device uses Night shift instead of the shared Tidy/),
    ).toBeVisible()
    await page.reload()
    await expect(html).toHaveAttribute('data-pack', 'night')
    await region.getByRole('button', { name: 'Use the shared theme' }).click()
    await expect(html).toHaveAttribute('data-look', 'custom')
    await expect(html).toHaveAttribute('data-pack', 'score')
  })

  test('"Theme for every device" saves through PUT /api/look', async ({ page }) => {
    const look: Look = { active: 'score', mode: 'system' }
    const puts = await mockThemes(page, [tidyTheme], look)
    await pair(page)
    await page.goto('/settings')
    const region = page.getByRole('region', { name: 'Look' })
    await region.getByLabel('Theme for every device').selectOption('tidy')
    await region.getByLabel('Colours for every device').selectOption('dark')
    await region.getByRole('button', { name: 'Save for every device' }).click()
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
    await page.goto('/now')
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

test.describe('the sanitiser in a real browser', () => {
  test('resolves CSS escapes before it checks, and reports what it dropped', async ({ page }) => {
    const css = [
      '@import url("https://evil.test/a.css");',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      '@page { margin: 0 }',
      '.a::after { \\63 ontent: "Approve"; }',
      '.b { background: url(https://evil.test/x.png); }',
      '.c { background: image-set("https://evil.test/x.png" 1x); }',
      '.d { \\70 osition: fixed; }',
      '.e { z-index: 99999; -webkit-user-modify: read-write; \\70ointer-events: none; }',
      '.f { color: red \\21 important; }',
      '.g { color: blue !\\69mportant; }',
      '\\5b data-protected\\5d { color: red; }',
      '.card:has(\\2e chat-approval) { color: red; }',
      '.keep { color: green; margin: 4px; }',
      '@font-face { font-family: Evil; src: url(asset:fonts/e.woff2); }',
    ].join('\n')
    await mockThemes(page, [{ id: 'escaped', name: 'Escaped', manifest: {}, css }], {
      active: 'escaped',
      mode: 'light',
    })
    await pair(page)
    await page.goto('/now')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    const sheets = await sheetsText(page)
    expect(sheets).toContain('.keep')
    expect(sheets).toContain('color: green')
    for (const gone of [
      'import',
      'namespace',
      'content',
      'evil.test',
      'fixed',
      '99999',
      'user-modify',
      'pointer-events',
      'important',
      'data-protected',
      'chat-approval',
      'font-face',
      '@page',
    ])
      expect(sheets, gone).not.toContain(gone)
  })
})

// Layout options (PLAN 9.3): the guarantees of the protected surfaces hold in every combination of navigation,
// width, shape, glass and background picture. The server is the real fake-mode one; the themes are mocked.
const hostileLayouts: Record<string, MockTheme> = {
  glassCover: layoutThemes.glassCover,
  glassTileDim: layoutTheme('glass-tile-dim', {
    shape: { surface: 'glass', elevation: 'floating', border: 'strong', radius: 'round' },
    background: { image: 'asset:img/bg.png', fit: 'tile', dim: 80 },
  }),
  // A near-white picture-on-glass theme whose colours would put pale text on the pale card.
  glassPale: layoutTheme('glass-pale', {
    colors: {
      light: { card: '#f4f4f4', ink: '#f0f0f0', 'panel-ink': '#f0f0f0', 'panel-card': '#f4f4f4' },
    },
    shape: { surface: 'glass', elevation: 'raised' },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 0 },
  }),
  rightNarrowBubbles: layoutTheme('right-narrow', {
    shape: { density: 'airy', surface: 'glass', radius: 'round' },
    layout: {
      nav: 'right',
      contentWidth: 'narrow',
      chat: { messages: 'bubbles', roomList: 'hidden-until-opened' },
    },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 30 },
  }),
  launcherFullCompact: layoutTheme('launcher-full', {
    shape: { density: 'compact', radius: 'sharp', border: 'none', elevation: 'flat' },
    layout: { nav: 'launcher', contentWidth: 'full', chat: { roomList: 'right' } },
  }),
  leftHiddenMenu: layoutTheme('left-hidden', {
    layout: { nav: 'left', menu: [] },
    shape: { surface: 'glass' },
    background: { image: 'asset:img/bg.png', fit: 'cover', dim: 10 },
  }),
}

async function assertProtectedHolds(card: Locator) {
  await card.scrollIntoViewIfNeeded()
  const approve = card.getByRole('button', { name: 'Approve' })
  const deny = card.getByRole('button', { name: 'Deny' })
  await expect(approve).toBeVisible()
  await expect(deny).toBeVisible()
  expect(await isOnTop(approve)).toBe(true)
  expect(await isOnTop(deny)).toBe(true)
  const paint = await card.evaluate((el) => {
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const parse = (value: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(value)
      if (!m) return null
      const parts = m[1]!
        .split(/[,/ ]+/)
        .filter(Boolean)
        .map(Number)
      return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 }
    }
    const style = getComputedStyle(el)
    const bg = parse(style.backgroundColor)
    // Every readable part against the nearest opaque background behind it.
    const ratios = [...el.querySelectorAll('button, h2, h3, p, strong')]
      .filter((node) => node.getClientRects().length > 0 && (node.textContent ?? '').trim())
      .map((node) => {
        const fg = parse(getComputedStyle(node).color)
        let backing = null
        for (let n: Element | null = node; n && !backing; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor)
          if (c && c.alpha >= 1) backing = c
        }
        if (!fg || !backing) return 0
        const a = lum(fg.rgb)
        const b = lum(backing.rgb)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      })
    return {
      alpha: bg?.alpha ?? 0,
      image: style.backgroundImage,
      blur: style.backdropFilter,
      opacity: style.opacity,
      minContrast: Math.min(...ratios),
    }
  })
  // Solid, no picture or blur behind its text, readable.
  expect(paint.alpha).toBe(1)
  expect(paint.image).toBe('none')
  expect(paint.blur).toBe('none')
  expect(paint.opacity).toBe('1')
  expect(paint.minContrast).toBeGreaterThanOrEqual(4.5)
}

test.describe('layout options never weaken a protected surface', () => {
  for (const [name, layout] of Object.entries(hostileLayouts)) {
    test(`${name}: the approval in Chat and the Needs-you card on Now`, async ({ page }) => {
      const look: Look = { active: layout.id, mode: 'light' }
      await mockThemes(page, [layout], look)
      await page.route('**/api/themes/*/assets/**', (route) =>
        route.fulfill({ body: samplePng(960, 640), contentType: 'image/png' }),
      )
      await pair(page)
      const { card, roomId } = await startApproval(page)
      if (name === 'glassPale') {
        // Pale text on a pale glass card: the protected surfaces wear Score's own colours (the contrast fallback), so
        // the card stays readable whether or not the guard also switches the theme off.
        await page.waitForTimeout(1500)
        await assertProtectedHolds(card)
        await card.getByRole('button', { name: 'Approve' }).click()
        await expect(card.getByText('Approved by you')).toBeVisible({ timeout: 15_000 })
        return
      }
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await assertProtectedHolds(card)
      // Needs-you stays in the navigation: on Now, or on the menu button / first entry when Now is not in the menu.
      await expect(page.getByRole('img', { name: 'Needs you' }).first()).toBeAttached()
      // The Needs-you card on Now.
      await page.goto('/now')
      const ask = page.getByRole('region', { name: 'Needs you' })
      await expect(ask).toBeVisible()
      await assertProtectedHolds(ask)
      // Settings can't be hidden, and the way back is on its page.
      await page.goto('/settings')
      await expect(page.getByRole('region', { name: 'Look' })).toBeVisible()
      await expect(
        page
          .getByRole('region', { name: 'Look' })
          .getByRole('button', { name: 'Reset look on this device' }),
      ).toBeVisible()
      // No banner: the guard didn't have to switch the theme off.
      await expect(page.locator('.look-banner')).toHaveCount(0)
      await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
      await page.goto(`/chat/${roomId}`)
      await page
        .getByRole('group', { name: /^Approval: / })
        .last()
        .getByRole('button', { name: 'Approve' })
        .click()
      await expect(
        page
          .getByRole('group', { name: /^Approval: / })
          .last()
          .getByText('Approved by you'),
      ).toBeVisible({ timeout: 15_000 })
    })
  }

  test('a theme can’t take Settings out of the menu, whatever the navigation', async ({ page }) => {
    for (const nav of ['top', 'left', 'right', 'launcher'] as const) {
      const hide = layoutTheme(`hide-${nav}`, { layout: { nav, menu: [{ to: '/chat' }] } })
      await mockThemes(page, [hide], { active: hide.id, mode: 'light' })
      await pair(page)
      await page.goto('/now')
      await expect(page.locator('html')).toHaveAttribute('data-nav', nav)
      if (nav === 'launcher') await page.getByRole('button', { name: 'Menu' }).click()
      const links =
        nav === 'launcher'
          ? page.getByRole('dialog', { name: 'Menu' })
          : page.getByRole('navigation', { name: 'Main' })
      await expect(links.getByRole('link', { name: 'Settings' })).toBeVisible()
      await expect(links.getByRole('link', { name: 'Tasks' })).toHaveCount(0)
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    }
  })
})
