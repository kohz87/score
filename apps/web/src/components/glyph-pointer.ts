// One pointer listener for every mark on the page (decision 108): the eyes of each rich glyph look toward the pointer,
// throttled to one animation frame, and a click nudges the mark it landed on. Nothing here changes any state.

const SELECTOR = '.agent-glyph--rich'
const REACH = 240
/** How far the eyes travel, in the glyph's 20-unit box. */
export const EYE_TRAVEL = { x: 1.3, y: 1 }

/** Where the eyes go for a pointer at (px, py) over a glyph box: a unit-limited offset scaled to the travel. */
export function eyeOffset(
  box: { left: number; top: number; width: number; height: number },
  pointer: { x: number; y: number },
): { x: number; y: number } {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value))
  const nx = clamp((pointer.x - (box.left + box.width / 2)) / REACH)
  const ny = clamp((pointer.y - (box.top + box.height / 2)) / REACH)
  return { x: +(nx * EYE_TRAVEL.x).toFixed(2), y: +(ny * EYE_TRAVEL.y).toFixed(2) }
}

/** Marks stand still under Still (Settings › Look) and reduced motion. */
function still(): boolean {
  if (document.documentElement.dataset.liveliness === 'still') return true
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

let users = 0
let pointer: { x: number; y: number } | null = null
let frame = 0
let scheduled = false

function look() {
  scheduled = false
  const quiet = still()
  for (const glyph of document.querySelectorAll<HTMLElement>(SELECTOR)) {
    const eyes = glyph.querySelector<SVGGElement>('.agent-glyph__eyes')
    if (!eyes) continue
    // A thinking mark looks up on its own; a resting pointer or Still leaves the eyes where the CSS puts them.
    if (quiet || !pointer || glyph.classList.contains('agent-glyph--thinking')) {
      if (eyes.style.transform) eyes.style.transform = ''
      continue
    }
    const box = glyph.getBoundingClientRect()
    if (box.bottom < -100 || box.top > window.innerHeight + 100) continue
    const { x, y } = eyeOffset(box, pointer)
    eyes.style.transform = `translate(${x}px, ${y}px)`
  }
}

function onMove(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY }
  if (scheduled) return
  scheduled = true
  frame = requestAnimationFrame(look)
}

function onClick(event: MouseEvent) {
  if (still() || !(event.target instanceof Element)) return
  const glyph = event.target.closest<HTMLElement>(SELECTOR)
  if (!glyph) return
  glyph.classList.remove('agent-glyph--poke')
  void glyph.getBoundingClientRect()
  glyph.classList.add('agent-glyph--poke')
  setTimeout(() => glyph.classList.remove('agent-glyph--poke'), 480)
}

/** Registers a mark; the listeners exist while at least one is mounted. Returns the cleanup. */
export function watchGlyphs(): () => void {
  if (users++ === 0) {
    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('click', onClick)
  }
  return () => {
    if (--users === 0) {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('click', onClick)
      if (scheduled) cancelAnimationFrame(frame)
      scheduled = false
      pointer = null
    }
  }
}
