import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyCustom, appliedThemeElements, clearLook } from './engine.ts'
import {
  KNOWN_BACKDROPS,
  KNOWN_OVERLAYS,
  decisionProblem,
  findProtectedViolation,
} from './guard.ts'

// Re-gate findings 4 and 5 (decision 102): clipping, painted hits and the page picture, measured against a real
// no-theme baseline. jsdom has no layout, so geometry and the theme's effect are staged: the "theme" is the engine's
// own style element (lifted by the guard when it measures the baseline), and a stand-in for getComputedStyle adds what
// a stylesheet jsdom can't parse.
type Rect = [number, number, number, number]

let rects: Record<string, Rect> = {}
/** Where an element sits while the theme is on, when that differs from `rects` (the theme's own layout). */
let rectsOn: Record<string, Rect> = {}
let themeOn = () => true
let hit: (x: number, y: number) => Element | null = () => null

function rectOf(element: Element): DOMRect {
  const [left, top, width, height] = (themeOn() ? rectsOn[element.id] : undefined) ??
    rects[element.id] ?? [0, 0, 0, 0]
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

/** Per-element style overrides while the theme is on (the real getComputedStyle answers everything else). */
function stage(overrides: Record<string, Record<string, string>>) {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo)
      const extra = themeOn() ? overrides[element.id] : undefined
      if (!extra) return style
      return new Proxy(style, {
        get(target, key) {
          if (typeof key === 'string' && key in extra) return extra[key]
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  )
}

beforeEach(() => {
  rects = {}
  rectsOn = {}
  themeOn = () => !appliedThemeElements().every((el) => el.disabled)
  hit = () => null
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this)
  })
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const box = rectOf(this)
    return (box.width > 0 ? [box] : []) as unknown as DOMRectList
  })
  document.elementFromPoint = (x: number, y: number) => hit(x, y)
  applyCustom(
    { id: 'edge', manifest: { format: 1, id: 'edge', name: 'Edge' } as never, css: '' },
    'light',
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  clearLook()
  document.body.innerHTML = ''
})

describe('re-gate finding 4: clipping and the painted hit', () => {
  function clippedDecision() {
    document.body.innerHTML =
      '<div id="pane"><div id="card" data-protected><button id="go">Approve</button></div></div>'
    rects = { pane: [0, 0, 300, 1], card: [0, 0, 300, 40], go: [10, 0, 100, 40] }
    stage({ pane: { overflowX: 'clip', overflowY: 'clip' } })
    // The hit test finds the clipping ancestor, which is all that paints there.
    hit = () => (themeOn() ? document.getElementById('pane') : document.getElementById('go'))
  }

  test('a decision cut away by an ancestor that clips is reported', () => {
    clippedDecision()
    expect(findProtectedViolation()).toMatch(/clipped|covered/)
  })

  test('and a click on it is refused', () => {
    clippedDecision()
    expect(decisionProblem(document.getElementById('go')!)).toMatch(/clipped|covered/)
  })

  test('an ancestor answering the hit test is a covered control, not a pass', () => {
    document.body.innerHTML =
      '<div id="pane"><div id="card" data-protected><button id="go">Approve</button></div></div>'
    rects = { pane: [0, 0, 300, 200], card: [0, 0, 300, 40], go: [10, 0, 100, 40] }
    hit = () => (themeOn() ? document.getElementById('pane') : document.getElementById('go'))
    expect(decisionProblem(document.getElementById('go')!)).toMatch(/covered/)
  })

  test('the same hit with the theme gone is not the theme’s doing', () => {
    document.body.innerHTML =
      '<div id="pane"><div id="card" data-protected><button id="go">Approve</button></div></div>'
    rects = { pane: [0, 0, 300, 200], card: [0, 0, 300, 40], go: [10, 0, 100, 40] }
    hit = () => document.getElementById('pane')
    expect(decisionProblem(document.getElementById('go')!)).toBeNull()
  })

  test('a control’s own label may be what paints', () => {
    document.body.innerHTML =
      '<div id="card" data-protected><label id="label"><input id="go" type="checkbox"> Allow</label></div>'
    rects = { card: [0, 0, 300, 40], label: [0, 0, 100, 20], go: [0, 0, 20, 20] }
    hit = () => document.getElementById('label')
    expect(decisionProblem(document.getElementById('go')!)).toBeNull()
  })

  test('Score’s own sticky bars and drawers over a control are not a theme’s doing', () => {
    document.body.innerHTML =
      '<div class="top-bar" id="bar"></div><div id="card" data-protected><button id="go">Approve</button></div>'
    rects = { card: [0, 0, 300, 40], go: [10, 0, 100, 40], bar: [0, 0, 300, 40] }
    stage({ bar: { position: 'sticky' } })
    hit = () => (themeOn() ? document.getElementById('bar') : document.getElementById('go'))
    expect(decisionProblem(document.getElementById('go')!)).toBeNull()
  })

  for (const position of ['absolute', 'sticky']) {
    test(`a known bar stretched over the page is the cover it looks like (${position})`, () => {
      document.body.innerHTML =
        '<div class="top-bar" id="bar"></div><div id="card" data-protected><button id="go">Approve</button></div>'
      rects = { card: [0, 0, 300, 40], go: [10, 0, 100, 40], bar: [0, 0, 1024, 768] }
      stage({ bar: { position } })
      hit = () => (themeOn() ? document.getElementById('bar') : document.getElementById('go'))
      expect(findProtectedViolation()).toMatch(/covered/)
    })
  }

  test('a fixed element is no longer exempt just because it is fixed', () => {
    document.body.innerHTML =
      '<div id="cover"></div><div id="card" data-protected><button id="go">Approve</button></div>'
    rects = { card: [0, 0, 300, 40], go: [10, 0, 100, 40], cover: [0, 0, 300, 40] }
    stage({ cover: { position: 'fixed' } })
    hit = () => (themeOn() ? document.getElementById('cover') : document.getElementById('go'))
    expect(findProtectedViolation()).toMatch(/covered/)
    expect(decisionProblem(document.getElementById('go')!)).toMatch(/covered/)
  })
})

describe('re-gate finding 5: text over a page picture', () => {
  test('a translucent rail over a picture with no veil, read as it would paint (black to white)', () => {
    document.body.innerHTML =
      '<nav id="rail" class="top-bar"><button id="settings" data-protected="raised" style="color: rgb(94, 98, 108)">Settings</button></nav>'
    rects = { rail: [0, 0, 200, 400], settings: [10, 10, 100, 30] }
    document.body.id = 'page'
    // What the theme paints: a black picture on the page (no veil: dim 0) and 70% white glass on the rail.
    stage({
      page: { backgroundImage: 'url("/black.png")' },
      rail: { backgroundColor: 'rgba(255, 255, 255, 0.7)' },
    })
    expect(findProtectedViolation()).toBe('button has unreadable text')
  })
})

describe('the baseline is the page with the theme’s own CSS gone', () => {
  test('the boot copy of the theme is lifted while the baseline is measured, the layout attributes stay, and all is back afterwards', () => {
    document.body.innerHTML = '<div id="card" data-protected><button id="go">Approve</button></div>'
    rects = { card: [0, 0, 300, 40], go: [10, 0, 100, 40] }
    const boot = document.createElement('style')
    boot.id = 'score-look-boot'
    document.head.append(boot)
    const seen: boolean[] = []
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element: Element, pseudo?: string | null) => {
        seen.push(boot.disabled)
        expect(document.documentElement.getAttribute('data-nav')).toBe('left')
        return real(element, pseudo)
      },
    )
    document.documentElement.setAttribute('data-nav', 'left')
    findProtectedViolation()
    expect(seen).toContain(true)
    expect(seen).toContain(false)
    expect(boot.disabled).toBe(false)
    boot.remove()
  })
})

describe('the list of Score’s own fixed and sticky things', () => {
  const root = join(import.meta.dirname, '..')
  function css(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return css(path)
      return name.endsWith('.css') ? [path] : []
    })
  }

  test('names the class of every rule that makes something fixed or sticky', () => {
    const known = new Set(`${KNOWN_OVERLAYS} ${KNOWN_BACKDROPS}`.match(/\.[a-z][\w-]*/g))
    const missing: string[] = []
    for (const file of css(root)) {
      const text = readFileSync(file, 'utf8')
      for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/position:\s*(fixed|sticky)/.test(rule[2]!)) continue
        for (const selector of rule[1]!.split(',')) {
          const classes = selector.match(/\.[a-z][\w-]*/g) ?? []
          if (classes.length > 0 && !classes.some((name) => known.has(name)))
            missing.push(`${file}: ${selector.trim()}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

// Third gate, finding 3: graphics that stand alone are measured too (WCAG 1.4.11, 3:1), against what is painted around
// them: a bare glyph's colour against its own plate or what the theme painted behind it; a Needs-you dot against the
// edge it wears, or the page behind it when it has none.
describe('third gate finding 3: non-text contrast of glyphs and Needs-you dots', () => {
  const glyph = (extra = '') =>
    `<div id="row"><svg id="g" class="agent-glyph" data-protected="inline-flex" aria-label="lead, circle-dot" style="--glyph-color: #6b4eff; ${extra}"></svg></div>`

  test('a bare glyph on a background of its own colour is reported', () => {
    document.body.innerHTML = glyph()
    rects = { row: [0, 0, 60, 20], g: [0, 0, 12, 12] }
    stage({ row: { backgroundColor: 'rgb(107, 78, 255)' } })
    expect(findProtectedViolation()).toBe(
      'lead, circle-dot can’t be told apart from its background',
    )
  })

  test('the same glyph on a plate of its own (Score’s protected layer) is fine, whatever the row paints', () => {
    document.body.innerHTML = glyph('background-color: #ffffff')
    rects = { row: [0, 0, 60, 20], g: [0, 0, 12, 12] }
    stage({ row: { backgroundColor: 'rgb(107, 78, 255)' } })
    expect(findProtectedViolation()).toBeNull()
  })

  test('a glyph on a picture the theme painted is reported too (anything from black to white)', () => {
    document.body.innerHTML = glyph()
    rects = { row: [0, 0, 60, 20], g: [0, 0, 12, 12] }
    stage({ row: { backgroundImage: 'url("x.png")' } })
    expect(findProtectedViolation()).toBe(
      'lead, circle-dot can’t be told apart from its background',
    )
  })

  const dot = (style = '') =>
    `<div id="link"><span id="d" class="needs-you-dot" role="img" aria-label="Needs you" data-protected="block" style="background-color: rgb(255, 107, 138); ${style}"></span></div>`

  test('a Needs-you dot on a background of its own colour is reported', () => {
    document.body.innerHTML = dot()
    rects = { link: [0, 0, 80, 30], d: [70, 10, 7, 7] }
    stage({ link: { backgroundColor: 'rgb(255, 107, 138)' } })
    expect(findProtectedViolation()).toBe('Needs you can’t be told apart from its background')
  })

  test('with Score’s ink edge it is read against that edge, whatever is behind it', () => {
    document.body.innerHTML = dot('border: 1.5px solid #12131a')
    rects = { link: [0, 0, 80, 30], d: [70, 10, 10, 10] }
    stage({ link: { backgroundColor: 'rgb(255, 107, 138)' } })
    expect(findProtectedViolation()).toBeNull()
  })

  test('the default page behind it (no theme paint) is not a violation', () => {
    document.body.innerHTML = dot()
    rects = { link: [0, 0, 80, 30], d: [70, 10, 7, 7] }
    expect(findProtectedViolation()).toBeNull()
  })
})

describe('the shape signature and protected override', () => {
  test('protected.css pins every glyph part, with no clip or mask', () => {
    const css = readFileSync('src/styles/protected.css', 'utf8')
    const pinned = /\[data-protected\] svg \*,[^{]*\{([^}]*)\}/.exec(css)![1]!
    for (const property of ['opacity', 'visibility', 'filter', 'scale', 'rotate', 'translate'])
      expect(pinned).toContain(property)
    expect(css).toMatch(/clip-path: none !important;/)
    expect(css).toMatch(/mask: none !important;/)
  })
})

describe('pushed off screen', () => {
  // A long list: the theme-off baseline lays it out in the document's flow, the theme in a column that scrolls itself.
  // The card is far below the document's end in the second layout, and scrolling that column brings it back.
  function longList(overflowY: string, cardTop: number) {
    document.body.innerHTML =
      '<div id="pane"><div id="card" data-protected><span id="words">May I install it?</span></div></div>'
    rects = { pane: [0, 0, 400, 600], card: [0, 100, 400, 80], words: [10, 110, 200, 20] }
    rectsOn = {
      pane: [0, 0, 400, 600],
      card: [0, cardTop, 400, 80],
      words: [10, cardTop + 10, 200, 20],
    }
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 800,
      configurable: true,
    })
    Object.defineProperty(document.documentElement, 'scrollWidth', {
      value: 800,
      configurable: true,
    })
    Object.defineProperty(document.getElementById('pane')!, 'scrollHeight', {
      value: 4000,
      configurable: true,
    })
    Object.defineProperty(document.getElementById('pane')!, 'scrollWidth', {
      value: 400,
      configurable: true,
    })
    stage({ pane: { overflowY, overflowX: 'visible' } })
  }

  test('a card the theme puts far down a pane that scrolls itself is still reachable', () => {
    longList('auto', 1500)
    expect(findProtectedViolation()).toBeNull()
  })

  test('the same card below the document with nothing to scroll is pushed off screen', () => {
    longList('visible', 1500)
    expect(findProtectedViolation()).toMatch(/pushed off screen/)
  })

  test('and a card beyond the end of the pane’s own scroll is too', () => {
    longList('auto', 5000)
    expect(findProtectedViolation()).toMatch(/pushed off screen/)
  })
})

// 3.5.0 review: a pane counts only when its scrolling carries the card.
describe('pushed off screen, hostile layouts', () => {
  function staged(html: string, overrides: Record<string, Record<string, string>>, cardTop = 1500) {
    document.body.innerHTML = html
    rects = {
      outer: [0, 0, 400, 700],
      pane: [0, 0, 400, 600],
      card: [0, 100, 400, 80],
      words: [10, 110, 200, 20],
    }
    rectsOn = { ...rects, card: [0, cardTop, 400, 80], words: [10, cardTop + 10, 200, 20] }
    for (const [key, value] of [
      ['scrollHeight', 800],
      ['scrollWidth', 800],
    ] as const)
      Object.defineProperty(document.documentElement, key, { value, configurable: true })
    const pane = document.getElementById('pane')!
    Object.defineProperty(pane, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(pane, 'scrollWidth', { value: 400, configurable: true })
    stage(overrides)
  }
  const card = '<div id="card" data-protected><span id="words">May I install it?</span></div>'

  test('a fixed card far below, inside a pane that scrolls, is pushed off screen', () => {
    staged(`<div id="pane">${card}</div>`, {
      pane: { overflowY: 'auto', overflowX: 'visible' },
      card: { position: 'fixed' },
    })
    expect(findProtectedViolation()).toMatch(/pushed off screen/)
  })

  test('an absolute card whose containing block is above the pane is pushed off screen', () => {
    staged(`<div id="outer"><div id="pane">${card}</div></div>`, {
      outer: { position: 'relative' },
      pane: { overflowY: 'auto', overflowX: 'visible' },
      card: { position: 'absolute' },
    })
    expect(findProtectedViolation()).toMatch(/pushed off screen/)
  })

  test('an absolute card in a positioned pane that scrolls is reachable', () => {
    staged(`<div id="pane">${card}</div>`, {
      pane: { overflowY: 'auto', overflowX: 'visible', position: 'relative' },
      card: { position: 'absolute' },
    })
    expect(findProtectedViolation()).toBeNull()
  })

  test('a pane too small to show the card does not count', () => {
    staged(`<div id="pane">${card}</div>`, { pane: { overflowY: 'auto', overflowX: 'visible' } })
    rectsOn = { ...rectsOn, pane: [0, 0, 400, 6] }
    expect(findProtectedViolation()).toMatch(/pushed off screen/)
  })

  test('a card down a fixed side pane that scrolls itself is reachable while the pane is on screen', () => {
    staged(`<div id="pane">${card}</div>`, {
      pane: { overflowY: 'auto', overflowX: 'visible', position: 'fixed' },
    })
    expect(findProtectedViolation()).toBeNull()
  })
})

test('a card in an inner pane the outer pane can never scroll to is pushed off screen (3.5.0 review)', () => {
  document.body.innerHTML =
    '<div id="outer"><div id="pane"><div id="card" data-protected><span id="words">May I install it?</span></div></div></div>'
  rects = {
    outer: [0, 0, 400, 600],
    pane: [0, 0, 400, 300],
    card: [0, 100, 400, 80],
    words: [10, 110, 200, 20],
  }
  // The inner pane sits 5000px above the outer pane's content; the card lands back inside the outer extent.
  rectsOn = {
    ...rects,
    pane: [0, -5000, 400, 300],
    card: [0, 4000, 400, 80],
    words: [10, 4010, 200, 20],
  }
  for (const [key, value] of [
    ['scrollHeight', 800],
    ['scrollWidth', 800],
  ] as const)
    Object.defineProperty(document.documentElement, key, { value, configurable: true })
  for (const [id, height] of [
    ['outer', 10000],
    ['pane', 10000],
  ] as const) {
    const node = document.getElementById(id)!
    Object.defineProperty(node, 'scrollHeight', { value: height, configurable: true })
    Object.defineProperty(node, 'scrollWidth', { value: 400, configurable: true })
  }
  stage({
    outer: { overflowY: 'auto', overflowX: 'visible' },
    pane: { overflowY: 'auto', overflowX: 'visible' },
  })
  expect(findProtectedViolation()).toMatch(/pushed off screen/)
})
