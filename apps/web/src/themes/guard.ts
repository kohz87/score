import { parseComputedColor } from './color.ts'
import { backgroundLayers, hidesWhatIsBelow, worstContrast, type Layer } from './contrast.ts'
import { appliedThemeElements, appliedThemeSheets } from './engine.ts'

// The last line of defence for protected surfaces (design §4.3). styles/protected.css re-asserts what CSS can
// re-assert; what a theme can still do from the outside (hide a button by its tag name, fade an ancestor, cover the
// card, push it off-screen, set a descendant's own font) is caught here: every protected surface is measured with the
// theme on and with the theme's sheets lifted, and a theme that makes any of them worse is switched off.

type Snapshot = {
  rendered: boolean
  chainOpacity: number
  chainFilter: boolean
  chainClip: boolean
  size: number
  onScreen: boolean
  covered: boolean
  themeFont: boolean
  fontSize: number
  /** The text's contrast with what is painted behind it; null when that can't be measured (an image, an odd colour). */
  contrast: number | null
  /** WCAG "large text": 3:1 is enough, otherwise 4.5:1. */
  large: boolean
}

const CONTROLS =
  'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]'

function chain(element: Element): Element[] {
  const out: Element[] = []
  for (let node: Element | null = element; node; node = node.parentElement) out.push(node)
  return out
}

// Colours set through the theme's tokens or its own rules (white on white, transparent text) leave a surface in place
// but unreadable: measured against the backgrounds stacked behind the text, up to the first opaque one.
function textContrast(element: HTMLElement): number | null {
  const text = parseComputedColor(getComputedStyle(element).color)
  if (!text) return null
  const stack: Layer[] = []
  for (const node of chain(element)) {
    const computed = getComputedStyle(node)
    const page = node === document.body || node === document.documentElement
    const layers = backgroundLayers(
      computed.backgroundImage,
      computed.backgroundColor,
      page ? 'ignore' : 'worst',
    )
    if (!layers) return null
    stack.push(...layers)
    if (hidesWhatIsBelow(layers)) break
  }
  return worstContrast(text, stack)
}

function snapshot(element: HTMLElement): Snapshot {
  const rects = element.getClientRects()
  const rendered = rects.length > 0
  const style = getComputedStyle(element)
  let chainOpacity = 1
  let chainFilter = false
  let chainClip = false
  for (const node of chain(element)) {
    const computed = getComputedStyle(node)
    chainOpacity *= Number(computed.opacity)
    if (computed.filter !== 'none') chainFilter = true
    if (computed.clipPath !== 'none' || computed.maskImage !== 'none') chainClip = true
  }
  const control = element.matches(CONTROLS)
  const ownText = carriesText(element) || (control && (element.textContent ?? '').trim() !== '')
  const box = element.getBoundingClientRect()
  const inViewport =
    box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
  let covered = false
  if (rendered && inViewport && box.width > 0 && box.height > 0) {
    const x = Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2))
    const top = document.elementFromPoint(x, y)
    // Something else on top of the centre of a visible surface (a modal is not "something else": it has its own
    // top layer, so the surface is covered in both measurements and does not count).
    covered = !!top && !element.contains(top) && !top.contains(element)
  }
  return {
    rendered,
    chainOpacity,
    chainFilter,
    chainClip,
    size: box.width * box.height,
    onScreen: inViewport,
    covered,
    themeFont: /theme-[a-z0-9-]+-/i.test(style.fontFamily),
    fontSize: Number.parseFloat(style.fontSize) || 0,
    // Words need 4.5:1; a control with only an icon is a graphic, 3:1. A surface with no text of its own (a card, a
    // dot) has nothing to measure: its words are separate targets.
    contrast: ownText || control ? textContrast(element) : null,
    large: isLargeText(style) || !ownText,
  }
}

function isLargeText(style: CSSStyleDeclaration): boolean {
  const px = Number.parseFloat(style.fontSize) || 0
  const bold = Number.parseInt(style.fontWeight, 10) >= 700
  return px >= 24 || (bold && px >= 18.66)
}

/**
 * What a theme did to a text's contrast, or null. AA is the bar (4.5:1, 3:1 for large text) wherever the theme made
 * it worse than Score's own; a colour that can't be measured is a failure too, never a pass (gate finding #4).
 */
export function contrastVerdict(
  on: number | null,
  off: number | null,
  large: boolean,
): string | null {
  const needed = large ? 3 : 4.5
  if (on === null) return off === null ? null : 'has text whose colours can’t be checked'
  if (on >= needed) return null
  if (off === null || on < off - 0.05) return 'has unreadable text'
  return null
}

function worse(on: Snapshot, off: Snapshot): string | null {
  if (off.rendered && !on.rendered) return 'is not shown'
  if (!off.rendered) return null
  if (on.chainOpacity < off.chainOpacity - 0.02) return 'is faded'
  if (on.chainFilter && !off.chainFilter) return 'is filtered'
  if (on.chainClip && !off.chainClip) return 'is clipped'
  if (off.size > 0 && on.size < off.size * 0.5) return 'is shrunk'
  if (off.onScreen && !on.onScreen) return 'is pushed off screen'
  if (on.covered && !off.covered) return 'is covered'
  if (on.themeFont && !off.themeFont) return 'is set in the theme’s font'
  if (off.fontSize > 0 && on.fontSize < off.fontSize * 0.5) return 'has tiny text'
  return contrastVerdict(on.contrast, off.contrast, on.large)
}

// Every element that shows text of its own (whatever its tag: the approval's title and description are spans) or is a
// control, not a fixed list of tags (gate finding #3).
function carriesText(el: Element): boolean {
  for (const node of Array.from(el.childNodes))
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') return true
  return false
}

function parts(surface: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [surface]
  for (const el of Array.from(surface.querySelectorAll<HTMLElement>('*'))) {
    if (el.closest('svg') || el.closest('[hidden], [inert], details:not([open])') || el.hidden)
      continue
    if (el.matches(CONTROLS) || carriesText(el)) found.push(el)
  }
  return found
}

// Glyph shapes (finding #5): an agent is told apart by its shape, so what the shapes paint is compared, not just
// whether their wrapper is shown: geometry (`d`, size), paint and everything that can hide or move a path.
const SHAPES = 'path, circle, rect, ellipse, polygon, polyline, line'

function shapes(surface: HTMLElement): SVGGraphicsElement[] {
  return Array.from(surface.querySelectorAll<SVGGraphicsElement>(SHAPES)).filter(
    (el) => !el.closest('[hidden]'),
  )
}

function paints(paint: string, width: number): boolean {
  if (paint === 'none' || width <= 0) return false
  const color = parseComputedColor(paint)
  return color === null || color[3] > 0.05
}

function shapeSignature(el: SVGGraphicsElement): string {
  const style = getComputedStyle(el)
  let box = { width: 0, height: 0 }
  try {
    box = el.getBBox()
  } catch {
    // Not rendered: the zero size says so.
  }
  const parent = el.ownerSVGElement ? getComputedStyle(el.ownerSVGElement) : style
  return [
    style.getPropertyValue('d'),
    style.opacity,
    style.visibility,
    style.display,
    style.transform,
    // Colours follow the theme's tokens (currentColor): what counts is that something is painted at all.
    paints(style.fill, 1) || paints(style.stroke, Number.parseFloat(style.strokeWidth) || 0),
    style.clipPath,
    style.maskImage,
    style.filter,
    parent.opacity,
    parent.visibility,
    parent.filter,
    Math.round(box.width * 10),
    Math.round(box.height * 10),
  ].join('|')
}

/** Runs with the theme's own sheets lifted, then puts them back before anything is painted. */
function withoutTheme<T>(run: () => T): T {
  const sheets = appliedThemeSheets()
  const elements = appliedThemeElements()
  const before = [...document.adoptedStyleSheets]
  const disabled = elements.map((el) => el.disabled)
  document.adoptedStyleSheets = before.filter((sheet) => !sheets.includes(sheet))
  elements.forEach((el) => {
    el.disabled = true
  })
  try {
    return run()
  } finally {
    document.adoptedStyleSheets = before
    elements.forEach((el, i) => {
      el.disabled = disabled[i] ?? false
    })
  }
}

/** The first thing a theme did to a protected surface that the layer could not stop, or null. */
export function findProtectedViolation(root: ParentNode = document): string | null {
  const surfaces = Array.from(root.querySelectorAll<HTMLElement>('[data-protected]')).filter(
    (el) => !el.closest('[hidden]'),
  )
  if (surfaces.length === 0) return null
  const targets = surfaces.flatMap(parts)
  const glyphShapes = surfaces.flatMap(shapes)
  const on = targets.map(snapshot)
  const shapesOn = glyphShapes.map(shapeSignature)
  const { off, shapesOff } = withoutTheme(() => ({
    off: targets.map(snapshot),
    shapesOff: glyphShapes.map(shapeSignature),
  }))
  for (let i = 0; i < glyphShapes.length; i++)
    if (shapesOn[i] !== shapesOff[i]) {
      const owner = glyphShapes[i]!.closest('[aria-label]')?.getAttribute('aria-label')
      return `${owner ?? 'an agent glyph'} changed shape`
    }
  for (let i = 0; i < targets.length; i++) {
    const problem = worse(on[i]!, off[i]!)
    if (problem) {
      const name = targets[i]!.getAttribute('aria-label') ?? targets[i]!.tagName.toLowerCase()
      return `${name} ${problem}`
    }
  }
  return null
}

/**
 * Watches the page while a custom theme is on: when a protected surface is damaged, `onViolation` runs once (the
 * runtime then drops the theme). Re-checks on DOM changes (debounced) and window resizes.
 */
export function watchProtectedSurfaces(onViolation: (what: string) => void): () => void {
  let frame = 0
  let timer = 0
  let done = false
  const check = () => {
    frame = 0
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const problem = findProtectedViolation()
    if (problem) {
      done = true
      onViolation(problem)
    }
  }
  const schedule = () => {
    if (done || frame || timer) return
    timer = window.setTimeout(() => {
      timer = 0
      frame = requestAnimationFrame(check)
    }, 120)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  window.addEventListener('resize', schedule)
  schedule()
  return () => {
    done = true
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    window.clearTimeout(timer)
    cancelAnimationFrame(frame)
  }
}
