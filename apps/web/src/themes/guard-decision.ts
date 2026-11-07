import { chain, paintedBy, visibleBox, visiblePoint } from './guard-geometry.ts'
import { violationIn, withoutTheme } from './guard-violation.ts'

// The way back must always work, so an action on one of these is never refused: if its surroundings are damaged the
// periodic guard drops the theme, and the action goes ahead.
const WAY_BACK =
  '.look-reset, .look-banner, .command-run, .command-palette, .command-trigger, .menu-trigger, .main-nav-link, .nav-drawer-link, .needs-you-dot, .chat-toast'

/** What stands between the person and this control right now: not shown, hidden up the chain, or something on top of it. */
function controlProblem(control: HTMLElement): string | null {
  if (control.getClientRects().length === 0) return 'isn’t shown'
  for (const node of chain(control)) {
    const style = getComputedStyle(node)
    if (style.visibility !== 'visible') return 'is hidden'
  }
  const { view, fraction } = visibleBox(control)
  if (fraction < 0.5) return 'is clipped'
  const point = visiblePoint(view)
  if (point && !paintedBy(control, document.elementFromPoint(point.x, point.y))) return 'is covered'
  return null
}

/**
 * The protected surfaces one action answers to. Inside a `data-decision` boundary (a form, a drawer's actions) that is
 * every protected surface of the decision, outermost first: the request text, its warnings, the fields and the button
 * that commits are separate surfaces, and a click on one is a click on the whole decision (re-gate finding #6).
 * Elsewhere it is the control's nearest protected surface.
 */
function decisionSurfaces(control: HTMLElement): {
  surfaces: HTMLElement[]
  whole: HTMLElement | null
} {
  const decision = control.closest<HTMLElement>('[data-decision]')
  if (!decision) {
    const surface = control.closest<HTMLElement>('[data-protected]')
    return { surfaces: surface ? [surface] : [], whole: null }
  }
  const marked = [
    decision,
    ...Array.from(decision.querySelectorAll<HTMLElement>('[data-protected]')),
  ].filter((el) => el.hasAttribute('data-protected'))
  // A surface inside another is measured with it (parts() walks every descendant).
  const outer = marked.filter((el) => !marked.some((other) => other !== el && other.contains(el)))
  // A decision inside a protected surface (a dialog) is measured as part of it.
  const around = decision.parentElement?.closest<HTMLElement>('[data-protected]')
  // A decision is judged whole: the surfaces above and every field and label between them (finding 1).
  return around ? { surfaces: [around], whole: null } : { surfaces: outer, whole: decision }
}

/**
 * Checked at the moment a person acts on a control inside a protected surface or a decision (an approval, an answer, a
 * permission, a password, an "Add agent"), when a theme is on: every surface of the decision is measured with and
 * without the theme, and the control itself must be shown, visible, not clipped and the thing painted where it is (not
 * an ancestor or a stranger). What Score's own look already did (the same problem with the theme gone) is not the
 * theme's. Whatever a theme does later or on hover
 * can't leave a decision hidden when it's made (gate finding #6). Returns what is wrong, or null.
 */
export function decisionProblem(control: HTMLElement): string | null {
  if (document.documentElement.getAttribute('data-look') !== 'custom') return null
  const { surfaces, whole } = decisionSurfaces(control)
  if ((surfaces.length === 0 && !whole) || control.closest(WAY_BACK)) return null
  let problem = violationIn(surfaces, whole)
  if (!problem) {
    const own = controlProblem(control)
    if (own && withoutTheme(() => controlProblem(control)) === null) problem = own
  }
  if (!problem) return null
  const name =
    surfaces[0]?.getAttribute('aria-label') ?? control.getAttribute('aria-label') ?? 'A decision'
  return problem.startsWith(name) ? problem : `${name} ${problem}`
}
