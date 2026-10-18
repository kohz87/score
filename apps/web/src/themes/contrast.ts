import { contrastRatio, luminance, over, parseComputedColor, type Rgba } from './color.ts'

// Worst-case contrast of text over what is painted behind it (gate finding #4). A background is a stack of layers; a
// layer is one solid colour, a gradient (any of its stops may sit behind a letter) or a picture (anything between black
// and white). The text has to read against every possibility, so nothing a theme paints can pass by being unmeasurable.

/** The colours a layer may have behind a given letter. */
export type Layer = readonly Rgba[]

const BLACK: Rgba = [0, 0, 0, 1]
const WHITE: Rgba = [1, 1, 1, 1]
const MAX_ALTERNATIVES = 256

function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map((part) => part.trim()).filter(Boolean)
}

const COLOR_FUNCTION = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?:[^()]|\([^()]*\))*\)/gi

/**
 * The layers of one element's computed `background-image` + `background-color`, top first; null when one is unknown.
 * A picture counts as anything from black to white, except the page's own (`pictures: 'ignore'`): that one is the
 * theme's backdrop, the engine veils it with the ground colour, and the colour under it is what is measured. (Sampling
 * the picture is the Customizer's job, themes/customizer/measure.ts.)
 */
export function backgroundLayers(
  image: string,
  color: string,
  pictures: 'worst' | 'ignore' = 'worst',
): Layer[] | null {
  const layers: Layer[] = []
  if (image && image !== 'none') {
    for (const part of splitTopLevel(image)) {
      if (/^url\(/i.test(part)) {
        if (pictures === 'worst') layers.push([BLACK, WHITE])
      } else if (/^(repeating-)?(linear|radial|conic)-gradient\(/i.test(part)) {
        const stops = (part.match(COLOR_FUNCTION) ?? []).map((value) => parseComputedColor(value))
        if (stops.length === 0 || stops.some((stop) => stop === null)) return null
        layers.push(stops as Rgba[])
      } else return null
    }
  }
  const solid = parseComputedColor(color)
  if (!solid) return null
  if (solid[3] > 0) layers.push([solid])
  return layers
}

const opaque = (layer: Layer) => layer.every((colour) => colour[3] >= 1)

/** True when nothing below this layer can show through. */
export function hidesWhatIsBelow(layers: readonly Layer[]): boolean {
  return layers.some(opaque)
}

/**
 * The lowest contrast `text` can have over the stack (top first), or null when the stack is too wild to enumerate.
 * Below an opaque layer nothing is looked at; the page itself is white.
 */
export function worstContrast(text: Rgba, stack: readonly Layer[]): number | null {
  const cut = stack.findIndex(opaque)
  const used = cut < 0 ? stack : stack.slice(0, cut + 1)
  let behind: Rgba[] = [WHITE]
  for (let i = used.length - 1; i >= 0; i--) {
    const next: Rgba[] = []
    for (const layer of used[i]!) for (const below of behind) next.push(over(layer, below))
    if (next.length > MAX_ALTERNATIVES) return null
    behind = next
  }
  const lights = behind.map((colour) => luminance(colour))
  const own = luminance(over(text, text[3] < 1 ? (behind[0] ?? WHITE) : WHITE))
  // A text colour between the lightest and darkest possible background vanishes somewhere on them.
  if (own > Math.min(...lights) && own < Math.max(...lights)) return 1
  return Math.min(...behind.map((colour) => contrastRatio(text, colour)))
}
