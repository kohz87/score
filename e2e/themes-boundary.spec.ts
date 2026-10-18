import { expect, test, type Locator, type Page } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

// Phase 9 re-gate H1 (decision 102): the trusted protected boundary, in a real browser. Theme CSS is an allowlist of
// visual properties (so most of what these specs inject is dropped before it gets here); protected.css is the second
// wall, so the same things injected after the sanitiser (as if it had missed one) still can't change what a
// decision reads like or what its way back sits on. The theme's server routes are mocked per contract § 16.

const BLACK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'

async function wear(page: Page, theme: Partial<MockTheme>) {
  const look: Look = { active: 'edge', mode: 'light' }
  await mockThemes(page, [{ id: 'edge', name: 'Edge', source: 'imported', ...theme }], look)
  await page.route('**/api/themes/edge/assets/**', (route) =>
    route.fulfill({ body: Buffer.from(BLACK_PNG, 'base64'), contentType: 'image/png' }),
  )
  await pair(page)
}

async function startApproval(page: Page) {
  const room = await makeRoom(page, 'edge')
  await say(page, room.id, `Please ask for approval before installing ${Date.now()}`)
  await page.goto(`/chat/${room.id}`)
  const card = page.getByRole('group', { name: /^Approval: / }).last()
  await expect(card.getByRole('button', { name: 'Approve' })).toBeAttached({ timeout: 20_000 })
  return card
}

test('re-gate 3: inherited typography from an ancestor can’t change how a decision reads', async ({
  page,
}) => {
  await wear(page, { css: '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }' })
  const card = await startApproval(page)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  // As if the sanitiser had missed these: an unlayered sheet on the ancestors.
  await page.addStyleTag({
    content:
      ':root, body, .chat-message, .chat-thread, main { word-spacing: -100px; letter-spacing: -4px; text-transform: uppercase; writing-mode: vertical-rl; text-indent: 400px; text-shadow: 0 0 30px red; }',
  })
  const read = await card.evaluate((surface) => {
    const style = getComputedStyle(surface)
    const button = surface.querySelector('button')!
    const own = getComputedStyle(button)
    return {
      wordSpacing: Number.parseFloat(style.wordSpacing) || 0,
      writingMode: style.writingMode,
      textShadow: style.textShadow,
      textIndent: Number.parseFloat(style.textIndent) || 0,
      buttonWordSpacing: Number.parseFloat(own.wordSpacing) || 0,
      buttonWritingMode: own.writingMode,
      buttonShadow: own.textShadow,
    }
  })
  expect(read).toEqual({
    wordSpacing: 0,
    writingMode: 'horizontal-tb',
    textShadow: 'none',
    textIndent: 0,
    buttonWordSpacing: 0,
    buttonWritingMode: 'horizontal-tb',
    buttonShadow: 'none',
  })
})

test('re-gate 5: a translucent rail over a black picture leaves the Settings link on an opaque background', async ({
  page,
}) => {
  await wear(page, {
    manifest: {
      layout: { nav: 'left' },
      shape: { surface: 'glass' },
      background: { image: 'asset:img/black.png', fit: 'cover', dim: 0 },
    },
    css: '.top-bar { background-color: rgb(255 255 255 / 70%); }',
  })
  await page.goto('/now')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const link = page.locator('a.main-nav-link[href="/settings"]')
  await expect(link).toBeVisible()
  const result = await link.evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const d = context.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const
    }
    const luminance = ([r, g, b]: readonly number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const style = getComputedStyle(element)
    const back = rgba(style.backgroundColor)
    const text = rgba(style.color)
    const a = luminance(text)
    const b = luminance(back)
    return {
      alpha: back[3],
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      current: element.getAttribute('aria-current'),
    }
  })
  expect(result.alpha).toBe(1)
  expect(result.ratio).toBeGreaterThanOrEqual(4.5)
  // The theme stays on: the link reads, so nothing needed to be switched off.
  await page.waitForTimeout(1500)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  await expect(page.locator('.look-banner')).toHaveCount(0)
})

// Third gate, finding 2: highlight pseudo-elements inherit through the tree separately from ordinary styles, so a rule on
// the root's ::selection would reach selected approval text although the root is outside every protected surface.
for (const [name, rule] of [
  [
    'the root alone (inherited down)',
    ':root::selection { color: transparent; background-color: transparent; }',
  ],
  [
    'every element',
    ':root::selection, body::selection, :root *::selection { color: transparent; background-color: transparent; }',
  ],
  [
    'the text colour as its own background',
    ':root *::selection { color: #ffffff; background-color: #ffffff; }',
  ],
] as const) {
  test(`third gate 2: a ::selection rule on ${name} can’t blank selected text inside a decision`, async ({
    page,
  }) => {
    await wear(page, { css: '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }' })
    const card = await startApproval(page)
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    // As if the sanitiser had missed it: an unlayered sheet after it.
    await page.addStyleTag({ content: rule })
    const read = await card.evaluate((surface) => {
      const target = surface.querySelector<HTMLElement>('p, span, b') ?? surface
      getSelection()!.selectAllChildren(surface)
      const highlight = getComputedStyle(target, '::selection')
      const own = getComputedStyle(surface, '::selection')
      return {
        text: highlight.color,
        back: highlight.backgroundColor,
        surfaceText: own.color,
        surfaceBack: own.backgroundColor,
      }
    })
    const clear = (value: string) =>
      /^rgba\(\d+, \d+, \d+, 0\)$/.test(value) || value === 'transparent'
    expect(clear(read.text)).toBe(false)
    expect(clear(read.surfaceText)).toBe(false)
    // The words differ from what is painted behind them while selected.
    expect(read.text).not.toBe(read.back)
    expect(read.surfaceText).not.toBe(read.surfaceBack)
  })
}

test('third gate 2: the same rule in the theme’s own CSS is dropped by the sanitiser, anywhere on the page', async ({
  page,
}) => {
  await wear(page, {
    css: '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); } :root::selection, body::selection { color: transparent; background-color: transparent; }',
  })
  const card = await startApproval(page)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const read = await card.evaluate((surface) => {
    getSelection()!.selectAllChildren(document.body)
    const clear = (value: string) => /^rgba\(\d+, \d+, \d+, 0\)$/.test(value)
    return {
      root: clear(getComputedStyle(document.documentElement, '::selection').color),
      body: clear(getComputedStyle(document.body, '::selection').color),
      card: clear(getComputedStyle(surface, '::selection').color),
    }
  })
  expect(read).toEqual({ root: false, body: false, card: false })
})

// Third gate, finding 3: an allowed background in the agent's own colour must not erase a bare glyph, nor a Needs-you
// dot. Measured on what is painted (a screenshot), not on computed colours: the widest contrast between two colours that
// each cover at least 5% of the middle of the box (`middle`: its share of the box, `pad`: pixels added around it).
async function painted(page: Page, box: Locator, { middle = 1, pad = 0 } = {}) {
  const at = (await box.boundingBox())!
  const clip = {
    x: at.x - pad,
    y: at.y - pad,
    width: at.width + 2 * pad,
    height: at.height + 2 * pad,
  }
  const png = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(
    async ([data, share]) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(image, 0, 0)
      const luminance = (r: number, g: number, b: number) => {
        const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const margin = (1 - share!) / 2
      const x0 = Math.floor(image.width * margin)
      const x1 = Math.ceil(image.width * (1 - margin))
      const y0 = Math.floor(image.height * margin)
      const y1 = Math.ceil(image.height * (1 - margin))
      const pixels = context.getImageData(x0, y0, x1 - x0, y1 - y0).data
      const counts = new Map<string, number>()
      for (let i = 0; i < pixels.length; i += 4) {
        // Neighbouring shades from anti-aliasing count as one colour.
        const key = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]
          .map((c) => Math.round(c / 8))
          .join(',')
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const colours = [...counts]
        .filter(([, n]) => n >= pixels.length / 4 / 20)
        .map(([key]) => key.split(',').map((c) => Number(c) * 8) as [number, number, number])
      const lights = colours.map(([r, g, b]) => luminance(r, g, b))
      return {
        colours: colours.length,
        ratio: (Math.max(...lights) + 0.05) / (Math.min(...lights) + 0.05),
      }
    },
    [png, middle] as const,
  )
}

test('third gate 3: a background in the agent’s own colour doesn’t erase a bare glyph', async ({
  page,
}) => {
  await wear(page, { css: '.chat-active-agents { background-color: #6b4eff; }' })
  await startApproval(page)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const glyph = page.locator('.chat-active-agents svg.agent-glyph').first()
  await expect(glyph).toBeVisible({ timeout: 20_000 })
  // The accepted rule is really painting the agent's colour behind it.
  expect(await glyph.evaluate((svg) => getComputedStyle(svg.parentElement!).backgroundColor)).toBe(
    'rgb(107, 78, 255)',
  )
  const result = await painted(page, glyph, { middle: 0.6 })
  expect(result.ratio).toBeGreaterThanOrEqual(3)
  // The theme was not switched off for it: the plate is Score's own.
  await page.waitForTimeout(1200)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
})

test('third gate 3: a Needs-you dot stays distinguishable on a background of its own colour', async ({
  page,
}) => {
  await wear(page, { css: '.main-nav-link, .top-bar { background-color: #ff6b8a; }' })
  await startApproval(page)
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const dot = page.locator('.needs-you-dot').first()
  await expect(dot).toBeAttached({ timeout: 20_000 })
  const dotColour = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
  const behind = await dot.evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor)
  expect(behind).toBe('rgb(255, 107, 138)')
  expect(dotColour).toBe('rgb(255, 107, 138)')
  const result = await painted(page, dot, { pad: 3 })
  expect(result.ratio).toBeGreaterThanOrEqual(3)
})

test('third gate 3: every agent colour gets a plate of at least 3:1, computed by the browser', async ({
  page,
}) => {
  await wear(page, { css: '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }' })
  await page.goto('/now')
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  const worst = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgb = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const d = context.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!] as const
    }
    const luminance = ([r, g, b]: readonly number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const colours = [
      '#6B4EFF',
      '#19C39A',
      '#FFB61E',
      '#FF6B8A',
      '#FFFFFF',
      '#000000',
      '#12131A',
      '#FF0000',
      '#FF41FF',
      '#00FF00',
      '#808080',
      '#7A7A7A',
      '#7F7F7F',
      '#00A0FF',
      '#C8C800',
    ]
    const out: { colour: string; ratio: number }[] = []
    for (const colour of colours) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('class', 'agent-glyph agent-glyph--xs')
      svg.setAttribute('data-protected', 'inline-flex')
      svg.setAttribute('style', `--glyph-color: ${colour}`)
      document.body.append(svg)
      const plate = getComputedStyle(svg).backgroundColor
      svg.remove()
      const a = luminance(rgb(colour))
      const b = luminance(rgb(plate))
      out.push({ colour, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) })
    }
    return out.sort((x, y) => x.ratio - y.ratio)[0]!
  })
  expect(worst.ratio, worst.colour).toBeGreaterThanOrEqual(3)
})
