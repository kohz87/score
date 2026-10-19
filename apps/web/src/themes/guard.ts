import { parseComputedColor, type Rgba } from './color.ts'
import { backgroundLayers, hidesWhatIsBelow, worstContrast, type Layer } from './contrast.ts'
import { appliedThemeElements, appliedThemeSheets } from './engine.ts'

// The last line of defence for protected surfaces (design §4.3). styles/protected.css re-asserts what CSS can
// re-assert; what a theme can still do from the outside (hide a button by its tag name, fade an ancestor, cover the
// card, push it off-screen, set a descendant's own font) is caught here: every protected surface is measured with the
// theme on and with the theme's own CSS lifted (the manifest's layout options stay, Score renders those), and a theme
// that makes any of them worse is switched off.

type Snapshot = {
  rendered: boolean
  chainOpacity: number
  chainFilter: boolean
  chainClip: boolean
  size: number
  onScreen: boolean
  /** The share of the element's box that no hidden/clip ancestor cuts away (1 = all of it). */
  visible: number
  covered: boolean
  themeFont: boolean
  fontSize: number
  /** The text's contrast with what is painted behind it; null when that can't be measured (an image, an odd colour). */
  contrast: number | null
  /** WCAG "large text": 3:1 is enough, otherwise 4.5:1. */
  large: boolean
  /** A graphic that stands alone (a bare glyph, a Needs-you dot): `contrast` is then its non-text contrast, 3:1. */
  graphic: boolean
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
function textContrast(element: Element): number | null {
  const text = parseComputedColor(getComputedStyle(element).color)
  return text ? contrastOver(text, chain(element)) : null
}

// What a colour is read against: the layers painted behind it, from the first node down to the first opaque one.
function contrastOver(colour: Rgba, nodes: Element[]): number | null {
  const stack: Layer[] = []
  for (const node of nodes) {
    const computed = getComputedStyle(node)
    // A picture counts as anything from black to white wherever it is, the page's own included (re-gate finding 5: a
    // translucent rail over a picture with no dimming). The theme's veil over it is a layer of its own in this stack.
    const layers = backgroundLayers(computed.backgroundImage, computed.backgroundColor)
    if (!layers) return null
    stack.push(...layers)
    if (hidesWhatIsBelow(layers)) break
  }
  return worstContrast(colour, stack)
}

/**
 * The non-text contrast of a graphic that stands alone (third gate, finding 3; WCAG 1.4.11), or `undefined` when the
 * element is not one. A glyph is its colour read against its own plate and what is painted below it; a Needs-you dot is
 * read against the edge it wears (Score's ink, protected.css) or, without one, what is painted behind it. A graphic whose
 * surroundings can't be measured is null, as for text.
 */
function graphicContrast(element: Element): number | null | undefined {
  const style = getComputedStyle(element)
  if (element.matches('.agent-glyph, .agent-glyph__badge')) {
    const colour = parseComputedColor(style.getPropertyValue('--glyph-color'))
    return colour ? contrastOver(colour, chain(element)) : null
  }
  if (element.matches('.needs-you-dot')) {
    const colour = parseComputedColor(style.backgroundColor)
    if (!colour) return null
    const edge = parseComputedColor(style.borderTopColor)
    if (
      edge &&
      edge[3] >= 1 &&
      Number.parseFloat(style.borderTopWidth) > 0 &&
      style.borderTopStyle !== 'none'
    )
      return worstContrast(colour, [[edge]])
    return contrastOver(colour, element.parentElement ? chain(element.parentElement) : [])
  }
  return undefined
}

// Score's own overlays and sticky bars: the menu drawer, banners, the sticky rails and headers, and the backdrops of
// dialogs. Content scrolled under one is not "covered". A theme can't make anything fixed, sticky or positioned (the
// allowlist), so none of these can be a theme's doing; they are named here by Score's own classes (a theme's CSS cannot
// add a class), not found by looking at `position`, which any rule could have set (re-gate finding 4). A bar or panel
// only counts while it is still fixed or sticky and small: one that has been stretched over the page (an injected
// `position: absolute; inset: 0`) is the cover it looks like. themes/guard.test.ts keeps this list in step with the
// position: fixed / sticky rules in the stylesheets.
export const KNOWN_OVERLAYS = [
  '.responsive-drawer',
  '.nav-drawer',
  '.update-banner',
  '.look-banner',
  '.top-bar',
  '.now-lane-label',
  '.now-axis-spacer',
  '.user-sidebar',
  '.user-sidebar-foot',
  '.user-run',
  '.orch-room-head',
  '.kn-left',
  '.kn-upload-progress',
  '.kn-drop-hint',
  '.kn-toolbar',
  '.chat-version-bar',
  '.chat-doc-table',
  '.task-drawer',
  '.chat-toast',
].join(', ')
/** Dialog backdrops cover the page by design. */
export const KNOWN_BACKDROPS =
  '.drawer-backdrop, .command-backdrop, .kn-backdrop, .cz-backdrop, [role=dialog]'
const MAX_OVERLAY_SHARE = 0.6

function isScoreOverlay(hit: Element): boolean {
  if (hit.closest(KNOWN_BACKDROPS)) return true
  const overlay = hit.closest(KNOWN_OVERLAYS)
  if (!overlay) return false
  const position = getComputedStyle(overlay).position
  if (position !== 'fixed' && position !== 'sticky') return false
  const box = overlay.getBoundingClientRect()
  return box.width * box.height <= window.innerWidth * window.innerHeight * MAX_OVERLAY_SHARE
}

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * What of the element can be seen: its first line box, cut down by every ancestor that clips without letting anyone
 * scroll (`overflow: hidden` or `clip`). A box with nothing left is clipped away entirely, which `getClientRects()`
 * alone can't tell (re-gate finding 4). `fraction` is what share of the box survives that; `view` is the box also cut
 * to the scrolling panes around it (what has been scrolled out of its pane is not covered, just not in view), the
 * part where a hit test means something.
 */
function visibleBox(element: Element): { view: Box | null; fraction: number } {
  const first = element.getClientRects()[0] ?? element.getBoundingClientRect()
  if (first.width <= 0 || first.height <= 0) return { view: null, fraction: 1 }
  const hard = { left: first.left, top: first.top, right: first.right, bottom: first.bottom }
  const view = { ...hard }
  const cut = (box: Box, pane: DOMRect, x: boolean, y: boolean) => {
    if (x) {
      box.left = Math.max(box.left, pane.left)
      box.right = Math.min(box.right, pane.right)
    }
    if (y) {
      box.top = Math.max(box.top, pane.top)
      box.bottom = Math.min(box.bottom, pane.bottom)
    }
  }
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const stops = (value: string) => value === 'hidden' || value === 'clip'
    const scrolls = (value: string) => value === 'auto' || value === 'scroll'
    const hardX = stops(style.overflowX)
    const hardY = stops(style.overflowY)
    const softX = hardX || scrolls(style.overflowX)
    const softY = hardY || scrolls(style.overflowY)
    if (softX || softY) {
      const pane = node.getBoundingClientRect()
      cut(hard, pane, hardX, hardY)
      cut(view, pane, softX, softY)
    }
    // A fixed box is cut by nothing above it.
    if (style.position === 'fixed') break
  }
  const area = first.width * first.height
  const kept = Math.max(0, hard.right - hard.left) * Math.max(0, hard.bottom - hard.top)
  return { view, fraction: Math.min(1, kept / area) }
}

/** The middle of the visible part of the box, inside the window; null when nothing of it is visible. */
function visiblePoint(box: Box | null): { x: number; y: number } | null {
  if (!box) return null
  const left = Math.max(0, box.left)
  const top = Math.max(0, box.top)
  const right = Math.min(window.innerWidth, box.right)
  const bottom = Math.min(window.innerHeight, box.bottom)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}

/** Is what is painted at this point the element, something inside it, or (for a control) its own label? */
function paintedBy(element: Element, hit: Element | null): boolean {
  if (!hit) return true
  if (element.contains(hit)) return true
  if (element instanceof HTMLElement && 'labels' in element) {
    const labels = (element as HTMLInputElement).labels
    if (labels && Array.from(labels).some((label) => label.contains(hit))) return true
  }
  // Score's own overlay on top (a sticky bar, a drawer, a banner): not a theme's doing.
  return isScoreOverlay(hit)
}

function snapshot(element: HTMLElement): Snapshot {
  const graphic = graphicContrast(element)
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
  // "Pushed off screen" means out of the page, where scrolling can't bring it back. Below the fold doesn't count: a
  // theme's own type and spacing move content up and down the page.
  const inPage =
    box.right + window.scrollX > 0 &&
    box.bottom + window.scrollY > 0 &&
    box.left + window.scrollX < document.documentElement.scrollWidth &&
    box.top + window.scrollY < document.documentElement.scrollHeight
  const { view: seen, fraction } = rendered ? visibleBox(element) : { view: null, fraction: 1 }
  // Something else on top of the visible part of a surface (a modal is not "something else": it has its own top layer,
  // so the surface is covered in both measurements and does not count). Only the element, what is inside it or its
  // label may be painted there (re-gate finding 4: an ancestor answering the hit test is a covered control).
  const point = visiblePoint(seen)
  const covered = !!point && !paintedBy(element, document.elementFromPoint(point.x, point.y))
  return {
    rendered,
    chainOpacity,
    chainFilter,
    chainClip,
    size: box.width * box.height,
    onScreen: inPage,
    visible: fraction,
    covered,
    themeFont: /theme-[a-z0-9-]+-/i.test(style.fontFamily),
    fontSize: Number.parseFloat(style.fontSize) || 0,
    // Words need 4.5:1; a control with only an icon is a graphic, 3:1. A surface with no text of its own (a card, a
    // dot) has nothing to measure: its words are separate targets.
    contrast: ownText || control ? textContrast(element) : (graphic ?? null),
    large: isLargeText(style) || !ownText,
    graphic: graphic !== undefined && !(ownText || control),
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
  graphic = false,
): string | null {
  const needed = large ? 3 : 4.5
  if (on === null)
    return off === null
      ? null
      : graphic
        ? 'has a background whose colours can’t be checked'
        : 'has text whose colours can’t be checked'
  if (on >= needed) return null
  if (off === null || on < off - 0.05)
    return graphic ? 'can’t be told apart from its background' : 'has unreadable text'
  return null
}

/**
 * `context` is a decision's own fields and labels (third gate, finding 1): they are not protected surfaces, so a theme
 * may set their size, weight and a system font, but not hide, fade, cut, cover or blank them. A font the theme ships is
 * judged there too (fourth gate, finding 1: blank or substituted glyphs erase a field while its box and contrast stay
 * normal); the decision reads in Score's fonts (protected.css), so only a theme rule aimed at a field puts one back.
 */
function worse(on: Snapshot, off: Snapshot, context = false): string | null {
  if (off.rendered && !on.rendered) return 'is not shown'
  if (!off.rendered) return null
  if (on.chainOpacity < off.chainOpacity - 0.02) return 'is faded'
  if (on.chainFilter && !off.chainFilter) return 'is filtered'
  if (on.chainClip && !off.chainClip) return 'is clipped'
  if (off.size > 0 && on.size < off.size * 0.5) return 'is shrunk'
  if (off.onScreen && !on.onScreen) return 'is pushed off screen'
  if (off.visible > 0.5 && on.visible < off.visible * 0.5) return 'is clipped'
  if (on.covered && !off.covered) return 'is covered'
  if (on.themeFont && !off.themeFont) return 'is set in the theme’s font'
  if (!context && off.fontSize > 0 && on.fontSize < off.fontSize * 0.5) return 'has tiny text'
  return contrastVerdict(on.contrast, off.contrast, on.large, on.graphic)
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
    if (el.matches(CONTROLS) || el.matches('.agent-glyph__badge') || carriesText(el)) found.push(el)
  }
  return found
}

// Glyph shapes (finding #5): an agent is told apart by its shape, so what the shapes paint is compared, not just
// whether their wrapper is shown: geometry (`d`, size), paint and everything that can hide or move a path.
const SHAPES = 'image, path, circle, rect, ellipse, polygon, polyline, line'
// Parts Score itself animates with `transform` (a mark's eye slots, its orbiting dot and ripples, a pet's overlays): their transform is whatever the keyframes
// say at the moment of reading, so it can't be compared; a theme can't style them (the sanitiser guard), and everything
// else about them (geometry, paint, display, clip, mask, filter) is still compared.
const ANIMATED_BY_SCORE =
  '.agent-glyph__slot, .agent-glyph__orbit, .agent-glyph__ripple, .pet-avatar__fx *, .room-stage__fx *'

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
    el.matches(ANIMATED_BY_SCORE) ? 'animated' : style.transform,
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

/**
 * Runs with the theme's own CSS gone: its adopted sheets, its style elements and the boot copy the page painted from
 * its cache are lifted, then put back before anything is painted. The `data-*` attributes stay: they are the manifest's
 * layout, shape and density options, which Score renders itself (a left rail hides the search shortcut, a launcher
 * moves the menu into a drawer), so what they change is Score's doing and not part of what is judged. What is judged is
 * what the theme's CSS and tokens did on top of them.
 */
function withoutTheme<T>(run: () => T): T {
  const sheets = appliedThemeSheets()
  const elements = [
    ...appliedThemeElements(),
    ...Array.from(document.querySelectorAll<HTMLStyleElement>('style#score-look-boot')),
  ]
  const adopted = Array.isArray(document.adoptedStyleSheets)
  const before = adopted ? [...document.adoptedStyleSheets] : []
  const disabled = elements.map((el) => el.disabled)
  if (adopted) document.adoptedStyleSheets = before.filter((sheet) => !sheets.includes(sheet))
  elements.forEach((el) => {
    el.disabled = true
  })
  try {
    return run()
  } finally {
    if (adopted) document.adoptedStyleSheets = before
    elements.forEach((el, i) => {
      el.disabled = disabled[i] ?? false
    })
  }
}

function violationIn(surfaces: HTMLElement[], decision: HTMLElement | null = null): string | null {
  const live = surfaces.filter((el) => !el.closest('[hidden]'))
  // Everything else inside the decision (its labelled fields, labels, selects and text), judged less strictly. A decision
  // with no protected surface on the page right now still has its fields vetted (cross-audit X1).
  const rest =
    decision && !decision.closest('[hidden]')
      ? parts(decision).filter((el) => !el.closest('[data-protected]'))
      : []
  if (live.length === 0 && rest.length === 0) return null
  const targets = [...live.flatMap(parts), ...rest]
  const loose = new Set<HTMLElement>(rest)
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
    const problem = worse(on[i]!, off[i]!, loose.has(targets[i]!))
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
  '.look-reset, .look-banner, .command-run, .command-palette, .command-trigger, .menu-trigger, .user-way-back, .main-nav-link, .nav-drawer-link, .needs-you-dot, .chat-toast'
const ACTIONABLE =
  'button, a[href], input, select, textarea, summary, [role=button], [role=menuitem], [role=radio], [role=checkbox], [role=switch]'

/** What stands between the person and this control right now: not shown, hidden up the chain, or something on top of it. */
function controlProblem(control: HTMLElement): string | null {
  if (control.getClientRects().length === 0) return 'isn’t shown'
  for (const node of chain(control)) {
    const style = getComputedStyle(node)
    if (style.visibility !== 'visible') return 'is hidden'
  }
  const { view, fraction } = visibleBox(control)
  if (fraction < 0.5) return 'is clipped'
  const point = visiblePoint(view)
  if (point && !paintedBy(control, document.elementFromPoint(point.x, point.y))) return 'is covered'
  return null
}

/**
 * The protected surfaces one action answers to. Inside a `data-decision` boundary (a form, a drawer's actions) that is
 * every protected surface of the decision, outermost first: the request text, its warnings, the fields and the button
 * that commits are separate surfaces, and a click on one is a click on the whole decision (re-gate finding #6).
 * Elsewhere it is the control's nearest protected surface.
 */
function decisionSurfaces(control: HTMLElement): {
  surfaces: HTMLElement[]
  whole: HTMLElement | null
} {
  const decision = control.closest<HTMLElement>('[data-decision]')
  if (!decision) {
    const surface = control.closest<HTMLElement>('[data-protected]')
    return { surfaces: surface ? [surface] : [], whole: null }
  }
  const marked = [
    decision,
    ...Array.from(decision.querySelectorAll<HTMLElement>('[data-protected]')),
  ].filter((el) => el.hasAttribute('data-protected'))
  // A surface inside another is measured with it (parts() walks every descendant).
  const outer = marked.filter((el) => !marked.some((other) => other !== el && other.contains(el)))
  // A decision inside a protected surface (a dialog) is measured as part of it.
  const around = decision.parentElement?.closest<HTMLElement>('[data-protected]')
  // A decision is judged whole: the surfaces above and every field and label between them (finding 1).
  return around ? { surfaces: [around], whole: null } : { surfaces: outer, whole: decision }
}

/**
 * Checked at the moment a person acts on a control inside a protected surface or a decision (an approval, an answer, a
 * permission, a password, an "Add agent"), when a theme is on: every surface of the decision is measured with and
 * without the theme, and the control itself must be shown, visible, not clipped and the thing painted where it is (not
 * an ancestor or a stranger). What Score's own look already did (the same problem with the theme gone) is not the
 * theme's. Whatever a theme does later or on hover
 * can't leave a decision hidden when it's made (gate finding #6). Returns what is wrong, or null.
 */
export function decisionProblem(control: HTMLElement): string | null {
  if (document.documentElement.getAttribute('data-look') !== 'custom') return null
  const { surfaces, whole } = decisionSurfaces(control)
  if ((surfaces.length === 0 && !whole) || control.closest(WAY_BACK)) return null
  let problem = violationIn(surfaces, whole)
  if (!problem) {
    const own = controlProblem(control)
    if (own && withoutTheme(() => controlProblem(control)) === null) problem = own
  }
  if (!problem) return null
  const name =
    surfaces[0]?.getAttribute('aria-label') ?? control.getAttribute('aria-label') ?? 'A decision'
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

/**
 * Keeps `watchProtectedSurfaces` running for as long as the page wears a custom theme, from the first moment: the boot
 * script paints the last visit's theme before React has the theme list or the theme itself, and those decisions are
 * the theme's to damage just the same (1.8.1 verification, L1). Follows `html[data-look='custom']`: the watch starts when
 * it is set (again), stops when it goes, and starts afresh when a theme is worn again after a violation (a watch is one-shot).
 */
export function watchWhileCustom(
  onViolation: (what: string, refused?: boolean) => void,
  options: WatchOptions = {},
): () => void {
  const root = document.documentElement
  let stop: (() => void) | undefined
  let violated = false
  const sync = () => {
    const custom = root.getAttribute('data-look') === 'custom'
    if (!custom) {
      stop?.()
      stop = undefined
      violated = false
      return
    }
    // Every write of the attribute is a theme (re)applied: a fresh watch also checks the new look at once.
    stop?.()
    stop = undefined
    if (violated) return
    stop = watchProtectedSurfaces((what, refused) => {
      violated = true
      onViolation(what, refused)
    }, options)
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { attributes: true, attributeFilter: ['data-look'] })
  sync()
  return () => {
    observer.disconnect()
    stop?.()
  }
}
