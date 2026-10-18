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

// Score's own overlays (the composer, the menu drawer, toasts) are fixed or sticky and sit over scrolled content by
// design; where the content ends up under them depends on the theme's type and spacing, so being under one is not
// "covered". A theme can't make anything fixed or sticky (the sanitiser drops it), so this is never a theme's doing.
function isFloatingOverlay(element: Element): boolean {
  for (const node of chain(element)) {
    const position = getComputedStyle(node).position
    if (position === 'fixed' || position === 'sticky') return true
  }
  return false
}

/**
 * The middle of the element, if that point is inside the window and inside every scrolling box around the element:
 * what has been scrolled out of its pane isn't covered, it is just not in view.
 */
function visiblePoint(element: Element, box: DOMRect): { x: number; y: number } | null {
  const x = Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2))
  const y = Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2))
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    const pane = node.getBoundingClientRect()
    if (x < pane.left || x > pane.right || y < pane.top || y > pane.bottom) return null
  }
  return { x, y }
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
  // "Pushed off screen" means out of the page, where scrolling can't bring it back. Below the fold doesn't count: a
  // theme's own type and spacing move content up and down the page.
  const inPage =
    box.right + window.scrollX > 0 &&
    box.bottom + window.scrollY > 0 &&
    box.left + window.scrollX < document.documentElement.scrollWidth &&
    box.top + window.scrollY < document.documentElement.scrollHeight
  let covered = false
  const point =
    rendered && inViewport && box.width > 0 && box.height > 0 ? visiblePoint(element, box) : null
  if (point) {
    const top = document.elementFromPoint(point.x, point.y)
    // Something else on top of the centre of a visible surface (a modal is not "something else": it has its own
    // top layer, so the surface is covered in both measurements and does not count).
    covered = !!top && !element.contains(top) && !top.contains(element) && !isFloatingOverlay(top)
  }
  return {
    rendered,
    chainOpacity,
    chainFilter,
    chainClip,
    size: box.width * box.height,
    onScreen: inPage,
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

function violationIn(surfaces: HTMLElement[]): string | null {
  const live = surfaces.filter((el) => !el.closest('[hidden]'))
  if (live.length === 0) return null
  const targets = live.flatMap(parts)
  const glyphShapes = live.flatMap(shapes)
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

/** The first thing a theme did to a protected surface that the layer could not stop, or null. */
export function findProtectedViolation(root: ParentNode = document): string | null {
  return violationIn(Array.from(root.querySelectorAll<HTMLElement>('[data-protected]')))
}

// The way back must always work, so an action on one of these is never refused: if its surroundings are damaged the
// periodic guard drops the theme, and the action goes ahead.
const WAY_BACK =
  '.look-reset, .look-banner, .command-run, .command-palette, .command-trigger, .menu-trigger, .main-nav-link, .nav-drawer-link, .needs-you-dot, .chat-toast'
const ACTIONABLE =
  'button, a[href], input, select, textarea, summary, [role=button], [role=menuitem], [role=radio], [role=checkbox], [role=switch]'

/** What stands between the person and this control right now: not shown, hidden up the chain, or something on top of it. */
function controlProblem(control: HTMLElement): string | null {
  if (control.getClientRects().length === 0) return 'isn’t shown'
  for (const node of chain(control)) {
    const style = getComputedStyle(node)
    if (style.visibility !== 'visible') return 'is hidden'
  }
  const box = control.getBoundingClientRect()
  const inViewport =
    box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
  if (inViewport && box.width > 0 && box.height > 0) {
    const x = Math.min(window.innerWidth - 1, Math.max(0, box.left + box.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(0, box.top + box.height / 2))
    const top = document.elementFromPoint(x, y)
    if (top && !control.contains(top) && !top.contains(control)) return 'is covered'
  }
  return null
}

/**
 * Checked at the moment a person acts on a control inside a protected surface (an approval, an answer, a permission, a
 * password), when a theme is on: the whole surface is measured with and without the theme, and the control itself must
 * be shown, visible and on top. Whatever a theme does later or on hover can't leave a decision hidden when it's made
 * (gate finding #6). Returns what is wrong, or null.
 */
export function decisionProblem(control: HTMLElement): string | null {
  if (document.documentElement.getAttribute('data-look') !== 'custom') return null
  const surface = control.closest<HTMLElement>('[data-protected]')
  if (!surface || control.closest(WAY_BACK)) return null
  const problem = violationIn([surface]) ?? controlProblem(control)
  if (!problem) return null
  const name =
    surface.getAttribute('aria-label') ?? control.getAttribute('aria-label') ?? 'A decision'
  return problem.startsWith(name) ? problem : `${name} ${problem}`
}

// Style changes that come without a DOM change: hover, focus and pressed states, and animations and transitions as they
// end. Each schedules a check of every protected surface. Not `animationstart` or `…cancel`: measuring lifts the theme's
// sheets, which cancels and restarts a theme animation, so those would feed on the guard's own checks. A finished
// animation is measured before it is lifted, and the sanitiser takes motion out of themes anyway (themes/sanitise.ts).
const STYLE_EVENTS = [
  'pointerover',
  'pointerdown',
  'pointerup',
  'focusin',
  'focusout',
  'animationend',
  'transitionend',
] as const

export type WatchOptions = {
  /** Replaced in tests. */
  check?: () => string | null
  /** Replaced in tests: what a decision on this element runs into. */
  decision?: (control: HTMLElement) => string | null
}

/**
 * Watches the page while a custom theme is on: when a protected surface is damaged, `onViolation` runs once (the
 * runtime then drops the theme). Re-checks on DOM changes (debounced), window resizes, and the events that change
 * styles without touching the DOM. Every click or submit inside a protected surface is vetted first (`decisionProblem`):
 * a refused action is stopped and `onViolation(what, true)` says so.
 */
export function watchProtectedSurfaces(
  onViolation: (what: string, refused?: boolean) => void,
  options: WatchOptions = {},
): () => void {
  const measure = options.check ?? findProtectedViolation
  const vet = options.decision ?? decisionProblem
  let frame = 0
  let timer = 0
  let done = false
  // A problem about where something is (covered, pushed off screen, shrunk) is confirmed once more a moment later
  // before the theme is dropped: a resize or a list measuring itself can overlap things for a frame. The others are
  // acted on at once (measuring lifts the theme's sheets, which restarts a theme animation, so a second look at a faded
  // page would see it unfaded). A decision is vetted at once, without waiting (decisionProblem).
  const transient = /is (covered|pushed off screen|shrunk)$/
  const confirm = () => {
    frame = 0
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const problem = measure()
    if (problem) {
      done = true
      onViolation(problem)
    }
  }
  const check = () => {
    frame = 0
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const problem = measure()
    if (!problem) return
    if (!transient.test(problem)) {
      done = true
      onViolation(problem)
      return
    }
    timer = window.setTimeout(() => {
      timer = 0
      frame = requestAnimationFrame(confirm)
    }, 250)
  }
  const schedule = () => {
    if (done || frame || timer) return
    timer = window.setTimeout(() => {
      timer = 0
      frame = requestAnimationFrame(check)
    }, 120)
  }
  const refuse = (event: Event) => {
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const target = event.target instanceof Element ? event.target : null
    const control =
      event.type === 'submit'
        ? (target as HTMLElement | null)
        : (target?.closest<HTMLElement>(ACTIONABLE) ?? null)
    if (!control) return
    const problem = vet(control)
    if (!problem) return
    event.preventDefault()
    event.stopImmediatePropagation()
    done = true
    onViolation(problem, true)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('hashchange', schedule)
  for (const name of STYLE_EVENTS) document.addEventListener(name, schedule, true)
  document.addEventListener('click', refuse, true)
  document.addEventListener('submit', refuse, true)
  schedule()
  return () => {
    done = true
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    window.removeEventListener('hashchange', schedule)
    for (const name of STYLE_EVENTS) document.removeEventListener(name, schedule, true)
    document.removeEventListener('click', refuse, true)
    document.removeEventListener('submit', refuse, true)
    window.clearTimeout(timer)
    cancelAnimationFrame(frame)
  }
}
