// One animation-frame loop for the whole page (PLAN 10.10): every room stage subscribes here instead of running its
// own, so a room with a dozen members costs one request per frame. It runs while someone listens and the tab is
// visible, and gives each frame the seconds since the last, capped so a pause is not a jump.
type Frame = (now: number, seconds: number) => void

const listeners = new Set<Frame>()
let handle: number | null = null
let last = 0
let watching = false

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

function frame(now: number) {
  handle = null
  const seconds = Math.min(0.1, Math.max(0, (now - last) / 1000))
  last = now
  for (const listener of [...listeners]) listener(now, seconds)
  schedule()
}

function schedule() {
  if (handle === null && listeners.size > 0 && visible()) {
    last = performance.now()
    handle = requestAnimationFrame(frame)
  }
}

function unschedule() {
  if (handle !== null) cancelAnimationFrame(handle)
  handle = null
}

function onVisibility() {
  if (visible()) schedule()
  else unschedule()
}

export function subscribeFrame(listener: Frame): () => void {
  listeners.add(listener)
  if (!watching) {
    watching = true
    document.addEventListener('visibilitychange', onVisibility)
  }
  schedule()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unschedule()
      watching = false
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}
