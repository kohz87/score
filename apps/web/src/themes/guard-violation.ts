import { parseComputedColor } from './color.ts'
import { appliedThemeElements, appliedThemeSheets } from './engine.ts'
import { carriesText, CONTROLS, snapshot } from './guard-snapshot.ts'
import { worse } from './guard-verdict.ts'

export function parts(surface: HTMLElement): HTMLElement[] {
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
const SHAPES = 'image, path, circle, rect, ellipse, polygon, polyline, line'
function shapes(surface: HTMLElement): SVGGraphicsElement[] {
  // The eyes animate (blink, look, hop), so their transform differs between any two instants: protected.css pins their
  // paint instead (decision 127).
  return Array.from(surface.querySelectorAll<SVGGraphicsElement>(SHAPES)).filter(
    (el) => !el.closest('[hidden]') && !el.closest('.agent-face'),
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

/**
 * Runs with the theme's own CSS gone: its adopted sheets, its style elements and the boot copy the page painted from
 * its cache are lifted, then put back before anything is painted. The `data-*` attributes stay: they are the manifest's
 * layout, shape and density options, which Score renders itself (a left rail hides the search shortcut, a launcher
 * moves the menu into a drawer), so what they change is Score's doing and not part of what is judged. What is judged is
 * what the theme's CSS and tokens did on top of them.
 */
export function withoutTheme<T>(run: () => T): T {
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

export function violationIn(
  surfaces: HTMLElement[],
  decision: HTMLElement | null = null,
): string | null {
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
