import { isScoreOverlay } from './guard-overlays.ts'

export type Box = { left: number; top: number; right: number; bottom: number }

export function chain(element: Element): Element[] {
  const out: Element[] = []
  for (let node: Element | null = element; node; node = node.parentElement) out.push(node)
  return out
}

/**
 * What of the element can be seen: its first line box, cut down by every ancestor that clips without letting anyone
 * scroll (`overflow: hidden` or `clip`). A box with nothing left is clipped away entirely, which `getClientRects()`
 * alone can't tell (re-gate finding 4). `fraction` is what share of the box survives that; `view` is the box also cut
 * to the scrolling panes around it (what has been scrolled out of its pane is not covered, just not in view), the
 * part where a hit test means something.
 */
export function visibleBox(element: Element): { view: Box | null; fraction: number } {
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
export function visiblePoint(box: Box | null): { x: number; y: number } | null {
  if (!box) return null
  const left = Math.max(0, box.left)
  const top = Math.max(0, box.top)
  const right = Math.min(window.innerWidth, box.right)
  const bottom = Math.min(window.innerHeight, box.bottom)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { x: (left + right) / 2, y: (top + bottom) / 2 }
}

/** Is what is painted at this point the element, something inside it, or (for a control) its own label? */
export function paintedBy(element: Element, hit: Element | null): boolean {
  if (!hit) return true
  if (element.contains(hit)) return true
  if (element instanceof HTMLElement && 'labels' in element) {
    const labels = (element as HTMLInputElement).labels
    if (labels && Array.from(labels).some((label) => label.contains(hit))) return true
  }
  // Score's own overlay on top (a sticky bar, a drawer, a banner): not a theme's doing.
  return isScoreOverlay(hit)
}

/**
 * Can scrolling bring the box into view? A box past the document's end is still reachable when it sits inside a pane
 * that scrolls itself (a long list in a room, a theme's own scrolling column): the theme-off baseline may lay the same
 * content out in the document's flow and a theme in a pane, and the length of the list decides which one trips.
 *
 * Only a pane that carries the box when it scrolls counts (3.5.0 review): a fixed box (or one inside a fixed container)
 * isn't moved by any pane above that container, and an absolute box only by panes at or below its containing block.
 * A pane too small to show the box doesn't count either. When unsure this answers "not reachable": a false alarm
 * switches the theme off, a false pass would let a theme hide a decision.
 */
export function reachable(element: Element, box: DOMRect): boolean {
  const root = document.documentElement
  type Box = { left: number; top: number; right: number; bottom: number }
  const inDocument = (b: Box) =>
    b.right + window.scrollX > 0 &&
    b.bottom + window.scrollY > 0 &&
    b.left + window.scrollX < root.scrollWidth &&
    b.top + window.scrollY < root.scrollHeight
  const inViewport = (b: Box) =>
    b.right > 0 && b.bottom > 0 && b.left < window.innerWidth && b.top < window.innerHeight
  const ownPosition = getComputedStyle(element).position
  // A fixed box stays where it is on screen whatever scrolls: reachable exactly when it is in the viewport.
  if (ownPosition === 'fixed') return inViewport(box)
  if (inDocument(box)) return true
  const scrolls = (value: string) => value === 'auto' || value === 'scroll'
  // An absolute box skips static ancestors until its containing block (the first positioned one).
  let awaitingBlock = ownPosition === 'absolute'
  let outer: Element | null = null
  let pinned = false
  // What the next pane up must be able to scroll into view: the card first, then each pane that carries it (a pane
  // nested in another has to be reachable inside that one too).
  let target: Box = box
  for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
    const style = getComputedStyle(node)
    const positioned = style.position !== 'static'
    const carries = !awaitingBlock || positioned
    if (carries && (scrolls(style.overflowX) || scrolls(style.overflowY))) {
      const pane = node.getBoundingClientRect()
      if (pane.width < Math.min(box.width, 120) || pane.height < Math.min(box.height, 80))
        return false
      const extent = {
        left: target.left - pane.left + node.scrollLeft,
        top: target.top - pane.top + node.scrollTop,
        right: target.right - pane.left + node.scrollLeft,
        bottom: target.bottom - pane.top + node.scrollTop,
      }
      if (
        extent.right <= 0 ||
        extent.bottom <= 0 ||
        extent.left >= node.scrollWidth ||
        extent.top >= node.scrollHeight
      )
        return false
      outer = node
      target = pane
    }
    if (positioned) awaitingBlock = style.position === 'absolute'
    // Nothing above a fixed container moves what is inside it.
    if (style.position === 'fixed') {
      pinned = true
      break
    }
  }
  if (outer === null) return false
  // The outermost pane has to be on the page itself (or, inside a fixed container, on screen) to be reached.
  const pane = outer.getBoundingClientRect()
  return pinned ? inViewport(pane) : inDocument(pane)
}
