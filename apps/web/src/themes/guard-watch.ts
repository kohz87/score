import { decisionProblem } from './guard-decision.ts'
import { findProtectedViolation } from './guard-violation.ts'

const ACTIONABLE =
  'button, a[href], input, select, textarea, summary, [role=button], [role=menuitem], [role=radio], [role=checkbox], [role=switch]'

// Style changes that come without a DOM change: hover, focus and pressed states, and animations and transitions as they
// end. Each schedules a check of every protected surface. Not `animationstart` or `…cancel`: measuring lifts the theme's
// sheets, which cancels and restarts a theme animation, so those would feed on the guard's own checks. A finished
// animation is measured before it is lifted, and the sanitiser takes motion out of themes anyway (themes/sanitise.ts).
const STYLE_EVENTS = [
  'pointerover',
  'pointerdown',
  'pointerup',
  'focusin',
  'focusout',
  'animationend',
  'transitionend',
] as const

export type WatchOptions = {
  /** Replaced in tests. */
  check?: () => string | null
  /** Replaced in tests: what a decision on this element runs into. */
  decision?: (control: HTMLElement) => string | null
}

/**
 * Watches the page while a custom theme is on: when a protected surface is damaged, `onViolation` runs once (the
 * runtime then drops the theme). Re-checks on DOM changes (debounced), window resizes, and the events that change
 * styles without touching the DOM. Every click or submit inside a protected surface is vetted first (`decisionProblem`):
 * a refused action is stopped and `onViolation(what, true)` says so.
 */
export function watchProtectedSurfaces(
  onViolation: (what: string, refused?: boolean) => void,
  options: WatchOptions = {},
): () => void {
  const measure = options.check ?? findProtectedViolation
  const vet = options.decision ?? decisionProblem
  let frame = 0
  let timer = 0
  let done = false
  // A problem about where something is (covered, pushed off screen, shrunk) is confirmed once more a moment later
  // before the theme is dropped: a resize or a list measuring itself can overlap things for a frame. The others are
  // acted on at once (measuring lifts the theme's sheets, which restarts a theme animation, so a second look at a faded
  // page would see it unfaded). A decision is vetted at once, without waiting (decisionProblem).
  const transient = /is (covered|pushed off screen|shrunk)$/
  const confirm = () => {
    frame = 0
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const problem = measure()
    if (problem) {
      done = true
      onViolation(problem)
    }
  }
  const check = () => {
    frame = 0
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const problem = measure()
    if (!problem) return
    if (!transient.test(problem)) {
      done = true
      onViolation(problem)
      return
    }
    timer = window.setTimeout(() => {
      timer = 0
      frame = requestAnimationFrame(confirm)
    }, 250)
  }
  const schedule = () => {
    if (done || frame || timer) return
    timer = window.setTimeout(() => {
      timer = 0
      frame = requestAnimationFrame(check)
    }, 120)
  }
  const refuse = (event: Event) => {
    if (done || document.documentElement.getAttribute('data-look') !== 'custom') return
    const target = event.target instanceof Element ? event.target : null
    const control =
      event.type === 'submit'
        ? (target as HTMLElement | null)
        : (target?.closest<HTMLElement>(ACTIONABLE) ?? null)
    if (!control) return
    const problem = vet(control)
    if (!problem) return
    event.preventDefault()
    event.stopImmediatePropagation()
    done = true
    onViolation(problem, true)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('hashchange', schedule)
  for (const name of STYLE_EVENTS) document.addEventListener(name, schedule, true)
  document.addEventListener('click', refuse, true)
  document.addEventListener('submit', refuse, true)
  schedule()
  return () => {
    done = true
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    window.removeEventListener('hashchange', schedule)
    for (const name of STYLE_EVENTS) document.removeEventListener(name, schedule, true)
    document.removeEventListener('click', refuse, true)
    document.removeEventListener('submit', refuse, true)
    window.clearTimeout(timer)
    cancelAnimationFrame(frame)
  }
}

/**
 * Keeps `watchProtectedSurfaces` running for as long as the page wears a custom theme, from the first moment: the boot
 * script paints the last visit's theme before React has the theme list or the theme itself, and those decisions are
 * the theme's to damage just the same (1.8.1 verification, L1). Follows `html[data-look='custom']`: the watch starts when
 * it is set (again), stops when it goes, and starts afresh when a theme is worn again after a violation (a watch is one-shot).
 */
export function watchWhileCustom(
  onViolation: (what: string, refused?: boolean) => void,
  options: WatchOptions = {},
): () => void {
  const root = document.documentElement
  let stop: (() => void) | undefined
  let violated = false
  const sync = () => {
    const custom = root.getAttribute('data-look') === 'custom'
    if (!custom) {
      stop?.()
      stop = undefined
      violated = false
      return
    }
    // Every write of the attribute is a theme (re)applied: a fresh watch also checks the new look at once.
    stop?.()
    stop = undefined
    if (violated) return
    stop = watchProtectedSurfaces((what, refused) => {
      violated = true
      onViolation(what, refused)
    }, options)
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { attributes: true, attributeFilter: ['data-look'] })
  sync()
  return () => {
    observer.disconnect()
    stop?.()
  }
}
