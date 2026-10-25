// One shared pointer listener for every "lively" (hero) glyph on the page. It exists only while at least one is
// mounted, runs at most once per animation frame, and writes two CSS variables per face (no React renders, no timers).
type Entry = { el: SVGElement; lx: number; ly: number }

const entries = new Set<Entry>()
let pointer: { x: number; y: number } | null = null
let frame = 0
let attached = false

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function apply() {
  frame = 0
  for (const { el, lx, ly } of entries) {
    if (!pointer || reduced()) {
      el.removeAttribute('data-following')
      el.style.removeProperty('--gx')
      el.style.removeProperty('--gy')
      continue
    }
    const rect = el.getBoundingClientRect()
    const vx = pointer.x - (rect.left + rect.width / 2)
    const vy = pointer.y - (rect.top + rect.height / 2)
    const dist = Math.hypot(vx, vy) || 1
    // The mock-up eases the look in over 140px so a pointer on top of the face doesn't flip the gaze about.
    const k = Math.min(dist / 140, 1)
    el.setAttribute('data-following', '')
    el.style.setProperty('--gx', ((vx / dist) * k * lx).toFixed(3))
    el.style.setProperty('--gy', ((vy / dist) * k * ly).toFixed(3))
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(apply)
}

function onMove(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY }
  schedule()
}

function onLeave() {
  pointer = null
  schedule()
}

/** Starts following the pointer; returns the stop function. */
export function followPointer(el: SVGElement, lx: number, ly: number): () => void {
  const entry: Entry = { el, lx, ly }
  entries.add(entry)
  if (!attached) {
    attached = true
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
  }
  return () => {
    entries.delete(entry)
    el.removeAttribute('data-following')
    el.style.removeProperty('--gx')
    el.style.removeProperty('--gy')
    if (entries.size === 0 && attached) {
      attached = false
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      pointer = null
    }
  }
}
