import { parseColor, type Rgba } from '../color.ts'
import { worstRatio } from './checks.ts'

// Measures the text that is really drawn in the preview (PLAN 9.4, lead note 2026-10-18): small text over a picture or
// a glass card can be unreadable while every pair of colour tokens is fine. For each visible piece of text the
// backgrounds stacked behind it are composited, down to the first opaque one; where the stack reaches the page itself
// and the page has a picture, the picture's pixels behind the text (after the dimming veil) are the base.

export type TextFinding = { text: string; ratio: number; minimum: number }

/** The colours (opaque) of the page background behind a rectangle of the preview's window. */
export type Sampler = (rect: { left: number; top: number; right: number; bottom: number }) => Rgba[]

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'OPTION'])

function ownText(element: Element): string {
  let text = ''
  for (const node of element.childNodes) if (node.nodeType === 3) text += node.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim()
}

function isLarge(style: CSSStyleDeclaration): boolean {
  const size = Number.parseFloat(style.fontSize)
  const weight = Number.parseInt(style.fontWeight, 10)
  return size >= 24 || (size >= 18.66 && weight >= 700)
}

export function measureText(doc: Document, sampler: Sampler | null, limit = 8): TextFinding[] {
  const win = doc.defaultView
  if (!win) return []
  const viewport = { width: win.innerWidth, height: win.innerHeight }
  const found = new Map<string, TextFinding>()
  const fallbackBase = parseColor(win.getComputedStyle(doc.body).backgroundColor)
  const groundBase: Rgba = fallbackBase && fallbackBase[3] === 1 ? fallbackBase : [1, 1, 1, 1]
  for (const element of doc.body.querySelectorAll('*')) {
    if (SKIP.has(element.tagName.toUpperCase()) || element.closest('[data-protected]')) continue
    const text = ownText(element)
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) continue
    if (
      rect.right < 0 ||
      rect.bottom < 0 ||
      rect.left > viewport.width ||
      rect.top > viewport.height
    )
      continue
    const style = win.getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    const color = parseColor(style.color)
    if (!color) continue
    // Walk up: collect translucent backgrounds until an opaque one; a gradient or picture on an element we can't
    // measure (other than the page's own) leaves the text unjudged.
    const layers: Rgba[] = []
    let judged = true
    let reachedPage = true
    let opacity = 1
    for (let node: Element | null = element; node; node = node.parentElement) {
      const computed = win.getComputedStyle(node)
      opacity *= Number(computed.opacity)
      const background = parseColor(computed.backgroundColor)
      const isPage = node === doc.body || node === doc.documentElement
      if (computed.backgroundImage !== 'none') {
        // The page's own picture is measured through the sampler; a gradient or picture anywhere else isn't.
        if (!isPage) judged = false
        break
      }
      if (background && background[3] > 0) layers.push(background)
      if (background && background[3] >= 1) {
        reachedPage = false
        break
      }
    }
    if (!judged || opacity < 0.5) continue
    const bases: Rgba[] =
      reachedPage && sampler
        ? sampler({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
        : [groundBase]
    if (bases.length === 0) continue
    const textColor: Rgba = [color[0], color[1], color[2], color[3] * opacity]
    const ratio = worstRatio(textColor, layers, bases)
    const minimum = isLarge(style) ? 3 : 4.5
    if (ratio >= minimum) continue
    const key = text.slice(0, 60)
    const known = found.get(key)
    if (!known || ratio < known.ratio) found.set(key, { text: key, ratio, minimum })
  }
  return [...found.values()].sort((a, b) => a.ratio - b.ratio).slice(0, limit)
}

// ---------------------------------------------------------------------------------------------------------------
// The picture behind the page

type Picture = { image: CanvasImageSource; width: number; height: number }

function loadPicture(url: string): Promise<Picture> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('picture'))
    image.src = url
  })
}

const CELL = 8

/**
 * Builds a sampler for the page background of a theme with a picture: the picture laid out as the theme lays it out
 * (cover or tile, fixed to the window), then veiled by the ground colour at `dim` percent.
 */
export async function pictureSampler(options: {
  url: string
  fit: 'cover' | 'tile'
  dim: number
  ground: Rgba
  width: number
  height: number
}): Promise<Sampler | null> {
  let picture: Picture
  try {
    picture = await loadPicture(options.url)
  } catch {
    return null
  }
  const cols = Math.max(1, Math.ceil(options.width / CELL))
  const rows = Math.max(1, Math.ceil(options.height / CELL))
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || picture.width === 0 || picture.height === 0) return null
  if (options.fit === 'tile') {
    const w = Math.max(1, picture.width / CELL)
    const h = Math.max(1, picture.height / CELL)
    for (let y = 0; y < rows; y += h)
      for (let x = 0; x < cols; x += w) context.drawImage(picture.image, x, y, w, h)
  } else {
    const scale = Math.max(options.width / picture.width, options.height / picture.height)
    const w = (picture.width * scale) / CELL
    const h = (picture.height * scale) / CELL
    context.drawImage(picture.image, (cols - w) / 2, (rows - h) / 2, w, h)
  }
  let pixels: Uint8ClampedArray
  try {
    pixels = context.getImageData(0, 0, cols, rows).data
  } catch {
    return null
  }
  const veil = Math.min(1, Math.max(0, options.dim / 100))
  const [gr, gg, gb] = options.ground
  return (rect) => {
    const out: Rgba[] = []
    const x0 = Math.max(0, Math.floor(rect.left / CELL))
    const x1 = Math.min(cols - 1, Math.floor(rect.right / CELL))
    const y0 = Math.max(0, Math.floor(rect.top / CELL))
    const y1 = Math.min(rows - 1, Math.floor(rect.bottom / CELL))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const at = (y * cols + x) * 4
        const alpha = (pixels[at + 3] ?? 255) / 255
        const r = ((pixels[at] ?? 0) / 255) * alpha + (1 - alpha)
        const g = ((pixels[at + 1] ?? 0) / 255) * alpha + (1 - alpha)
        const b = ((pixels[at + 2] ?? 0) / 255) * alpha + (1 - alpha)
        out.push([
          gr * veil + r * (1 - veil),
          gg * veil + g * (1 - veil),
          gb * veil + b * (1 - veil),
          1,
        ])
      }
    return out
  }
}
