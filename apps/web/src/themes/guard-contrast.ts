import { parseComputedColor, type Rgba } from './color.ts'
import { backgroundLayers, hidesWhatIsBelow, worstContrast, type Layer } from './contrast.ts'
import { chain } from './guard-geometry.ts'

// Colours set through the theme's tokens or its own rules (white on white, transparent text) leave a surface in place
// but unreadable: measured against the backgrounds stacked behind the text, up to the first opaque one.
export function textContrast(element: Element): number | null {
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
export function graphicContrast(element: Element): number | null | undefined {
  const style = getComputedStyle(element)
  if (element.matches('.agent-glyph')) {
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

export function isLargeText(style: CSSStyleDeclaration): boolean {
  const px = Number.parseFloat(style.fontSize) || 0
  const bold = Number.parseInt(style.fontWeight, 10) >= 700
  return px >= 24 || (bold && px >= 18.66)
}
