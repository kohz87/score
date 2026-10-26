import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'
import { allowIt, isOnTop, startApproval } from './themes-decision.ts'

// Phase 9 gate fixes (decision 101, G1): a theme can't reach inside a protected subtree, and what it can still do from
// outside (fade an ancestor, animate, hover) never leaves a decision unreadable: each attempt below ends with the
// decision visible and readable, either because the theme never got there or because Score fell back to its own look.
// The theme's server routes are mocked per contract § 16.

function gate(css: string, manifest: Record<string, unknown> = {}): MockTheme {
  return { id: 'gate', name: 'Gate', source: 'imported', manifest, css }
}

async function wear(page: Page, css: string, manifest: Record<string, unknown> = {}) {
  const look: Look = { active: 'gate', mode: 'light' }
  await mockThemes(page, [gate(css, manifest)], look)
  await pair(page)
}

/** The new shell's room with the fixture approval, wearing the gate theme. Resolves with the Needs-you card. */
async function wearApproval(page: Page, css: string, manifest: Record<string, unknown> = {}) {
  const found = await startApproval(page, [gate(css, manifest)], { active: 'gate', mode: 'light' })
  return { ...found, url: '/b' }
}

/** Lets the guard's debounce and any delayed animation run. */
async function settle(page: Page, ms = 1600) {
  await page.waitForTimeout(ms)
}

/**
 * What a person looking at `root` could not read or reach: every element that carries text or is a control must be
 * displayed, visible, opaque, painted in a colour that contrasts with what is behind it, and on top where it is.
 * Colours go through a canvas so any CSS colour syntax is measured.
 */
async function unreadable(root: Locator): Promise<string[]> {
  return root.evaluate((surface) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const d = context.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    const luminance = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const problems: string[] = []
    const all = [surface, ...Array.from(surface.querySelectorAll('*'))].filter(
      (el) => !el.closest('svg') || el === surface,
    )
    for (const el of all) {
      const own = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
      )
      const control = el.matches('button, a[href], input, select, textarea')
      if (!own && !control) continue
      // Closed on purpose: the content of a collapsed <details> (outside its summary) is not on screen, whatever the
      // theme does. Chrome gives it no layout box, or none until something forces one, which made this check flaky.
      const collapsed = (() => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const parent = n.parentElement
          if (parent instanceof HTMLDetailsElement && !parent.open && n.tagName !== 'SUMMARY')
            return true
        }
        return false
      })()
      if (collapsed) continue
      const name = `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ')[0]}`
      let opacity = 1
      for (let n: Element | null = el; n; n = n.parentElement) {
        const s = getComputedStyle(n)
        opacity *= Number(s.opacity)
        if (s.display === 'none') problems.push(`${name}: display none (${n.tagName})`)
        if (s.visibility !== 'visible') problems.push(`${name}: ${s.visibility}`)
        if (s.filter !== 'none') problems.push(`${name}: filter`)
        if (s.clipPath !== 'none') problems.push(`${name}: clip`)
      }
      if (opacity < 0.7 && !(el as HTMLButtonElement).disabled)
        problems.push(`${name}: opacity ${opacity}`)
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) problems.push(`${name}: no box`)
      const style = getComputedStyle(el)
      const text = rgba(style.color)
      const fill = rgba(style.webkitTextFillColor)
      if (own && (text[3] < 1 || fill[3] < 1)) problems.push(`${name}: transparent text`)
      // Painted behind: the first opaque background up the chain.
      let back: [number, number, number, number] = [255, 255, 255, 1]
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor)
        if (c[3] > 0) {
          back = c
          if (c[3] >= 1) break
        }
      }
      const a = luminance(text)
      const b = luminance(back)
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      if (own && ratio < 4.5) problems.push(`${name}: contrast ${ratio.toFixed(2)}`)
    }
    return problems
  })
}

/** How each shape of a glyph is painted, as a string: geometry, paint and visibility. */
async function glyphPaint(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.agent-glyph')).flatMap((glyph) =>
      Array.from(glyph.querySelectorAll('path, circle, rect, polygon'))
        // The eyes animate (blink, look): their size differs between any two instants; protected.css pins their paint.
        .filter((shape) => !shape.closest('.agent-face'))
        .map((shape) => {
          const s = getComputedStyle(shape)
          const box = (shape as SVGGraphicsElement).getBBox()
          return [
            shape.tagName,
            s.opacity,
            s.visibility,
            s.display,
            s.transform,
            s.fill,
            s.stroke,
            s.strokeWidth,
            s.getPropertyValue('d'),
            s.clipPath,
            s.mask,
            s.filter,
            Math.round(box.width),
            Math.round(box.height),
          ].join('|')
        }),
    ),
  )
}

const CARD = 'article[aria-label^="Needs you:"]'
const harmless = '.main { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }'

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
    const plain = await glyphPaint(page)
    // (The room may have gained a message between the two loads: compare what the glyphs look like, not how many.)
    expect([...new Set(worn)].sort()).toEqual([...new Set(plain)].sort())
    expect(await isOnTop(page.locator('.agent-glyph').first())).toBe(true)
  })
})

test.describe('every decision surface is protected, not only the approval card', () => {
  holdLockPerTest('roster')

  test('#2: the add-coding-agent form keeps its permission controls, warning and password field', async ({
    page,
  }) => {
    await wear(
      page,
      '.team-coding-permission, .coding-reach, .coding-acknowledge { display: none; }' +
        '[role=dialog] fieldset, [role=dialog] legend, [role=dialog] [role=alert], [role=dialog] [role=note] { display: none; }' +
        '[role=dialog] input[type=password], [role=dialog] input[type=radio] { opacity: 0; }' +
        '[role=dialog] label { visibility: hidden; color: transparent; }',
    )
    await page.goto('/b/team?add=agent')
    const dialog = page.getByRole('dialog', { name: 'Add an agent' })
    await dialog.getByRole('radio', { name: /A coding tool/ }).check()
    await dialog.getByRole('radio', { name: 'Codex' }).check()
    await dialog.getByRole('radio', { name: /Full access/ }).check()
    await settle(page)
    const permission = dialog.getByRole('group', { name: 'Permission' })
    await expect(permission).toBeVisible()
    await expect(permission.getByRole('radio', { name: /Workspace write/ })).toBeVisible()
    await expect(permission.getByRole('alert')).toContainText(
      'Full access turns the CLI’s own sandbox off',
    )
    await expect(dialog.getByLabel('Security password')).toBeVisible()
    expect(await unreadable(permission)).toEqual([])
    expect(await unreadable(dialog.locator('label', { hasText: 'Security password' }))).toEqual([])
    await expect(dialog.getByRole('note').first()).toBeVisible()
    await expect(dialog.locator('label.coding-acknowledge')).toBeVisible()
  })
})

test.describe('the way back is always reachable (gate #8)', () => {
  const hideSettings =
    '.gear, .icon-btn, button[aria-label="Settings"], .searchbtn, .bold-tabbar button { display: none; opacity: 0; }' +
    'nav[aria-label="Main"] button:last-child { visibility: hidden; }' +
    '[role=dialog] button, [role=dialog] input { display: none; }'

  test('#8: Settings stays on the top bar and “Reset look” in the palette', async ({ page }) => {
    await wear(page, hideSettings)
    await page.goto('/b')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await settle(page)
    const settings = page.getByRole('button', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    expect(await unreadable(settings)).toEqual([])
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox', { name: 'Search or run a command' }).fill('reset look')
    const reset = palette.getByRole('option', { name: /Reset look on this device/ })
    await expect(reset).toBeVisible()
    expect(await unreadable(reset)).toEqual([])
    await reset.click()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('#8: the phone tab bar keeps Settings', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await wear(page, hideSettings)
    await page.goto('/b')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await settle(page)
    const settings = page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('button', { name: /Settings/ })
    await expect(settings).toBeVisible()
    expect(await unreadable(settings)).toEqual([])
  })

  test('#8: a theme can’t hide the palette itself', async ({ page }) => {
    await wear(
      page,
      '.bold-search-dialog { display: none; } .bold-search-scrim { display: none; } [role=dialog] { opacity: 0; }',
    )
    await page.goto('/b')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    // Either the theme never reached it, or Score noticed and put its own look back.
    await expect(palette).toBeVisible({ timeout: 10_000 })
    await settle(page)
    await expect(palette).toBeVisible()
    await expect(palette.getByRole('combobox', { name: 'Search or run a command' })).toBeVisible()
  })
})

test.describe('the guard measures contrast the way the Customizer does (gate #4)', () => {
  /** A rule that slipped past the sanitiser, written into the theme's own sheet; the guard must switch the theme off. */
  async function slipIn(page: Page, rule: string) {
    await page.evaluate((text) => {
      document.adoptedStyleSheets.at(-1)!.insertRule(text)
      document.body.append(document.createElement('i'))
    }, rule)
  }

  const cases: Record<string, string> = {
    // The finding's own reproduction: a valid computed colour the old parser could not read.
    'white in color() on white': `${CARD} button { color: color(srgb 1 1 1) !important; background-color: white !important; }`,
    // A colour space the measurement can't read must not pass as readable.
    'a colour that can’t be measured': `${CARD} button { color: color(rec2020 0.9 0.9 0.9) !important; background-color: white !important; }`,
    'oklch grey on white': `${CARD} button { color: oklch(0.99 0 0) !important; background-color: white !important; }`,
    // Measured, but below AA (4.5:1) while above the old 3:1 floor: 3.7:1.
    'grey text below AA': `${CARD} button { color: #858585 !important; background-color: white !important; }`,
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
