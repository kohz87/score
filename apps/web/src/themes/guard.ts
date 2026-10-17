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
}

const TEXT_PARTS =
  'button, a[href], input:not([type=hidden]), select, textarea, h1, h2, h3, h4, p, dt, dd, strong, code, label'

function chain(element: Element): Element[] {
  const out: Element[] = []
  for (let node: Element | null = element; node; node = node.parentElement) out.push(node)
  return out
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
  }
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
  return null
}

function parts(surface: HTMLElement): HTMLElement[] {
  return [
    surface,
    ...Array.from(surface.querySelectorAll<HTMLElement>(TEXT_PARTS)).filter(
      (el) => !el.closest('[hidden], [inert], details:not([open])') && !el.hidden,
    ),
  ]
}

/** Runs with the theme's own sheets lifted, then puts them back before anything is painted. */
function withoutTheme<T>(run: () => T): T {
  const sheets = appliedThemeSheets()
  const elements = appliedThemeElements()
  const before = document.adoptedStyleSheets
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
  const on = targets.map(snapshot)
  const off = withoutTheme(() => targets.map(snapshot))
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
