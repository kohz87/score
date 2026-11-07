import { graphicContrast, isLargeText, textContrast } from './guard-contrast.ts'
import { chain, paintedBy, reachable, visibleBox, visiblePoint } from './guard-geometry.ts'

export type Snapshot = {
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

export const CONTROLS =
  'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]'

export function snapshot(element: HTMLElement): Snapshot {
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
  const inPage = reachable(element, box)
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

// Every element that shows text of its own (whatever its tag: the approval's title and description are spans) or is a
// control, not a fixed list of tags (gate finding #3).
export function carriesText(el: Element): boolean {
  for (const node of Array.from(el.childNodes))
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') return true
  return false
}
